import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseConfig } from '../src/config.ts';
import { similar } from '../src/curate.ts';
import type { Llm, MessagesRequest } from '../src/llm.ts';
import { matchApp, prefilter } from '../src/prefilter.ts';
import { mergeDay } from '../src/radar.ts';
import { readAppStore } from '../src/stores.ts';
import { addCompares } from '../src/compare.ts';
import { fetchPageMeta, parseImages, type PageMeta } from '../src/pagemeta.ts';
import { collect, defaultPaths, SourcesDownError } from '../src/run.ts';
import type { Radar, Seen } from '../src/types.ts';

const CFG = parseConfig(`
reader: ""
timezone: Asia/Shanghai
window_hours: 48
models:
  curate: claude-sonnet-5-5
  search: claude-haiku-5-5
  searches_per_group: 2
prices:
  claude-sonnet-5-5: { input: 3, output: 15 }
  claude-haiku-5-5: { input: 1, output: 5 }
  web_search_per_1000: 10
groups:
  ota:
    label: OTAs
    search: [Airbnb new feature]
    apps:
      - name: Airbnb
        aliases: [Airbnb]
        domains: [airbnb.com]
        appstore_id: 401626263
      - name: Expedia
        aliases: [Expedia]
        domains: [expediagroup.com]
        appstore_id: 427916203
  platform:
    label: Platforms
    apps:
      - name: Apple
        aliases: [Apple, iOS, Liquid Glass]
        domains: [apple.com]
        icon_domain: apple.com
  consumer:
    label: Consumer
    apps:
      - name: Threads
        aliases: [Threads]
        domains: [threads.com]
feeds:
  - name: Airbnb Newsroom
    url: https://news.airbnb.com/feed/
    kind: company
    app: Airbnb
  - name: 9to5Mac
    url: https://9to5mac.com/feed/
    kind: outlet
trust:
  outlets: [9to5mac.com, theverge.com, skift.com]
  blocked_domains: [medium.com]
  drop_words: [funding, deals, "% off"]
`);

const NOW = new Date('2026-10-28T23:00:00Z'); // 07:00 on 29 Oct in Shanghai
const h = (hours: number, from = NOW) => new Date(from.getTime() - hours * 3_600_000).toUTCString();

const rss = (items: [title: string, url: string, date: string][]) =>
  `<rss version="2.0"><channel>${items.map(([t, u, d]) => `<item><title>${t}</title><link>${u}</link><pubDate>${d}</pubDate><description>${t}.</description></item>`).join('')}</channel></rss>`;

interface World {
  feeds: Record<string, string>;
  pages: Record<string, string>;
  down?: boolean;
}

function fakeFetch(world: World): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (world.down) throw new Error('network down');
    if (url.startsWith('https://itunes.apple.com/')) return Response.json({ results: [{ trackName: 'App', artworkUrl512: 'https://is1.mzstatic.com/image/a/512x512bb.jpg' }] });
    const body = world.feeds[url] ?? world.pages[url.replace(/\/$/, '')];
    if (body) return new Response(body);
    // Article pictures load, unless the world says they don't.
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(String(input))) return new Response(new Uint8Array(6000), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

const EVENTS: [RegExp, string, number][] = [
  [/Services tab/i, 'airbnb-services-tab', 5],
  [/Liquid Glass/i, 'apple-ios-liquid-glass-slider', 4],
];

/** Stands in for Claude. Search returns fixed results; curate keeps candidates that match EVENTS. */
class FakeLlm implements Llm {
  readonly mode = 'api' as const;
  readonly canSearch = true;
  calls: MessagesRequest[] = [];
  searchItems: unknown[] = [];

  async messages(req: MessagesRequest) {
    this.calls.push(req);
    const usage = { input_tokens: 1000, output_tokens: 200, web_searches: req.tools ? 2 : 0 };
    if (req.tools) {
      const blocks = [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://www.theverge.com/old-airbnb', page_age: '2 hours ago' }] },
        { type: 'text', text: JSON.stringify({ items: this.searchItems }) },
      ];
      return { content: blocks, stopReason: 'end_turn', usage };
    }
    const input = JSON.parse(req.messages[0].content as string) as { candidates: { cid: string; app: string; title: string }[] };
    const items: unknown[] = [];
    const dropped: unknown[] = [];
    for (const [re, id, importance] of EVENTS) {
      const hits = input.candidates.filter((c) => re.test(c.title));
      if (hits.length) {
        items.push({
          event_id: id,
          app: hits[0].app,
          beta: /beta/i.test(hits[0].title),
          importance,
          headline: `${hits[0].app} ${hits[0].title.replace(/^\S+\s/, '')}!`,
          what: 'A new tab sits next to Stays and Experiences. 🚀 It lists bookable services.',
          why: 'Search results now mix three product types, so filters and the tab bar need to scale.',
          source_cids: hits.map((c) => c.cid),
        });
      }
    }
    for (const c of input.candidates) if (!EVENTS.some(([re]) => re.test(c.title))) dropped.push({ cid: c.cid, reason: 'no UI change' });
    return { content: [{ type: 'text', text: JSON.stringify({ items, dropped, pattern: null }) }], stopReason: 'end_turn', usage };
  }
}

function day1World(): World {
  return {
    feeds: {
      'https://news.airbnb.com/feed/': rss([
        ['Airbnb introduces a Services tab', 'https://news.airbnb.com/services-tab/', h(2)],
        ['Airbnb celebrates hosts in Lisbon', 'https://news.airbnb.com/lisbon/', h(5)],
        ['Airbnb Summer Release recap', 'https://news.airbnb.com/summer/', h(24 * 5)],
      ]),
      'https://9to5mac.com/feed/': rss([
        ['Airbnb adds Services tab to its iPhone app', 'https://9to5mac.com/airbnb-services/', h(3)],
        ['iOS 26.2 beta adds a Liquid Glass slider', 'https://9to5mac.com/ios-26-2-glass/', h(4)],
        ['Expedia closes funding round', 'https://9to5mac.com/expedia-funding/', h(6)],
        ['Best Apple Watch deals this week', 'https://9to5mac.com/deals/', h(1)],
        ['Samsung unveils a new foldable', 'https://9to5mac.com/samsung/', h(2)],
        ['Gmail email threads get a new look', 'https://9to5mac.com/gmail/', h(2)],
      ]),
    },
    pages: {
      'https://news.airbnb.com/services-tab': '<meta property="og:image" content="https://news.airbnb.com/hero.jpg">',
      'https://9to5mac.com/ios-26-2-glass': '<meta property="og:image" content="https://9to5mac.com/glass.jpg"><meta property="article:published_time" content="2026-10-28T19:00:00Z">',
      // Search says "2 hours ago", the page says July: the page wins.
      'https://theverge.com/old-airbnb': '<meta property="article:published_time" content="2026-07-01T10:00:00Z">',
    },
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-'));
  const paths = { ...defaultPaths(dir), cache: join(dir, '.cache') };
  const llm = new FakeLlm();
  llm.searchItems = [
    { url: 'https://medium.com/@someone/airbnb-redesign', title: 'I redesigned Airbnb', publisher: 'Medium', app: 'Airbnb' },
    { url: 'https://travel-seo-blog.example/airbnb', title: 'Airbnb Services: 10 things', publisher: 'Blog', app: 'Airbnb' },
    { url: 'https://www.theverge.com/old-airbnb', title: 'Airbnb tests a new map', publisher: 'The Verge', app: 'Airbnb' },
  ];
  const read = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
  return { dir, paths, llm, read };
}

test('collect: keeps real changes, merges syndicated copies, drops everything else with a reason', async () => {
  const { paths, llm, read } = setup();
  const r = await collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch(day1World()), paths });

  assert.equal(r.date, '2026-10-29');
  assert.deepEqual(r.kept.map((i) => i.id), ['airbnb-services-tab', 'apple-ios-liquid-glass-slider']);
  const [airbnb, apple] = r.kept;
  assert.equal(airbnb.sources.length, 2);
  assert.equal(airbnb.sources[0].publisher, 'Airbnb Newsroom', 'company post first');
  assert.equal(airbnb.image, 'https://news.airbnb.com/hero.jpg');
  assert.match(airbnb.icon ?? '', /mzstatic\.com\/.*128x128bb\.png$/);
  assert.equal(apple.beta, true);
  assert.equal(apple.icon, 'https://www.google.com/s2/favicons?domain=apple.com&sz=64');
  assert.doesNotMatch(airbnb.what, /🚀/, 'emojis are stripped');
  assert.doesNotMatch(airbnb.headline, /!/, 'no exclamation marks');

  const reasons = Object.fromEntries([...r.preDropped, ...r.modelDropped].map((d) => [d.title, d.reason]));
  assert.equal(reasons['Airbnb Summer Release recap'], 'older than 48h');
  assert.equal(reasons['Expedia closes funding round'], 'headline matches drop word "funding"');
  assert.equal(reasons['Best Apple Watch deals this week'], 'headline matches drop word "deals"');
  assert.equal(reasons['Samsung unveils a new foldable'], 'not about a watchlist app or a design change');
  assert.equal(reasons['Gmail email threads get a new look'], 'no UI change', 'a design headline about any app reaches the model');
  assert.equal(reasons['I redesigned Airbnb'], 'blocked source (medium.com)');
  assert.equal(reasons['Airbnb Services: 10 things'], 'not a trusted source (travel-seo-blog.example)');
  assert.equal(reasons['Airbnb tests a new map'], 'older than 48h', 'page date beats the search date');
  assert.equal(reasons['Airbnb celebrates hosts in Lisbon'], 'no UI change');

  const radar = read<Radar>(paths.radar);
  assert.equal(radar.days.length, 1);
  assert.equal(radar.days[0].quiet, false);
  assert.ok(read<Seen>(paths.seen).events['airbnb-services-tab']);
  const runs = read<{ usage: unknown[]; cost_usd: number }[]>(paths.runs);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].usage.length, 2, 'one search call (only ota has queries) + one curate call');
  assert.ok(runs[0].cost_usd > 0);
  assert.equal(llm.calls.filter((c) => !c.tools).length, 1, 'one curate call per run');
});

test('collect twice on the same day: no duplicates, nothing rewritten', async () => {
  const { paths, llm, read } = setup();
  const world = day1World();
  await collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch(world), paths });
  const before = readFileSync(paths.radar, 'utf8');
  const r2 = await collect({ cfg: CFG, now: new Date(NOW.getTime() + 2 * 3_600_000), llm, fetchImpl: fakeFetch(world), paths });
  assert.equal(r2.added.length, 0);
  assert.equal(r2.dayExisted, true);
  const radar = read<Radar>(paths.radar);
  assert.equal(radar.days.length, 1);
  assert.equal(radar.days[0].items.length, 2);
  assert.deepEqual(radar.days[0].items, (JSON.parse(before) as Radar).days[0].items);
});

test('next day: a re-syndicated launch is not reported again, and an empty day is recorded as quiet', async () => {
  const { paths, llm, read } = setup();
  await collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch(day1World()), paths });
  const day1 = read<Radar>(paths.radar).days[0];

  const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
  const world = day1World();
  world.feeds['https://9to5mac.com/feed/'] = rss([
    ['Airbnb Services tab now live in more countries', 'https://9to5mac.com/airbnb-services-more/', h(3, tomorrow)],
    ['Best iPad deals', 'https://9to5mac.com/ipad-deals/', h(1, tomorrow)],
  ]);
  llm.searchItems = [];
  const r = await collect({ cfg: CFG, now: tomorrow, llm, fetchImpl: fakeFetch(world), paths });

  assert.equal(r.date, '2026-10-30');
  assert.equal(r.kept.length, 0);
  assert.match(r.modelDropped.find((d) => /more countries/.test(d.title))!.reason, /^already reported on 2026-10-29/);
  assert.ok(r.preDropped.some((d) => d.reason === 'already reported on an earlier day'), 'yesterday’s URLs are filtered before the model');
  const radar = read<Radar>(paths.radar);
  assert.equal(radar.days.length, 2);
  assert.deepEqual(radar.days[0], { date: '2026-10-30', collected_at: tomorrow.toISOString(), quiet: true, pattern: null, pattern_zh: null, items: [] });
  assert.deepEqual(radar.days[1], day1, 'past day untouched');
});

test('quiet day with nothing new from any source skips the model call', async () => {
  const { paths, llm, read } = setup();
  llm.searchItems = [];
  const world: World = { feeds: { 'https://news.airbnb.com/feed/': rss([]), 'https://9to5mac.com/feed/': rss([['Best iPad deals', 'https://9to5mac.com/d/', h(1)]]) }, pages: {} };
  const r = await collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch(world), paths });
  assert.equal(r.quiet, true);
  assert.equal(llm.calls.filter((c) => !c.tools).length, 0);
  assert.equal(read<Radar>(paths.radar).days[0].quiet, true);
});

test('when every source fails, nothing is written (not a fake quiet day)', async () => {
  const { paths, llm } = setup();
  const failing: Llm = { mode: 'api', canSearch: true, messages: async () => Promise.reject(new Error('API down')) };
  await assert.rejects(collect({ cfg: CFG, now: NOW, llm: failing, fetchImpl: fakeFetch({ feeds: {}, pages: {}, down: true }), paths }), SourcesDownError);
  assert.equal(existsSync(paths.radar), false);
  void llm;
});

test('dry run calls no model and writes nothing', async () => {
  const { paths } = setup();
  const r = await collect({ cfg: CFG, now: NOW, llm: null, fetchImpl: fakeFetch(day1World()), paths, dryRun: true });
  assert.ok(r.sentToModel.length >= 3);
  assert.equal(existsSync(paths.radar), false);
});

test('manual mode: saves the question, then finishes offline from the saved sources', async () => {
  const { paths, read } = setup();
  const { manualLlm, AnswerPendingError } = await import('../src/llm.ts');
  const llm = manualLlm(join(paths.cache, 'llm'));
  await assert.rejects(collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch(day1World()), paths }), AnswerPendingError);
  const [req] = (await import('node:fs')).readdirSync(join(paths.cache, 'llm', 'requests'));
  const q = read<{ answer_to: string; user: string }>(join(paths.cache, 'llm', 'requests', req));
  const answer = await new FakeLlm().messages({ model: 'x', system: '', maxTokens: 1, messages: [{ role: 'user', content: q.user }] });
  (await import('node:fs')).writeFileSync(q.answer_to, answer.content[0].text!);

  // Second run with the network gone: everything comes from the snapshot.
  const r = await collect({ cfg: CFG, now: NOW, llm, fetchImpl: fakeFetch({ feeds: {}, pages: {}, down: true }), paths });
  assert.deepEqual(r.kept.map((i) => i.id), ['airbnb-services-tab', 'apple-ios-liquid-glass-slider']);
  assert.equal(r.kept[1].image, 'https://9to5mac.com/glass.jpg', 'og:image read during the online run');
  assert.equal(r.search.ran, false);
  assert.equal(read<Radar>(paths.radar).days[0].items.length, 2);
});

test('mergeDay refuses to write a day older than the newest one', () => {
  const radar: Radar = { version: 1, updated_at: '', days: [{ date: '2026-10-29', collected_at: '', quiet: true, pattern: null, items: [] }] };
  assert.throws(() => mergeDay(radar, { date: '2026-10-28', items: [], pattern: null, now: NOW }), /never rewritten/);
});

test('matchApp uses whole words and the earliest alias', () => {
  assert.equal(matchApp(CFG, 'Threads adds a new feed for Apple fans')?.name, 'Threads');
  assert.equal(matchApp(CFG, 'Pineapple prices')?.name, undefined);
  assert.equal(matchApp(CFG, 'iOS 26: what is new')?.name, 'Apple');
});

test('prefilter numbers candidates and puts company posts first', () => {
  const c = (title: string, trust: 'company' | 'outlet', hours: number) => ({
    cid: '', title, url: `https://x.com/${title}`, source: 's', domain: 'x.com', publishedAt: new Date(NOW.getTime() - hours * 3_600_000).toISOString(),
    summary: '', image: null, via: 'feed' as const, trust, app: 'Airbnb',
  });
  const { kept } = prefilter(CFG, [c('a', 'outlet', 1), c('b', 'company', 10)], { now: NOW, seenUrls: new Set() });
  assert.deepEqual(kept.map((k) => [k.cid, k.title]), [['c1', 'b'], ['c2', 'a']]);
});

test('a blocked domain is allowed for its own feed only (Airbnb Design on medium.com)', () => {
  const c = (title: string, feedDomain: string) => ({
    cid: '', title, url: `https://medium.com/p/${title}`, source: 's', domain: 'medium.com', feedDomain,
    publishedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), summary: '', image: null, via: 'feed' as const, trust: 'company' as const, app: 'Airbnb',
  });
  const { kept, dropped } = prefilter(CFG, [c('own', 'medium.com'), c('linked', 'sidebar.io')], { now: NOW, seenUrls: new Set() });
  assert.deepEqual(kept.map((k) => k.title), ['own']);
  assert.deepEqual(dropped.map((d) => [d.title, d.reason]), [['linked', 'blocked source (medium.com)']]);
});

test('similar() catches the same headline written twice', () => {
  assert.ok(similar('Airbnb adds a Services tab to the app', 'Airbnb adds Services tab to the app') >= 0.8);
  assert.ok(similar('iOS 26.1 beta 1 adds a slider', 'Airbnb adds Services tab') < 0.3);
});

test('company gateway: bearer login, Messages API, credits recorded, expired login explained', async () => {
  const { companyLlm, LlmUnavailableError } = await import('../src/llm.ts');
  const seen: { url: string; auth: string | null; body: { model: string } }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    return Response.json({ content: [{ type: 'text', text: '{"items":[]}' }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 10, credit_usage: 0.0119 } });
  }) as unknown as typeof fetch;
  const llm = companyLlm({ baseUrl: 'http://gateway.example/coding-plan', token: 'T0KEN' }, ok);
  assert.equal(llm.canSearch, false);
  const r = await llm.messages({ model: 'kr-claude-opus-5.5', system: 's', maxTokens: 10, messages: [{ role: 'user', content: 'u' }] });
  assert.equal(seen[0].url, 'http://gateway.example/coding-plan/v1/messages');
  assert.equal(seen[0].auth, 'Bearer T0KEN');
  assert.equal(seen[0].body.model, 'kr-claude-opus-5.5');
  assert.equal(r.usage.credits, 0.0119);

  const expired = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(companyLlm({ baseUrl: 'http://g', token: 'x' }, expired).messages({ model: 'm', system: '', maxTokens: 1, messages: [] }), (e: Error) => e instanceof LlmUnavailableError && /ada refresh/.test(e.message));
});

test('provider: company switches the curate model and turns search off; RADAR_PROVIDER overrides', () => {
  const yaml = 'provider: company\ncompany:\n  curate: kr-claude-opus-5.5\nmodels:\n  curate: claude-sonnet-5-5\ngroups:\n  ota:\n    apps:\n      - name: A\n';
  assert.equal(parseConfig(yaml).models.curate, 'kr-claude-opus-5.5');
  const api = parseConfig(yaml, { RADAR_PROVIDER: 'anthropic' });
  assert.equal(api.provider, 'anthropic');
  assert.equal(api.models.curate, 'claude-sonnet-5-5');
  assert.equal(parseConfig(yaml, { RADAR_PROVIDER: 'gemini' }).models.curate, 'gemini-3.8-flash');
  assert.throws(() => parseConfig(yaml, { RADAR_PROVIDER: 'openai' }), /company, gemini or anthropic/);
});

test('--from-cache reuses saved sources with any model, and says so when there are none', async () => {
  const { paths } = setup();
  await assert.rejects(collect({ cfg: CFG, now: NOW, llm: new FakeLlm(), paths, fromCache: true }), /Run with --gather-only first/);
  await collect({ cfg: CFG, now: NOW, llm: null, fetchImpl: fakeFetch(day1World()), paths, gatherOnly: true });
  const r = await collect({ cfg: CFG, now: NOW, llm: new FakeLlm(), fetchImpl: fakeFetch({ feeds: {}, pages: {}, down: true }), paths, fromCache: true });
  assert.equal(r.mode, 'api, saved sources');
  assert.deepEqual(r.kept.map((i) => i.id), ['airbnb-services-tab', 'apple-ios-liquid-glass-slider']);
});

test('gemini: request shape, JSON answer, thinking parts skipped, location block explained', async () => {
  const { geminiLlm, LlmUnavailableError } = await import('../src/llm.ts');
  const seen: { url: string; key: string | null; body: Record<string, any> }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get('x-goog-api-key'), body: JSON.parse(String(init.body)) });
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"items":[]}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20, thoughtsTokenCount: 300 },
    });
  }) as unknown as typeof fetch;
  const r = await geminiLlm('K3Y', ok).messages({ model: 'gemini-3.8-flash', system: 'sys', maxTokens: 8000, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(seen[0].key, 'K3Y');
  assert.equal(seen[0].body.systemInstruction.parts[0].text, 'sys');
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.content[0].text, '{"items":[]}');
  assert.deepEqual(r.usage, { input_tokens: 900, output_tokens: 320, web_searches: 0 });

  const blocked = (async () => Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(geminiLlm('k', blocked).messages({ model: 'm', system: '', maxTokens: 1, messages: [] }), (e: Error) => e instanceof LlmUnavailableError && /Run it on GitHub/.test(e.message));
});

test('curate input lists each app with the names that count as it', async () => {
  const { buildCurateInput } = await import('../src/curate.ts');
  const input = buildCurateInput(CFG, [], [], NOW) as { watchlist: Record<string, Record<string, string[]>> };
  assert.deepEqual(input.watchlist.ota.Expedia, ['Expedia']);
  assert.deepEqual(input.watchlist.platform.Apple, ['Apple', 'iOS', 'Liquid Glass']);
});

test('design focus: a design publication item reaches the model, and a non-watchlist brand keeps its own name, kind, icon and Chinese text', async () => {
  const { curate } = await import('../src/curate.ts');
  const cfg = parseConfig(`
groups:
  consumer:
    label: Consumer
    apps:
      - name: Threads
        aliases: [Threads]
        domains: [threads.com]
feeds:
  - name: It's Nice That
    url: https://www.itsnicethat.com/articles.rss
    kind: design
trust:
  outlets: [itsnicethat.com]
`);
  const fresh = new Date(NOW.getTime() - 3_600_000).toISOString();
  const { kept } = prefilter(cfg, [
    { cid: '', title: 'Pentagram gives Mastercard a new wordmark', url: 'https://itsnicethat.com/a', source: "It's Nice That", domain: 'itsnicethat.com', publishedAt: fresh, summary: '', image: null, via: 'feed', trust: 'outlet', app: null, design: true },
    { cid: '', title: 'YouTube redesigns its tab bar', url: 'https://9to5google.com/b', source: '9to5Google', domain: '9to5google.com', publishedAt: fresh, summary: '', image: null, via: 'feed', trust: 'outlet', app: null },
    { cid: '', title: 'Samsung posts record profit', url: 'https://9to5google.com/c', source: '9to5Google', domain: '9to5google.com', publishedAt: fresh, summary: '', image: null, via: 'feed', trust: 'outlet', app: null },
  ], { now: NOW, seenUrls: new Set() });
  assert.deepEqual(kept.map((c) => c.title), ['Pentagram gives Mastercard a new wordmark', 'YouTube redesigns its tab bar']);

  const answer = {
    items: [{
      event_id: 'youtube-tab-bar', app: 'YouTube', category: 'consumer', domain: 'www.youtube.com', kind: 'ui', importance: 3,
      headline: 'YouTube redesigns its tab bar!', what: 'Subscriptions moves out of the bottom bar.', why: 'Tab bars are scarce.',
      zh: { headline: 'YouTube 重新设计底部标签栏！', what: '订阅移出底部栏。', why: '标签栏位置有限。' }, source_cids: ['c2'],
    }],
    dropped: [{ cid: 'c1', reason: 'small client work' }],
    pattern: null,
  };
  const llm: Llm = { mode: 'api', canSearch: false, messages: async () => ({ content: [{ type: 'text', text: JSON.stringify(answer) }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, web_searches: 0 } }) };
  const r = await curate(cfg, llm, kept, { now: NOW, recent: [], seen: { events: {} }, icons: {} });
  const [item] = r.items;
  assert.equal(item.app, 'YouTube');
  assert.equal(item.kind, 'ui');
  assert.equal(item.icon, 'https://www.google.com/s2/favicons?domain=youtube.com&sz=64');
  assert.deepEqual(item.zh, { headline: 'YouTube 重新设计底部标签栏。', what: '订阅移出底部栏。', why: '标签栏位置有限。' });
  assert.equal(r.dropped[0].reason, 'small client work');
});

test('store version notes: only new versions inside the window whose notes mention design go to the model', async () => {
  const { checkStores, notesMentionDesign, parsePlayPage } = await import('../src/stores.ts');
  assert.equal(notesMentionDesign('Bug fixes and performance improvements.'), false);
  assert.equal(notesMentionDesign('We update the app regularly to make the experience better. Thanks for using WhatsApp.'), false);
  assert.equal(notesMentionDesign('Now you can book homes, experiences, and services, all in one app. Our redesigned app includes a new Services tab.'), true);
  assert.equal(notesMentionDesign('Bug fixes and UI improvements.'), true, 'a vague mention still reaches the model, which drops it');

  const play = parsePlayPage('<div>What’s new</div><div itemprop="description">Fresh new look for the home screen.<br>Bug fixes.</div><div>Updated on</div><div class="x">Oct 30, 2026</div>');
  assert.equal(play?.notes, 'Fresh new look for the home screen. Bug fixes.');
  assert.equal(play?.date, '2026-10-30T00:00:00.000Z');

  const cfg = parseConfig(`
window_hours: 48
groups:
  ota:
    apps:
      - name: Airbnb
        domains: [airbnb.com]
        appstore_id: 401626263
      - name: Expedia
        domains: [expedia.com]
        appstore_id: 427916203
stores:
  google_play: false
`);
  const fresh = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
  const fetchImpl = (async () =>
    Response.json({
      results: [
        { trackId: 401626263, version: '26.44', currentVersionReleaseDate: fresh, releaseNotes: 'Our redesigned app has a new Services tab.', screenshotUrls: ['https://is1.mzstatic.com/new.jpg'] },
        { trackId: 427916203, version: '2026.43', currentVersionReleaseDate: fresh, releaseNotes: 'Bug fixes and performance improvements.', screenshotUrls: ['https://is1.mzstatic.com/e.jpg'] },
      ],
    })) as unknown as typeof fetch;
  const state = { appStore: { Airbnb: { version: '26.40', date: null, notes: '', screenshot: 'https://is1.mzstatic.com/old.jpg' } }, googlePlay: {} };
  const r = await checkStores(cfg, state, NOW, fetchImpl);
  assert.equal(r.candidates.length, 1);
  const [c] = r.candidates;
  assert.equal(c.app, 'Airbnb');
  assert.equal(c.url, 'https://apps.apple.com/us/app/id401626263?version=26.44');
  assert.deepEqual(c.release, { store: 'app-store', version: '26.44', screenshot: 'https://is1.mzstatic.com/new.jpg', previousScreenshot: 'https://is1.mzstatic.com/old.jpg', previousVersion: '26.40' });
  assert.deepEqual(r.skipped, [{ app: 'Expedia', store: 'app-store', version: '2026.43', reason: 'notes mention no design change' }]);
  assert.equal(r.latest.appStore.Airbnb.version, '26.44', 'remembered for next time');

  const again = await checkStores(cfg, r.latest, NOW, fetchImpl);
  assert.equal(again.candidates.length, 0, 'the same version is never passed on twice');
});

test('pictures: the model looks at the article pictures and picks the one that shows the change; captions are the fallback', async () => {
  const { pairFromWords, addCompares, candidatePictures } = await import('../src/compare.ts');
  const img = (src: string, alt = '', caption = '') => ({ src, alt, caption });
  assert.deepEqual(pairFromWords([img('https://x/hero.jpg', 'Team photo'), img('https://x/a.png', 'The previous Mastercard logo'), img('https://x/b.png', '', 'The new wordmark')]), { before: 'https://x/a.png', after: 'https://x/b.png', from: 'article' });
  assert.deepEqual(pairFromWords([img('https://x/c.png', '', 'Before and after: the app icon')]), { before: null, after: 'https://x/c.png', combined: true, from: 'article' });
  assert.equal(pairFromWords([img('https://x/1.jpg', 'Duolingo office'), img('https://x/2.jpg', '')]), null);

  // The same picture through a CDN and directly counts once; thumbnails of other articles are left out.
  const cands = candidatePictures(
    [[img('https://i0.wp.com/site.com/up/x.webp?w=1500'), img('https://site.com/up/x-icons.webp'), img('https://site.com/up/other.jpg?w=140')], [img('https://site.com/up/x.webp?resize=1200,628'), img('https://site.com/up/cmp.jpg')]],
    'https://site.com/up/og.jpg',
  );
  assert.deepEqual(cands.map((c) => c.src), ['https://i0.wp.com/site.com/up/x.webp?w=1500', 'https://site.com/up/x-icons.webp', 'https://site.com/up/cmp.jpg', 'https://site.com/up/og.jpg']);
  // Pictures uploaded long before the story come from other articles linked on the page.
  const dated = candidatePictures([[img('https://site.com/wp/2026/11/new-icons.jpg'), img('https://site.com/wp/2022/10/old-article.jpg'), img('https://site.com/wp/2026/10/last-month.jpg')]], null, '2026-11-02T10:00:00Z');
  assert.deepEqual(dated.map((c) => c.src), ['https://site.com/wp/2026/11/new-icons.jpg', 'https://site.com/wp/2026/10/last-month.jpg']);

  const base = { app: 'X', category: 'consumer' as const, date: '', published_at: '', beta: false, importance: 2, what: 'w', why: 'y', sources: [{ title: 't', url: 'https://x/post', publisher: 'p' }], image: 'https://x/og.jpg', icon: null, collected_at: '' };
  const items = [
    { ...base, id: 'x-icons', kind: 'brand' as const, headline: 'X adds a dozen new app icons' },
    { ...base, id: 'c-logo', kind: 'brand' as const, headline: 'C shows its old and new logo' },
    { ...base, id: 'ux-b', kind: 'ux' as const, headline: 'B changes checkout' },
    { ...base, id: 'offline', kind: 'brand' as const, headline: 'D gets a new wordmark', image: 'https://x/gone-og.jpg' },
    { ...base, id: 'kept-pair', kind: 'ui' as const, headline: 'E redesigns its home screen', compare: { before: 'https://x/e-old.jpg', after: 'https://x/e-new.jpg', from: 'article' as const } },
    { ...base, id: 'airbnb-v', kind: 'ui' as const, headline: 'Airbnb redesign', release: { store: 'app-store' as const, version: '26.44' } },
  ];
  const pictures: Record<string, ReturnType<typeof img>[][]> = {
    'x-icons': [[img('https://x/logo.jpg'), img('https://x/icon-grid.jpg')]],
    'c-logo': [[img('https://x/cmp.jpg'), img('https://x/team.jpg')]],
    'ux-b': [[img('https://x/office.jpg'), img('https://x/checkout.jpg')]],
    offline: [[img('https://x/gone1.jpg'), img('https://x/fine.jpg', '', 'The new wordmark')]],
    'kept-pair': [[img('https://x/e-old.jpg'), img('https://x/e-new.jpg'), img('https://x/e-team.jpg')]],
  };
  const looked: { headline: string; pictures: number }[] = [];
  const llm: Llm = {
    mode: 'company',
    canSearch: false,
    messages: async (req) => {
      const blocks = req.messages[0].content as { type: string; text?: string }[];
      const headline = (blocks[0].text ?? '').split('\n')[0].replace('Headline: ', '');
      looked.push({ headline, pictures: blocks.filter((b) => b.type === 'image').length });
      const answer = /dozen/.test(headline) ? { best: 1 } : /old and new/.test(headline) ? { best: 0, combined: 0 } : { best: 1, why: 'the new checkout screen' };
      return { content: [{ type: 'text', text: JSON.stringify(answer) }], stopReason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 30, web_searches: 0, credits: 0.01 } };
    },
  };
  const fetchImpl = (async (input: string | URL | Request) =>
    /gone/.test(String(input)) ? new Response('no', { status: 404 }) : new Response(new Uint8Array(6000), { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  const shots = new Map([['airbnb-v', { before: 'https://is1/old.jpg', after: 'https://is1/new.jpg', beforeVersion: '26.40' }]]);
  const r = await addCompares(CFG, items, async (item) => pictures[item.id] ?? [], llm, shots, fetchImpl);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));

  assert.equal(by['x-icons'].image, 'https://x/icon-grid.jpg', 'the grid of new icons, not the bare logo');
  assert.deepEqual(by['c-logo'].compare, { before: null, after: 'https://x/cmp.jpg', combined: true, from: 'article' });
  assert.equal(by['ux-b'].image, 'https://x/checkout.jpg', 'UX stories get a picture too');
  assert.deepEqual(by['kept-pair'].compare, { before: 'https://x/e-old.jpg', after: 'https://x/e-new.jpg', from: 'article' }, 'a before/after chosen earlier is kept, and the model is not asked');
  assert.equal(by.offline.image, 'https://x/fine.jpg', 'a picture that does not load is left out; the one that loads is used');
  assert.deepEqual(by['airbnb-v'].compare, { before: 'https://is1/old.jpg', after: 'https://is1/new.jpg', from: 'app-store', before_version: '26.40' });
  assert.deepEqual(looked.map((l) => l.pictures), [3, 3, 3], 'each story sends its pictures plus its current one; offline, app-store and already-paired stories send nothing');
  assert.equal(r.usage?.step, 'pictures');
  assert.ok(Math.abs((r.usage?.credits ?? 0) - 0.03) < 1e-9, 'one usage line for the whole step');
});

test('the real watchlist: longer names win at the same place, and short everyday names need their app forms', () => {
  const cfg = loadConfig();
  assert.equal(matchApp(cfg, 'Uber Eats adds a new checkout')?.name, 'Uber Eats');
  assert.equal(matchApp(cfg, 'Uber adds teen accounts')?.name, 'Uber');
  assert.equal(matchApp(cfg, 'GrabFood gets a new home screen')?.name, 'Grab');
  assert.equal(matchApp(cfg, 'Grab Your Tickets Now'), null);
  assert.equal(matchApp(cfg, 'Usain Bolt opens a café at noon'), null);
  assert.equal(matchApp(cfg, 'talabat redesigns its app')?.name, 'Delivery Hero');
  assert.equal(matchApp(cfg, 'Zomato launches a new home screen')?.category, 'delivery');
});

test('App Store notes for an app listed in another country are read from that country’s store', async () => {
  const cfg = loadConfig();
  const asked: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ results: [] }));
  }) as typeof fetch;
  await readAppStore(cfg.apps, 'us', fake);
  const countries = asked.map((u) => new URL(u).searchParams.get('country')).sort();
  assert.ok(countries.includes('in') && countries.includes('cn') && countries.includes('us'));
  assert.equal(new Set(countries).size, countries.length, 'one lookup per country');
  const india = asked.find((u) => u.includes('country=in'))!;
  assert.ok(india.includes('434613896'), 'Zomato is looked up in India');
  assert.ok(!asked.find((u) => u.includes('country=us'))!.includes('434613896'));
});

test('pictures: the article’s only picture is used, and a site’s stock share card never beats it (Apple, 5 Nov)', async () => {
  const base = { app: 'Apple', category: 'platform' as const, kind: 'ux' as const, date: '', published_at: '', beta: false, importance: 3, what: 'w', why: 'y', sources: [{ title: 't', url: 'https://developer.apple.com/news?id=fk9ps3gv', publisher: 'Apple Developer News' }], icon: null, collected_at: '' };
  const shot = { src: 'https://devimages-cdn.apple.com/wwdc-services/articles/images/A6247A25/2048.jpeg', alt: 'Two iPhones showing a subscription cancellation screen', caption: '' };
  const stock = 'https://developer.apple.com/news/images/og/app-store-connect-og.png';
  const items = [
    { ...base, id: 'with-stock', headline: 'Apple adds retention messages', image: stock },
    { ...base, id: 'no-image', headline: 'Apple adds retention messages', image: null },
    { ...base, id: 'only-stock', headline: 'Apple posts a beta', image: stock },
    // Android Authority blocks page readers, and its feed photo is a reused one from an August article.
    { ...base, id: 'old-feed-photo', headline: 'YouTube moves Subscriptions', published_at: '2026-11-04T15:03:00Z', image: 'https://www.androidauthority.com/wp-content/uploads/2026/08/screen-after-cancelling-youtube-premium-lite-scaled.jpg' },
    { ...base, id: 'new-feed-photo', headline: 'YouTube moves Subscriptions', published_at: '2026-11-04T15:03:00Z', image: 'https://www.androidauthority.com/wp-content/uploads/2026/11/youtube-new-tab-bar.jpg' },
  ];
  const pictures: Record<string, (typeof shot)[][]> = { 'with-stock': [[shot]], 'no-image': [[shot]], 'only-stock': [[]], 'old-feed-photo': [[]], 'new-feed-photo': [[]] };
  let asked = 0;
  const llm: Llm = { mode: 'company', canSearch: false, messages: async () => (asked++, { content: [{ type: 'text', text: '{}' }], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 } }) };
  const r = await addCompares(CFG, items, async (i) => pictures[i.id], llm, new Map());
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by['with-stock'].image, shot.src, 'the screenshot, not the stock card');
  assert.equal(by['no-image'].image, shot.src, 'one picture is enough');
  assert.equal(by['only-stock'].image, null, 'a stock card alone shows the app icon instead');
  assert.equal(by['old-feed-photo'].image, null, 'a photo uploaded months before the story is not the change');
  assert.equal(by['new-feed-photo'].image, 'https://www.androidauthority.com/wp-content/uploads/2026/11/youtube-new-tab-bar.jpg', 'a fresh feed photo stays');
  assert.equal(asked, 0, 'one picture needs no model');
});

test('page reads: a page that does not load is tried once more; one that answers with an error is not', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response('<html><head><meta property="og:image" content="https://x/a.jpg"></head></html>');
  }) as typeof fetch;
  assert.equal((await fetchPageMeta('https://x/post', flaky, 0))?.image, 'https://x/a.jpg');
  assert.equal(calls, 2);
  calls = 0;
  const blocked = (async () => (calls++, new Response('no', { status: 403 }))) as typeof fetch;
  assert.equal(await fetchPageMeta('https://x/post', blocked, 0), null);
  assert.equal(calls, 1);
});

test('other coverage: the same change on other sites is found, and a different story about the same app is not', async () => {
  const { relatedCoverage } = await import('../src/related.ts');
  const at = '2026-11-04T15:03:00Z';
  const item = { app: 'YouTube', headline: "YouTube's latest redesign moves Subscriptions out of the bottom tab bar.", published_at: at, sources: [{ title: 'Where’s my Subscriptions tab? Users are furious about YouTube’s latest redesign', url: 'https://androidauthority.com/a', publisher: 'Android Authority' }] };
  const p = (title: string, source: string, app: string | null = 'YouTube', hours = 3) => ({ title, url: `https://${source.replace(/\W/g, '')}.com/${encodeURIComponent(title)}`, source, app, publishedAt: new Date(Date.parse(at) + hours * 3_600_000).toISOString() });
  const pool = [
    p('YouTube moves the Subscriptions tab in its new app redesign', 'Android Police'),
    p('YouTube’s redesign hides Subscriptions, and people are not happy', '9to5Google', null),
    p('YouTube Music’s playback controls could soon feel more lively', 'Android Authority'),
    p('Watch too much YouTube? Google could be working on a new tool to help', 'Android Authority'),
    p('YouTube moves the Subscriptions tab in its new app redesign', 'Android Police', 'YouTube', 2),
    p('YouTube redesign Subscriptions tab, two weeks later', 'XDA', 'YouTube', 24 * 14),
    p('Netflix redesigns its home screen tab bar', 'The Verge', 'Netflix'),
  ];
  const found = relatedCoverage(item, pool);
  assert.deepEqual(found.map((f) => f.source), ['Android Police', '9to5Google'], 'one per site; other YouTube stories, other apps and old posts are left out');
});

test('other coverage: when the kept site is blocked, the picture comes from another site, which is then credited', async () => {
  const { withRelatedPictures } = await import('../src/related.ts');
  const at = '2026-11-04T15:03:00Z';
  const item = { id: 'yt', app: 'YouTube', category: 'consumer' as const, kind: 'ui' as const, date: '', published_at: at, beta: false, importance: 4, headline: 'YouTube moves Subscriptions out of the tab bar', what: 'w', why: 'y', sources: [{ title: 'Users are furious about YouTube’s latest redesign of the Subscriptions tab', url: 'https://androidauthority.com/a', publisher: 'Android Authority' }], image: 'https://www.androidauthority.com/wp-content/uploads/2026/08/old.jpg', icon: null, collected_at: '' };
  const pool = [{ title: 'YouTube redesign moves the Subscriptions tab', url: 'https://androidpolice.com/yt', source: 'Android Police', app: 'YouTube', publishedAt: at }];
  const shot = 'https://static1.androidpolicecdn.com/2026/11/youtube-new-tab-bar.jpg';
  const metas: Record<string, PageMeta | null> = { 'https://androidauthority.com/a': null, 'https://androidpolice.com/yt': { publishedAt: at, image: shot, siteName: null, title: null, images: [] } };
  const related = withRelatedPictures(pool, async (u) => metas[u] ?? null);
  const picked = await addCompares(CFG, [item], related.imagesFor, null, new Map());
  const [out] = related.credit(picked.items);
  assert.equal(out.image, shot, 'the other site’s screenshot, not the old reused photo');
  assert.deepEqual(out.sources.map((s) => s.publisher), ['Android Authority', 'Android Police'], 'and the site it came from is listed');
});

test('pictures: a full-size src beats a srcset of thumbnails (Android Central, TechRadar)', () => {
  const html = '<article><img src="https://cdn.mos.cms.futurecdn.net/abc.jpg" alt="New tab bar" srcset="https://cdn.mos.cms.futurecdn.net/abc-160-80.jpg 160w, https://cdn.mos.cms.futurecdn.net/abc-80-80.jpg 80w"><img src="https://x.com/small.jpg" srcset="https://x.com/big-1600.jpg 1600w, https://x.com/s-400.jpg 400w"></article>';
  assert.deepEqual(parseImages(html, 'https://www.androidcentral.com/a').map((i) => i.src), ['https://cdn.mos.cms.futurecdn.net/abc.jpg', 'https://x.com/big-1600.jpg']);
});

test('other coverage: a card with no picture searches news sites for earlier reports of the same change', async () => {
  const { searchCoverage, withRelatedPictures } = await import('../src/related.ts');
  const at = '2026-11-04T15:03:00Z';
  const asked: string[] = [];
  const rss = (items: [string, string, string][]) => `<rss><channel>${items.map(([t, u, d]) => `<item><title>${t}</title><link>${u}</link><pubDate>${new Date(d).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = String(input);
    asked.push(u);
    if (u.startsWith('https://9to5google.com/?s=')) return new Response(rss([
      ['YouTube removing ‘Subscriptions’ bottom bar tab on Android, iOS after nearly a decade', 'https://9to5google.com/2026/10/22/youtube-subscriptions-tab', '2026-10-22T16:00:00Z'],
      ['YouTube Music gets a new widget', 'https://9to5google.com/2026/10/30/yt-music-widget', '2026-10-30T10:00:00Z'],
      ['YouTube Subscriptions tab redesign, back in 2023', 'https://9to5google.com/2023/05/01/old', '2023-05-01T10:00:00Z'],
    ]));
    return new Response('<rss><channel></channel></rss>');
  }) as typeof fetch;
  const item = { id: 'yt', app: 'YouTube', category: 'consumer' as const, kind: 'ui' as const, date: '', published_at: at, beta: false, importance: 4, headline: "YouTube's latest redesign moves Subscriptions out of the bottom tab bar.", what: 'w', why: 'y', sources: [{ title: 'Where’s my Subscriptions tab? Users are furious about YouTube’s latest redesign', url: 'https://androidauthority.com/a', publisher: 'Android Authority' }], image: null, icon: null, collected_at: '' };

  const found = await searchCoverage(item, fetchImpl);
  assert.deepEqual(found.map((f) => f.url), ['https://9to5google.com/2026/10/22/youtube-subscriptions-tab'], 'the first report, 13 days earlier; not another YouTube story or a 2023 one');
  assert.ok(asked.some((u) => u.startsWith('https://9to5google.com/?s=YouTube%20redesign%20subscriptions')), 'searched for the app and the words its headline and source share');

  // In the picture step: the search runs only when nothing else has a usable picture.
  const shot = 'https://9to5google.com/wp-content/uploads/sites/4/2026/10/youtube-tab-bar.jpg';
  const metas: Record<string, PageMeta | null> = { 'https://androidauthority.com/a': null, 'https://9to5google.com/2026/10/22/youtube-subscriptions-tab': { publishedAt: '2026-10-22T16:00:00Z', image: shot, siteName: null, title: null, images: [] } };
  let searched = 0;
  const related = withRelatedPictures([], async (u) => metas[u] ?? null, async (i) => (searched++, searchCoverage(i, fetchImpl)));
  const [out] = related.credit((await addCompares(CFG, [item], related.imagesFor, null, new Map())).items);
  assert.equal(out.image, shot);
  assert.equal(out.sources.at(-1)?.publisher, '9to5Google', 'credited');
  assert.equal(searched, 1);
});

test('before/after from file names: the two pictures must be of the same thing (Google Messages, 5 Nov)', async () => {
  const { pairFromWords } = await import('../src/compare.ts');
  const img = (src: string, alt = '') => ({ src, alt, caption: '' });
  const old = img('https://9to5google.com/wp-content/uploads/sites/4/2026/11/Google-Messages-pinned-old.jpg?w=1280');
  // The new app icon from another story on the same page is not the "after" of the pinned chats.
  assert.equal(pairFromWords([old, img('https://9to5google.com/2026/11/Google-Messages-Phone-Contacts-icon-gradient-redesign.webp')]), null);
  assert.deepEqual(pairFromWords([old, img('https://9to5google.com/2026/11/Google-Messages-pinned-new.jpg')])?.after, 'https://9to5google.com/2026/11/Google-Messages-pinned-new.jpg');
  // Pictures whose captions say old and new pair whatever their file names.
  assert.ok(pairFromWords([img('https://x/a1.png', 'The previous logo'), img('https://x/b2.png', 'The new logo')]));
});

test('other coverage: the other article’s headline is not used as its picture’s caption (YouTube, 5 Nov)', async () => {
  const { withRelatedPictures } = await import('../src/related.ts');
  const at = '2026-11-04T15:03:00Z';
  const base = 'https://9to5google.com/wp-content/uploads/sites/4/2026/10/';
  const item = { id: 'yt', app: 'YouTube', category: 'consumer' as const, kind: 'ui' as const, date: '', published_at: at, beta: false, importance: 4, headline: 'YouTube moves Subscriptions out of the tab bar', what: 'w', why: 'y', sources: [{ title: 'Users are furious about the YouTube Subscriptions tab redesign', url: 'https://androidauthority.com/a', publisher: 'Android Authority' }], image: null, icon: null, collected_at: '' };
  const pool = [{ title: 'YouTube Subscriptions tab moves after the redesign, before and after', url: 'https://9to5google.com/yt', source: '9to5Google', app: 'YouTube', publishedAt: at }];
  const metas: Record<string, PageMeta | null> = {
    'https://androidauthority.com/a': null,
    'https://9to5google.com/yt': { publishedAt: at, image: `${base}YouTube-Subscriptions-move-cover.jpg`, siteName: null, title: null, images: [{ src: `${base}YouTube-Subscriptions-move-old.jpg`, alt: '', caption: '' }, { src: `${base}YouTube-Subscriptions-move-new.jpg`, alt: '', caption: '' }] },
  };
  const related = withRelatedPictures(pool, async (u) => metas[u] ?? null);
  const [out] = (await addCompares(CFG, [item], related.imagesFor, null, new Map())).items;
  assert.deepEqual([out.compare?.before, out.compare?.after], [`${base}YouTube-Subscriptions-move-old.jpg`, `${base}YouTube-Subscriptions-move-new.jpg`], 'the two real screenshots, not the cover illustration');
});

test('pictures: a picture named as the old design is never shown alone (Google Messages, 5 Nov)', async () => {
  const base = { app: 'Google Messages', category: 'consumer' as const, kind: 'ui' as const, date: '', published_at: '2026-11-04T04:00:00Z', beta: true, importance: 2, what: 'w', why: 'y', sources: [{ title: 't', url: 'https://x/a', publisher: 'p' }], image: null, icon: null, collected_at: '' };
  const old = { src: 'https://9to5google.com/2026/11/Google-Messages-pinned-old.jpg', alt: '', caption: '' };
  const llm: Llm = { mode: 'company', canSearch: false, messages: async () => ({ content: [{ type: 'text', text: '{"best": 0}' }], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 } }) };
  const fetchImpl = (async () => new Response(new Uint8Array(6000), { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  const r = await addCompares(CFG, [{ ...base, id: 'alone', headline: 'Messages redesigns pinned chats' }, { ...base, id: 'picked', headline: 'Messages redesigns pinned chats' }], async (i) => (i.id === 'alone' ? [[old]] : [[old, { src: 'https://9to5google.com/2026/09/thread.jpg', alt: '', caption: '' }]]), llm, new Map(), fetchImpl);
  for (const i of r.items) assert.equal(i.image, null, `${i.id}: the app icon, not the old design`);
});

test('news coverage: Google News names the site, its news sitemap gives the real article (Samsung, 5 Nov)', async () => {
  const { newsCoverage } = await import('../src/related.ts');
  const at = '2026-11-03T12:43:00Z';
  const item = { app: 'Samsung', headline: "Samsung's One UI 9 redesigns the Galaxy Z Flip cover screen, and many owners are unhappy.", published_at: at, sources: [{ title: 'Samsung changed Galaxy Z Flip’s cover screen with One UI 9, and a lot of owners are not happy', url: 'https://androidauthority.com/a', publisher: 'Android Authority' }] };
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = String(input);
    if (u.startsWith('https://news.google.com/rss/search')) return new Response(`<rss><channel>
      <item><title>Some Galaxy Z Flip Users aren’t Impressed with One UI 9’s Cover Screen Overhaul - SammyGuru</title><link>https://news.google.com/rss/articles/xyz</link><pubDate>${new Date(at).toUTCString()}</pubDate><source url="https://sammyguru.com">SammyGuru</source></item>
      <item><title>Samsung changed Galaxy Z Flip's cover screen with One UI 9 - Android Authority</title><link>https://news.google.com/rss/articles/abc</link><pubDate>${new Date(at).toUTCString()}</pubDate><source url="https://www.androidauthority.com">Android Authority</source></item>
      <item><title>Best foldable phones to buy in 2026 - PhoneArena</title><link>https://news.google.com/rss/articles/q</link><pubDate>${new Date(at).toUTCString()}</pubDate><source url="https://www.phonearena.com">PhoneArena</source></item>
    </channel></rss>`);
    if (u === 'https://sammyguru.com/news-sitemap.xml') return new Response(`<urlset><url><loc>https://sammyguru.com/one-ui-9-rollout-tracker/</loc><news:news><news:title>One UI 9 Rollout Tracker</news:title></news:news></url><url><loc>https://sammyguru.com/galaxy-z-flip-users-arent-impressed-with-one-ui-9-cover-screen-overhaul/</loc><news:news><news:title>Some Galaxy Z Flip Users aren’t Impressed with One UI 9’s Cover Screen Overhaul</news:title></news:news></url></urlset>`);
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const found = await newsCoverage(item, fetchImpl);
  assert.deepEqual(found.map((f) => f.url), ['https://sammyguru.com/galaxy-z-flip-users-arent-impressed-with-one-ui-9-cover-screen-overhaul'], 'the article itself; not the story’s own site, not an unrelated one');
});

test('store screenshots: the last resort before the icon, by the app’s App Store id', async () => {
  const { storeShots } = await import('../src/related.ts');
  const fetchImpl = (async (u: string) => new Response(JSON.stringify({ results: [{ screenshotUrls: ['https://is1.mzstatic.com/a/1.png/392x696bb.jpg', 'https://is1.mzstatic.com/a/2.png/392x696bb.jpg'] }] }))) as unknown as typeof fetch;
  const r = await storeShots(CFG, { app: 'Airbnb' }, fetchImpl);
  assert.equal(r?.from, 'app-store');
  assert.deepEqual(r?.shots, ['https://is1.mzstatic.com/a/1.png/600x1300bb.jpg', 'https://is1.mzstatic.com/a/2.png/600x1300bb.jpg']);
  assert.equal(await storeShots(CFG, { app: 'Not on the watchlist' }, fetchImpl), null);
});
