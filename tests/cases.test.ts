import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Llm, MessagesRequest } from '../src/llm.ts';
import { parseCasesConfig, prefilterCases, runCases, type CasesFile } from '../src/casestudies.ts';
import type { PoolPost } from '../src/weekly.ts';

const NOW = new Date('2026-11-02T00:00:00Z'); // 08:00 on Monday 2 Nov in Shanghai
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toUTCString();
const long = (words: string) => `${words} `.repeat(60);

const CFG = parseCasesConfig(`
enabled: true
max_picks: 2
min_score: 7
feeds:
  - name: Discord
    url: https://discord.com/blog/rss.xml
  - name: Design Week
    url: https://www.designweek.co.uk/feed/
`);

const item = (title: string, link: string, days: number, body = '') =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${daysAgo(days)}</pubDate><description><![CDATA[${body.slice(0, 200)}]]></description>${body ? `<content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>` : ''}</item>`;

function world() {
  const discord = `<rss><channel>
    ${item('Modernizing the video playback experience at Discord', 'https://discord.com/blog/video', 2)}
    ${item('Discord Patch Notes: October 6', 'https://discord.com/blog/patch', 3, long('Fixes to the design of things.'))}
    ${item('Scaling our Elixir clusters', 'https://discord.com/blog/elixir', 4, long('We added more nodes and tuned the scheduler.'))}
  </channel></rss>`;
  const dw = `<rss><channel>
    ${item('Nubank unveils global brand refresh by Koto', 'https://www.designweek.co.uk/nubank', 1, long('Koto built a new visual identity and typeface for Nubank ahead of its US launch.'))}
    ${item('A bakery rebrand in Leeds', 'https://www.designweek.co.uk/bakery', 5, long('A local studio redesigned the logo of a corner bakery.'))}
    ${item('Trustpilot reveals new brand identity', 'https://www.designweek.co.uk/trustpilot', 20, long('An older rebrand.'))}
  </channel></rss>`;
  const page = `<html><head><meta property="og:image" content="https://discord.com/og.png"></head><body><nav>Menu</nav><article><p>${long('We tested a new player with heavy video users and cut the time to first frame.')}</p></article></body></html>`;
  const routes: Record<string, string> = { 'https://discord.com/blog/rss.xml': discord, 'https://www.designweek.co.uk/feed/': dw, 'https://discord.com/blog/video': page };
  return (async (input: string | URL | Request) => {
    const body = routes[String(input)];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  }) as typeof fetch;
}

/** Keeps Nubank (9) and Discord (8), scores the bakery 4 as a small local business, drops anything else. */
class FakeLlm implements Llm {
  readonly mode = 'api' as const;
  readonly canSearch = false;
  calls: MessagesRequest[] = [];
  async messages(req: MessagesRequest) {
    this.calls.push(req);
    const { posts } = JSON.parse(req.messages[0].content as string) as { posts: { cid: string; title: string }[] };
    const score = (t: string) => (/Nubank/.test(t) ? 9 : /video/i.test(t) ? 8 : /bakery/.test(t) ? 4 : 0);
    const picks = posts
      .filter((p) => score(p.title))
      .map((p) => ({
        cid: p.cid,
        title: `How ${/Nubank/.test(p.title) ? 'Nubank' : 'Discord'} did it!`,
        company: /Nubank/.test(p.title) ? 'Nubank' : /video/i.test(p.title) ? 'Discord' : 'A bakery',
        company_domain: /Nubank/.test(p.title) ? 'https://www.nubank.com.br/' : 'not a domain',
        by: /Nubank/.test(p.title) ? 'Koto (agency)' : 'Discord design team',
        maker: /Nubank/.test(p.title) ? 'agency' : 'nonsense',
        area: /Nubank/.test(p.title) ? 'brand' : 'product',
        problem: 'It was hard 🚀.',
        approach: 'They tested it.',
        outcome: 'It shipped.',
        lesson: 'Test with real users',
        score: score(p.title),
        zh: { title: '标题', problem: '问题！', approach: '做法', outcome: '结果', lesson: '启发' },
      }));
    const dropped = posts.filter((p) => !score(p.title)).map((p) => ({ cid: p.cid, reason: 'engineering, no design' }));
    return { content: [{ type: 'text', text: JSON.stringify({ picks, dropped }) }], stopReason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 1500, web_searches: 0 } };
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-'));
  const paths = { data: join(dir, 'cases.json'), pool: join(dir, 'pool.json'), judged: join(dir, 'judged.json') };
  return { paths, llm: new FakeLlm() };
}

test('cases prefilter: drops posts without design words, patch notes, other languages and old posts', () => {
  const p = (title: string, days: number, extra: Partial<PoolPost> = {}): PoolPost => ({
    url: `https://a.b/${encodeURIComponent(title)}`, title, source: 'S', publishedAt: new Date(NOW.getTime() - days * DAY).toISOString(), summary: '', image: null, ...extra,
  });
  const { kept, dropped } = prefilterCases(
    [
      p('Redesigning the Duolingo chess board', 2),
      p('Thundering herd of circuit breakers', 2),
      p('Discord Patch Notes: the new design', 2),
      p('チェスコースで「対戦の振り返り」機能が新登場！', 2),
      p('A new visual identity for Nubank', 20),
      p('How we built it', 3, { content: 'The UX research showed... the UI... a usability test... the design system...' }),
    ],
    { from: new Date(NOW.getTime() - 14 * DAY), to: NOW, judged: new Set() },
  );
  assert.deepEqual(kept.map((k) => k.title), ['Redesigning the Duolingo chess board', 'How we built it']);
  const why = Object.fromEntries(dropped.map((d) => [d.title, d.reason]));
  assert.equal(why['Thundering herd of circuit breakers'], 'not about design');
  assert.match(why['Discord Patch Notes: the new design'], /not a case study/);
  assert.equal(why['チェスコースで「対戦の振り返り」機能が新登場！'], 'not in English');
  assert.equal(why['A new visual identity for Nubank'], 'not from the last two weeks');
});

test('weekly case pick: looks back two weeks, keeps the best above the bar, and uses the company’s own icon', async () => {
  const { paths, llm } = setup();
  const r = await runCases({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: world() });

  assert.equal(r.week, '2026-11-02');
  assert.ok(r.judged);
  assert.deepEqual(r.judged.picks.map((p) => p.company), ['Nubank', 'Discord']);
  const [nubank, discord] = r.judged.picks;
  assert.equal(nubank.maker, 'agency');
  assert.equal(nubank.area, 'brand');
  assert.match(nubank.icon, /domain=nubank\.com\.br/, 'the company’s site, cleaned up');
  assert.doesNotMatch(nubank.title, /!/);
  assert.doesNotMatch(nubank.problem, /🚀/);
  assert.equal(nubank.zh?.problem, '问题。');
  assert.equal(discord.maker, 'team', 'an unknown maker falls back to team');
  assert.match(discord.icon, /domain=discord\.com/, 'a bad domain falls back to the post’s site');
  assert.equal(discord.image, 'https://discord.com/og.png', 'read from the page when the feed has no text');

  const why = Object.fromEntries([...r.judged.preDropped, ...r.judged.modelDropped].map((d) => [d.title, d.reason]));
  assert.equal(why['A bakery rebrand in Leeds'], 'scored 4/10, below 7');
  assert.equal(why['Scaling our Elixir clusters'], 'not about design');
  assert.match(why['Discord Patch Notes: October 6'], /not a case study/);
  assert.equal(why['Trustpilot reveals new brand identity'], 'not from the last two weeks');

  const file = JSON.parse(readFileSync(paths.data, 'utf8')) as CasesFile;
  assert.equal(file.weeks[0].picks.length, 2);
});

test('a case judged one week is not judged again the next', async () => {
  const { paths, llm } = setup();
  await runCases({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: world() });
  const tuesday = new Date(NOW.getTime() + DAY);
  assert.equal((await runCases({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: tuesday, paths, fetchImpl: world() })).judged, null);
  const nextWeek = new Date(NOW.getTime() + 7 * DAY);
  const r = await runCases({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: nextWeek, paths, fetchImpl: world() });
  assert.equal(r.judged?.candidates, 0, 'every post in the window was judged last week');
  assert.equal(llm.calls.length, 1);
  const file = JSON.parse(readFileSync(paths.data, 'utf8')) as CasesFile;
  assert.deepEqual(file.weeks.map((w) => [w.week, w.picks.length]), [['2026-11-09', 0], ['2026-11-02', 2]]);
});

test('when no case-study feed can be read, nothing is written', async () => {
  const { paths, llm } = setup();
  const down = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  await assert.rejects(runCases({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: down }), /No case study feed/);
  assert.equal(existsSync(paths.data), false);
});

test('articleText reads every <article> block of a post split into several (Discord)', async () => {
  const { articleText } = await import('../src/weekly.ts');
  const a = articleText('<body><nav>Menu</nav><article><p>Part one.</p></article><aside>Ad</aside><article><p>Part two.</p></article></body>');
  assert.equal(a.text, 'Part one. Part two.');
});
