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
    return body ? new Response(body) : new Response('missing', { status: 404 });
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
    { ...base, id: 'offline', kind: 'brand' as const, headline: 'D gets a new wordmark' },
    { ...base, id: 'kept-pair', kind: 'ui' as const, headline: 'E redesigns its home screen', compare: { before: 'https://x/e-old.jpg', after: 'https://x/e-new.jpg', from: 'article' as const } },
    { ...base, id: 'airbnb-v', kind: 'ui' as const, headline: 'Airbnb redesign', release: { store: 'app-store' as const, version: '26.44' } },
  ];
  const pictures: Record<string, ReturnType<typeof img>[][]> = {
    'x-icons': [[img('https://x/logo.jpg'), img('https://x/icon-grid.jpg')]],
    'c-logo': [[img('https://x/cmp.jpg'), img('https://x/team.jpg')]],
    'ux-b': [[img('https://x/office.jpg'), img('https://x/checkout.jpg')]],
    offline: [[img('https://x/gone1.jpg'), img('https://x/gone2.jpg', '', 'The new wordmark')]],
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
  assert.equal(by.offline.image, 'https://x/gone2.jpg', 'no picture could be downloaded: the caption decides');
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
