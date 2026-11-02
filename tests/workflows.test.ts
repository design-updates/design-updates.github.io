import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFeed } from '../src/feeds.ts';
import type { Llm, MessagesRequest } from '../src/llm.ts';
import { articleText, parseWorkflowsConfig, prefilterWorkflows, runWorkflows, weekKey, type PoolPost, type WorkflowsFile } from '../src/workflows.ts';

const NOW = new Date('2026-11-02T00:00:00Z'); // 08:00 on Monday 2 Nov in Shanghai
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toUTCString();
const long = (words: string) => `${words} `.repeat(60);

const CFG = parseWorkflowsConfig(`
enabled: true
max_picks: 2
min_score: 7
feeds:
  - name: UX Collective
    url: https://uxdesign.cc/feed
  - name: Sidebar
    url: https://sidebar.io/feed.xml
`);

const item = (title: string, link: string, hours: number, body = '', creator = '') =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${hoursAgo(hours)}</pubDate>${creator ? `<dc:creator><![CDATA[${creator}]]></dc:creator>` : ''}<description><![CDATA[${body.slice(0, 200)}]]></description>${body ? `<content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>` : ''}</item>`;

function world() {
  const ux = `<rss><channel>
    ${item('How I turn interview notes into a journey map with Claude', 'https://uxdesign.cc/journey-map-claude', 20, long('I pasted eight transcripts into Claude and asked for pain points by stage, then checked each one by hand in FigJam.'), 'Jane Doe')}
    ${item('10 AI tools every designer needs', 'https://uxdesign.cc/ten-tools', 30, long('Here are ten AI tools.'))}
    ${item('A better date picker', 'https://uxdesign.cc/date-picker', 40, long('Calendar grids, ranges and keyboard support.'))}
    ${item('Prototyping a booking flow with Figma Make', 'https://uxdesign.cc/figma-make-booking', 50, long('I gave Figma Make our design system and a prompt for each step of checkout.'))}
    ${item('Claude for design critique', 'https://uxdesign.cc/old-critique', 24 * 9, long('An older post about Claude.'))}
  </channel></rss>`;
  const sidebar = `<rss><channel>${item('Vibe coding my portfolio with Cursor', 'https://someone.design/portfolio', 10, '')}</channel></rss>`;
  const page = `<html><head><meta property="og:image" content="https://someone.design/og.png"><meta name="author" content="Sam Lee"></head>
    <body><nav>Home About</nav><article><h1>Vibe coding my portfolio</h1><p>${long('I described each section to Cursor and fixed the spacing by hand.')}</p></article><footer>©</footer></body></html>`;
  const routes: Record<string, string> = { 'https://uxdesign.cc/feed': ux, 'https://sidebar.io/feed.xml': sidebar, 'https://someone.design/portfolio': page };
  return (async (input: string | URL | Request) => {
    const body = routes[String(input)];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  }) as typeof fetch;
}

/** Keeps the journey map (9) and the portfolio (7), scores Figma Make 6, and drops anything else. */
class FakeLlm implements Llm {
  readonly mode = 'api' as const;
  readonly canSearch = false;
  calls: MessagesRequest[] = [];
  async messages(req: MessagesRequest) {
    this.calls.push(req);
    const { posts } = JSON.parse(req.messages[0].content as string) as { posts: { cid: string; title: string; text: string }[] };
    const score = (t: string) => (/journey/i.test(t) ? 9 : /portfolio/i.test(t) ? 7 : /Figma Make/i.test(t) ? 6 : 0);
    const picks = posts
      .filter((p) => score(p.title))
      .map((p) => ({
        cid: p.cid,
        title: `Rewritten: ${p.title}!`,
        author: null,
        author_role: /journey/i.test(p.title) ? 'Senior designer at a bank' : null,
        tools: /journey/i.test(p.title) ? ['Claude', 'FigJam AI'] : ['Cursor'],
        stage: /journey/i.test(p.title) ? 'research' : 'nonsense',
        type: 'workflow',
        process: 'Step one. Step two 🚀.',
        result: 'A first draft in two hours.',
        catch: /journey/i.test(p.title) ? 'Claude merged two complaints.' : null,
        try_if: 'you have more research than time',
        score: score(p.title),
        zh: { title: '标题', process: '步骤！', result: '结果', catch: null, try_if: '适合' },
      }));
    const dropped = posts.filter((p) => !score(p.title)).map((p) => ({ cid: p.cid, reason: 'opinion, no method' }));
    return { content: [{ type: 'text', text: JSON.stringify({ picks, dropped }) }], stopReason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 1500, web_searches: 0 } };
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const paths = { data: join(dir, 'workflows.json'), pool: join(dir, 'pool.json'), judged: join(dir, 'judged.json') };
  return { dir, paths, llm: new FakeLlm() };
}

test('feeds keep the full post text and the author when they carry them', () => {
  const xml = `<rss><channel>${item('A post', 'https://a.b/p', 1, long('Body text.'), 'Jane Doe')}</channel></rss>`;
  const [e] = parseFeed(xml, 'https://a.b/feed');
  assert.equal(e.author, 'Jane Doe');
  assert.ok((e.content ?? '').length > 600);
  assert.ok(e.summary.length <= 400);
});

test('weekKey is the Monday of the reader’s week', () => {
  assert.equal(weekKey(NOW, 'Asia/Shanghai'), '2026-11-02');
  assert.equal(weekKey(new Date('2026-11-08T15:00:00Z'), 'Asia/Shanghai'), '2026-11-02', 'Sunday 23:00 is still that week');
  assert.equal(weekKey(new Date('2026-11-08T16:30:00Z'), 'Asia/Shanghai'), '2026-11-09', 'past midnight is the next week');
});

test('prefilter: drops old, off-topic, listicles and course posts; tool names need their capitals', () => {
  const p = (title: string, hours: number, extra: Partial<PoolPost> = {}): PoolPost => ({
    url: `https://a.b/${encodeURIComponent(title)}`, title, source: 'S', publishedAt: new Date(NOW.getTime() - hours * 3_600_000).toISOString(), summary: '', image: null, ...extra,
  });
  const { kept, dropped } = prefilterWorkflows(
    [
      p('Designing with Claude', 5),
      p('10 AI tools for designers', 5),
      p('Moving the cursor with a bolt of colour', 5),
      p('A great AI course for designers, starting Monday', 5),
      p('Claude workflows', 24 * 8),
      p('A long read', 5, { content: 'We used Claude, then Claude again, then Midjourney for the hero.' }),
    ],
    { from: new Date(NOW.getTime() - 7 * 86_400_000), to: NOW, judged: new Set() },
  );
  assert.deepEqual(kept.map((k) => k.title), ['Designing with Claude', 'A long read']);
  const why = Object.fromEntries(dropped.map((d) => [d.title, d.reason]));
  assert.equal(why['10 AI tools for designers'], 'listicle');
  assert.equal(why['Moving the cursor with a bolt of colour'], 'not about AI');
  assert.match(why['A great AI course for designers, starting Monday'], /not a workflow post/);
  assert.equal(why['Claude workflows'], 'not from this week');
});

test('articleText reads the article, not the menus, and finds the image and author', () => {
  const a = articleText('<html><head><meta content="https://x/og.png" property="og:image"><meta name="author" content="Sam Lee"></head><body><nav>Menu</nav><article><p>The real text.</p></article></body></html>');
  assert.equal(a.text, 'The real text.');
  assert.equal(a.image, 'https://x/og.png');
  assert.equal(a.author, 'Sam Lee');
});

test('weekly pick: keeps the best posts above the bar, writes them up, and records why the rest were dropped', async () => {
  const { paths, llm } = setup();
  const r = await runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: world() });

  assert.equal(r.week, '2026-11-02');
  assert.ok(r.judged);
  assert.deepEqual(r.judged.picks.map((p) => p.score), [9, 7]);
  const [top, second] = r.judged.picks;
  assert.equal(top.url, 'https://uxdesign.cc/journey-map-claude');
  assert.equal(top.author, 'Jane Doe', 'the feed’s author fills in when the model gives none');
  assert.equal(top.stage, 'research');
  assert.deepEqual(top.tools, ['Claude', 'FigJam AI']);
  assert.doesNotMatch(top.title, /!/);
  assert.doesNotMatch(top.process, /🚀/);
  assert.equal(top.zh?.process, '步骤。');
  assert.equal(second.url, 'https://someone.design/portfolio');
  assert.equal(second.author, 'Sam Lee', 'read from the page Sidebar links to');
  assert.equal(second.image, 'https://someone.design/og.png');
  assert.equal(second.stage, 'ux', 'an unknown stage falls back to ux');

  const why = Object.fromEntries([...r.judged.preDropped, ...r.judged.modelDropped].map((d) => [d.title, d.reason]));
  assert.equal(why['10 AI tools every designer needs'], 'listicle');
  assert.equal(why['A better date picker'], 'not about AI');
  assert.equal(why['Prototyping a booking flow with Figma Make'], 'scored 6/10, below 7');
  assert.equal(why['Claude for design critique'], 'not from this week');

  const file = JSON.parse(readFileSync(paths.data, 'utf8')) as WorkflowsFile;
  assert.equal(file.weeks.length, 1);
  assert.equal(file.weeks[0].picks.length, 2);
  assert.ok(existsSync(paths.pool));
});

test('the rest of the week only pools posts; --force picks again; a dry run writes nothing', async () => {
  const { paths, llm } = setup();
  await runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: world() });
  const tuesday = new Date(NOW.getTime() + 86_400_000);
  const again = await runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: tuesday, paths, fetchImpl: world() });
  assert.equal(again.judged, null);
  assert.equal(llm.calls.length, 1, 'no second model call in the same week');

  const forced = await runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: tuesday, paths, fetchImpl: world(), force: true });
  assert.equal(forced.judged?.picks.length, 2, 'the week’s own picks can be judged again');
  assert.equal((JSON.parse(readFileSync(paths.data, 'utf8')) as WorkflowsFile).weeks.length, 1, 'replaced, not added');

  const fresh = setup();
  const dry = await runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm: null, now: NOW, paths: fresh.paths, fetchImpl: world(), dryRun: true });
  assert.ok(dry.judged && dry.judged.candidates >= 3);
  assert.equal(existsSync(fresh.paths.data), false);
  assert.equal(existsSync(fresh.paths.pool), false);
});

test('when no workflow feed can be read, nothing is written', async () => {
  const { paths, llm } = setup();
  const down = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  await assert.rejects(runWorkflows({ cfg: CFG, timeZone: 'Asia/Shanghai', model: 'm', llm, now: NOW, paths, fetchImpl: down }), /No workflow feed/);
  assert.equal(existsSync(paths.data), false);
});
