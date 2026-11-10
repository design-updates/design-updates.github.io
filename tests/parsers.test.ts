import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig, parseConfig } from '../src/config.ts';
import { parseFeed } from '../src/feeds.ts';
import { parsePageMeta } from '../src/pagemeta.ts';
import { normalizeUrl } from '../src/util.ts';
import { parseYaml } from '../src/yaml.ts';

test('yaml: nested maps, lists of maps, inline lists and maps, comments, quotes', () => {
  const y = parseYaml(`
# top comment
name: "Radar # not a comment"
count: 3
on: true
models:
  curate: claude-x   # trailing comment
prices:
  m: { input: 3, output: 15 }
apps:
  - name: Expedia
    aliases: [Expedia, "Hotels.com"]
    domains:
      - expedia.com
  - name: Agoda
words:
  - "% off"
  - plain
empty:
url: https://example.com/a:b
`) as Record<string, any>;
  assert.equal(y.name, 'Radar # not a comment');
  assert.equal(y.count, 3);
  assert.equal(y.on, true);
  assert.equal(y.models.curate, 'claude-x');
  assert.deepEqual(y.prices.m, { input: 3, output: 15 });
  assert.deepEqual(y.apps[0], { name: 'Expedia', aliases: ['Expedia', 'Hotels.com'], domains: ['expedia.com'] });
  assert.deepEqual(y.apps[1], { name: 'Agoda' });
  assert.deepEqual(y.words, ['% off', 'plain']);
  assert.equal(y.empty, null);
  assert.equal(y.url, 'https://example.com/a:b');
});

test('yaml: tabs are rejected with a line number', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), /line 2.*tabs/);
});

test('watchlist.yaml loads, every feed names a real app, and no app is listed twice', () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.groups.map((g) => g.category), ['ota', 'rail', 'delivery', 'platform', 'consumer']);
  assert.ok(cfg.apps.length >= 50);
  assert.ok(cfg.feeds.length >= 10);
});

test('config: duplicate apps and unknown feed apps are explained', () => {
  const base = 'groups:\n  ota:\n    apps:\n      - name: A\n';
  assert.throws(() => parseConfig(`${base}  consumer:\n    apps:\n      - name: A\n`), /listed twice/);
  assert.throws(() => parseConfig(`${base}feeds:\n  - url: https://x\n    kind: company\n    app: B\n`), /not in groups/);
});

test('rss: title, link, date, summary and image from media:content', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <item><title><![CDATA[Airbnb adds &amp; tests Services]]></title><link>https://news.airbnb.com/services/?utm_source=rss</link>
    <pubDate>Tue, 28 Oct 2026 14:00:00 +0000</pubDate><description><![CDATA[<p>New <b>tab</b> in the app.</p>]]></description>
    <media:content url="https://img.example/a.jpg" medium="image"/></item>
    <item><title>No link</title></item>
  </channel></rss>`;
  const [e, ...rest] = parseFeed(xml, 'https://news.airbnb.com/feed/');
  assert.equal(rest.length, 0);
  assert.equal(e.title, 'Airbnb adds & tests Services');
  assert.equal(e.publishedAt, '2026-10-28T14:00:00.000Z');
  assert.equal(e.summary, 'New tab in the app.');
  assert.equal(e.image, 'https://img.example/a.jpg');
  assert.equal(normalizeUrl(e.url), 'https://news.airbnb.com/services');
});

test('atom: alternate link, published date, image from content', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Material 3 update</title>
    <link rel="replies" href="https://x/comments"/><link rel="alternate" type="text/html" href="https://android-developers.googleblog.com/2026/10/m3.html"/>
    <published>2026-10-28T09:00:00-07:00</published><content type="html">&lt;img src="https://img/x.png"&gt; Hello</content></entry></feed>`;
  const [e] = parseFeed(xml, 'https://android-developers.googleblog.com/feeds/posts/default');
  assert.equal(e.url, 'https://android-developers.googleblog.com/2026/10/m3.html');
  assert.equal(e.publishedAt, '2026-10-28T16:00:00.000Z');
  assert.equal(e.title, 'Material 3 update');
});

test('rss: escaped HTML in descriptions is stripped too', () => {
  const xml = `<rss><channel><item><title>T</title><link>https://a.b/c</link><description>&lt;div class="x"&gt;&lt;img src="i.jpg"&gt;&lt;/div&gt;Real text &amp;amp; more</description></item></channel></rss>`;
  assert.equal(parseFeed(xml, 'https://a.b/')[0].summary, 'Real text & more');
});

test('page meta: article:published_time, og:image (made absolute), JSON-LD fallback', () => {
  const a = parsePageMeta(`<head><meta property="og:image" content="/img/hero.png"><meta property="article:published_time" content="2026-10-27T08:00:00Z"><meta property="og:site_name" content="The Verge"></head>`, 'https://www.theverge.com/x');
  assert.deepEqual([a.publishedAt, a.image, a.siteName], ['2026-10-27T08:00:00.000Z', 'https://www.theverge.com/img/hero.png', 'The Verge']);
  const b = parsePageMeta(`<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2025-03-01T10:00:00Z"}</script>`, 'https://x.com');
  assert.equal(b.publishedAt, '2025-03-01T10:00:00.000Z');
});

test('the README documents the commands package.json defines', () => {
  const readme = readFileSync('README.md', 'utf8');
  const scripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts);
  for (const s of scripts) assert.ok(readme.includes(`npm run ${s}`) || s === 'test', `README is missing npm run ${s}`);
});

test('build copies app icons and source favicons into the site, keeping the original address when a download fails', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mirrorAssets } = await import('../src/mirror.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
  const item = {
    id: 'x', app: 'Airbnb', category: 'ota' as const, date: '2026-10-29', published_at: '', beta: false, importance: 3,
    headline: 'h', what: 'w', why: 'y', image: null, collected_at: '',
    icon: 'https://is1-ssl.mzstatic.com/image/thumb/a/128x128bb.png',
    sources: [{ title: 't', url: 'https://news.airbnb.com/a', publisher: 'Airbnb' }, { title: 't', url: 'https://skift.com/b', publisher: 'Skift' }],
  };
  const fetchImpl = (async (url: string) =>
    /(16x16|128x128)bb\.png$/.test(url) || /airbnb/.test(url)
      ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
      : new Response('nope', { status: 404 })) as unknown as typeof fetch;
  const r = await mirrorAssets({ version: 1, updated_at: '', days: [{ date: '2026-10-29', collected_at: '', quiet: false, pattern: null, items: [item] }] }, dir, fetchImpl);
  const out = r.radar.days[0].items[0];
  assert.match(out.icon ?? '', /^icons\/[0-9a-f]{12}\.png$/);
  assert.ok(existsSync(join(dir, out.icon!)));
  assert.match(out.sources[0].favicon ?? '', /^icons\//);
  assert.equal(out.sources[1].favicon, null, 'Skift favicon failed, so the page falls back to the original address');
  assert.match(out.icon_large ?? '', /^icons\/[0-9a-f]{12}\.png$/, 'a large copy too, for a card with no picture');
  assert.notEqual(out.icon_large, out.icon);
  assert.deepEqual([r.saved, r.failed], [3, 1]);
});

test('newsroom pages: article links from markup and from script data, assets and other sites left out', async () => {
  const { pageLinks } = await import('../src/feeds.ts');
  const html = `<html><head><link rel="canonical" href="https://www.trip.com/newsroom/"><link href="/newsroom/home.c4fa6df0.css" rel="stylesheet"></head>
    <body><nav><a href="/newsroom/">Newsroom</a> <a href="/about-us">About</a></nav>
    <a href="https://www.trip.com/newsroom/trip-com-wins-the-if-design-award-2026/">Trip.com wins the iF Design Award</a>
    <a href="/newsroom/tripgenie-how-travellers-are-using-ai/?utm_source=x">TripGenie</a>
    <a href="https://other.example/newsroom/not-ours/">elsewhere</a>
    <script>window.__DATA__={"items":[{"url":"/newsroom/eight-clever-ways-to-save/"},{"url":"/newsroom/vendor.f4b5637c.js"},{"url":"/newsroom/trip-com-wins-the-if-design-award-2026/"}]}</script>
    <span class=c-news-card__link data-href=/newsroom/global-football-tournament-drives-travel>card</span></body></html>`;
  // Addresses are normalised as everywhere else (no www, no tracking query), so a story found twice counts once.
  assert.deepEqual(pageLinks(html, 'https://www.trip.com/newsroom/', /^\/newsroom\/[a-z0-9-]{12,}\/?$/), [
    'https://trip.com/newsroom/trip-com-wins-the-if-design-award-2026',
    'https://trip.com/newsroom/tripgenie-how-travellers-are-using-ai',
    'https://trip.com/newsroom/eight-clever-ways-to-save',
    'https://trip.com/newsroom/global-football-tournament-drives-travel',
  ]);
  assert.equal(pageLinks(html, 'https://www.trip.com/newsroom/', /^\/newsroom\/[a-z0-9-]{12,}\/?$/, 2).length, 2, 'at most max links');
});

test('newsroom pages: each article is read for its title, date and summary; a page with no matching links is an error', async () => {
  const { readFeed } = await import('../src/feeds.ts');
  const pages: Record<string, string> = {
    'https://news.example.com/': '<a href="/introducing-a-new-way-to-book">x</a> <a href="/about">About us</a>',
    'https://news.example.com/introducing-a-new-way-to-book': '<meta property="og:title" content="Introducing a new way to book"><meta property="og:description" content="A new booking screen."><meta property="article:published_time" content="2026-11-02T08:00:00Z"><meta property="og:image" content="https://news.example.com/hero.jpg">',
  };
  const fetchImpl = (async (u: string | URL | Request) => (pages[String(u)] ? new Response(pages[String(u)]) : new Response('no', { status: 404 }))) as typeof fetch;
  const feed = { name: 'Example Newsroom', url: 'https://news.example.com/', kind: 'company' as const, app: 'Airbnb', page: /^\/[a-z0-9]+(-[a-z0-9]+){2,}\/?$/ };
  const r = await readFeed(feed, fetchImpl);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, [{ title: 'Introducing a new way to book', url: 'https://news.example.com/introducing-a-new-way-to-book', publishedAt: '2026-11-02T08:00:00.000Z', summary: 'A new booking screen.', image: 'https://news.example.com/hero.jpg' }]);
  const none = await readFeed({ ...feed, page: /^\/press\// }, fetchImpl);
  assert.equal(none.ok, false);
  assert.match(none.error ?? '', /no article links/);
  const refused = (async (u: string | URL | Request) => (String(u) === 'https://news.example.com/' ? new Response(pages['https://news.example.com/']) : new Response('no', { status: 429 }))) as typeof fetch;
  const blocked = await readFeed(feed, refused);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? '', /found 1 articles but could not read any/);
});

test('page meta: a <time> with only readable text gives the date (Trip.com), and nothing else is guessed', async () => {
  const { parsePageMeta } = await import('../src/pagemeta.ts');
  assert.equal(parsePageMeta('<title>x</title><time class=c-news-article__date>Jul 21, 2026</time>', 'https://trip.com/a').publishedAt, '2026-07-21T12:00:00.000Z');
  assert.equal(parsePageMeta('<time>3 November 2026</time>', 'https://x/a').publishedAt, '2026-11-03T12:00:00.000Z');
  assert.equal(parsePageMeta('<time>5 min read</time><p>Sale runs August 12, 2026</p>', 'https://x/a').publishedAt, null);
});

test('feed links encoded twice are decoded, and partner=rss is dropped', () => {
  const [e] = parseFeed('<rss><channel><item><title>T</title><link>https://fastcompany.com/1/a?partner=rss&amp;amp;utm_source=rss&amp;amp;id=7</link></item></channel></rss>', 'https://fastcompany.com/rss');
  assert.equal(e.url, 'https://fastcompany.com/1/a?partner=rss&utm_source=rss&id=7');
  assert.equal(normalizeUrl(e.url), 'https://fastcompany.com/1/a?id=7');
});

test('build copies card pictures and comparisons into the site', async () => {
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mirrorAssets } = await import('../src/mirror.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pictures-'));
  const base = { app: 'A', category: 'consumer' as const, date: '2026-11-07', published_at: '', beta: false, importance: 2, headline: 'h', what: 'w', why: 'y', icon: null, collected_at: '', sources: [] };
  const items = [
    { ...base, id: 'photo', image: 'https://img.test/photo.jpg' },
    { ...base, id: 'pair', image: null, compare: { before: 'https://img.test/old.webp', after: 'https://img.test/new.webp', from: 'article' as const } },
  ];
  const fetchImpl = (async (u: string) => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': u.endsWith('.jpg') ? 'image/jpeg' : u.endsWith('.webp') ? 'image/webp' : 'image/png' } })) as unknown as typeof fetch;
  const out = (await mirrorAssets({ version: 1, updated_at: '', days: [{ date: '2026-11-07', collected_at: '', quiet: false, pattern: null, items }] }, dir, fetchImpl)).radar.days[0].items;
  assert.match(out[0].image ?? '', /^icons\/[0-9a-f]{12}\.jpg$/);
  assert.match(out[1].compare?.before ?? '', /^icons\/[0-9a-f]{12}\.webp$/);
  assert.match(out[1].compare?.after ?? '', /^icons\/[0-9a-f]{12}\.webp$/);
  for (const u of [out[0].image, out[1].compare?.before, out[1].compare?.after]) assert.ok(u && existsSync(join(dir, u)), u ?? 'missing');
});

test('reviewed assets are locked to the correct story, source, dimensions and bytes', async () => {
  const { cpSync, mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { verifyReviewedAssets } = await import('../src/verified-assets.ts');
  const dir = mkdtempSync(join(tmpdir(), 'verified-assets-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'site/assets/verified'), { recursive: true });
  cpSync('site/assets/verified/spotify-pins-before-after.webp', join(dir, 'site/assets/verified/spotify.webp'));
  const bytes = readFileSync(join(dir, 'site/assets/verified/spotify.webp'));
  const manifest = {
    version: 1,
    assets: [{
      path: 'assets/verified/spotify.webp', story_id: 'spotify-pins', role: 'combined',
      source_url: 'https://source.test/spotify', reviewed_content: 'Spotify old and new Pins layouts',
      width: 1808, height: 1338, sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  writeFileSync(join(dir, 'data/verified-assets.json'), JSON.stringify(manifest));
  const item = {
    id: 'spotify-pins', app: 'Spotify', category: 'consumer' as const, date: '2026-11-07', published_at: '', beta: true, importance: 2,
    headline: 'Spotify Pins', what: 'w', why: 'y', image: null, icon: null, collected_at: '',
    sources: [{ title: 'Spotify source', url: 'https://source.test/spotify', publisher: 'Source' }],
    compare: { before: null, after: 'assets/verified/spotify.webp', combined: true, from: 'article' as const },
  };
  const radar = { version: 1 as const, updated_at: '', days: [{ date: '2026-11-07', collected_at: '', quiet: false, pattern: null, items: [item] }] };
  assert.doesNotThrow(() => verifyReviewedAssets(radar, dir));

  cpSync('site/assets/verified/google-maps-iphone-duo.jpg', join(dir, 'site/assets/verified/spotify.webp'));
  assert.throws(() => verifyReviewedAssets(radar, dir), /bytes changed without review/, 'another story image cannot hide behind the Spotify filename');
});

test('the static search/share metadata stays English', () => {
  const html = readFileSync('site/index.html', 'utf8');
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<title>Pixel Post · app design changes worth your time<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/design-updates\.github\.io\/"/);
  assert.match(html, /<meta property="og:title" content="Pixel Post · app design changes worth your time"/);
  const app = readFileSync('site/app.js', 'utf8');
  assert.match(app, /document\.title = T\.en\.title/);
});

test('all news images open the viewer while headlines stay source links', () => {
  const app = readFileSync('site/app.js', 'utf8');
  assert.match(app, /function imageViewerAttrs/);
  assert.match(app, /class="frame photo image-open"/);
  assert.match(app, /class="row-thumb notch image-open/);
  assert.match(app, /class="headline"><a/);
  assert.match(app, /class="row-title"><a/);
  assert.match(app, /openImageViewer/);
  assert.doesNotMatch(app, /<a class="frame photo"/);
  const css = readFileSync('site/styles.css', 'utf8');
  assert.match(css, /\.frame::after[\s\S]*box-shadow: inset 0 0 0 3px var\(--edge\)/, 'transparent large images keep a complete four-sided edge');
  assert.match(css, /\.row-thumb img[\s\S]*object-fit: contain/);
  assert.match(css, /\.image-view img[\s\S]*object-fit: contain/);
});

test('Fustat is the default display font and Pixelify remains an explicit v2 preference', () => {
  const html = readFileSync('site/index.html', 'utf8');
  const css = readFileSync('site/styles.css', 'utf8');
  const app = readFileSync('site/app.js', 'utf8');
  assert.match(css, /--display: var\(--body\)/);
  assert.match(css, /:root\[data-font='pixel'\][\s\S]*--display: var\(--brand\)/);
  assert.match(css, /\.wordmark-text[\s\S]*var\(--brand\)/);
  assert.match(html, /localStorage\.getItem\('radar\.font\.v2'\)/);
  assert.match(html, /localStorage\.removeItem\('radar\.font'\)/, 'the old Pixelify-default preference is migrated away');
  assert.match(html, /if \(f === 'pixel'\) document\.documentElement\.dataset\.font = 'pixel'/);
  assert.match(app, /localStorage\.setItem\('radar\.font\.v2', pixel \? 'pixel' : 'fustat'\)/);
  assert.match(app, /dataset\.font === 'pixel'/);
  assert.doesNotMatch(css, /data-font='clean'/);
});

test('every large card headline uses one size regardless of story order', () => {
  const css = readFileSync('site/styles.css', 'utf8');
  assert.match(css, /\.headline\s*\{[\s\S]*?font:\s*600 clamp\(20px, 2vw, 24px\)\/1\.22 var\(--display\)/);
  assert.doesNotMatch(css, /\.story(?::first-child|:first-of-type|:nth-child\([^)]*\))[^{}]*\.headline/, 'story position must never change headline size');
});

test('the News Earlier heading and filters stick on desktop only', () => {
  const css = readFileSync('site/styles.css', 'utf8');
  assert.match(css, /@media \(min-width: 641px\)[\s\S]*\.archive\.news-only > \.archive-head[\s\S]*position: sticky[\s\S]*top: 0/);
  assert.doesNotMatch(css, /\.cases[^}]*> \.archive-head[^}]*position: sticky/);
  assert.doesNotMatch(css, /\.workflows[^}]*> \.archive-head[^}]*position: sticky/);
});
