// Other coverage of the same story. A change usually reaches several sites; when the one the model kept blocks
// readers (Android Authority) or shows only a stock photo, another site's article about the same change can supply
// the picture. That site is then listed as a source too, so the picture is credited.

import { addCompares, isStockImage, oldUpload, type CompareResult } from './compare.ts';
import { appByName, type Config } from './config.ts';
import type { Llm } from './llm.ts';
import type { PageImage, PageMeta } from './pagemeta.ts';
import { matchApp } from './prefilter.ts';
import type { Candidate, Item } from './types.ts';
import { readFeed } from './feeds.ts';
import { decodeEntities, fetchText, hoursAgo, mapLimit, normalizeUrl, onDomain, parseDate } from './util.ts';

/** A headline from any source read this run, kept for matching (the model never sees these). */
export interface PoolEntry {
  title: string;
  url: string;
  source: string;
  app: string | null;
  publishedAt: string | null;
}

/** Words that say nothing about which story it is. */
const STOP = new Set(
  'the and for with its now new gets get got adds add added app apps your you from this that are has have will can could more into out after before what why how all our about just finally latest users user update updates updated rolling rolls rolled starts start started here there their than then them they some most first big long one two way ways says said'.split(' '),
);
const keyWords = (s: string) => (s.toLowerCase().replace(/[’']s\b/g, '').match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every headline from the last three days, from sites that are not blocked. */
export function poolOf(cfg: Config, candidates: Candidate[], now: Date): PoolEntry[] {
  return candidates
    .filter((c) => {
      const at = parseDate(c.publishedAt);
      return at && hoursAgo(at, now) <= 72 && !c.release && !cfg.trust.blockedDomains.some((b) => !b.includes('/') && onDomain(c.domain, [b]));
    })
    .map((c) => ({ title: c.title, url: c.url, source: c.source, app: c.app ?? matchApp(cfg, c.title)?.name ?? null, publishedAt: c.publishedAt }));
}

/**
 * The other articles about this item's story: about the same app (by the watchlist, or its name in the headline),
 * within three days, sharing at least two of the words that tell stories apart, and most of the shorter headline's.
 * One per site, best match first.
 */
export function relatedCoverage(item: Pick<Item, 'app' | 'headline' | 'sources' | 'published_at'>, pool: PoolEntry[], max = 4, windowHours = 72): PoolEntry[] {
  const own = new Set(item.sources.map((s) => s.url));
  const at = Date.parse(item.published_at);
  const appWords = new Set(keyWords(item.app));
  const named = new RegExp(`(?<![\\w])${escape(item.app)}(?![\\w])`, 'i');
  const refs = [item.headline, ...item.sources.map((s) => s.title)].map((t) => keyWords(t).filter((w) => !appWords.has(w)));
  const found: { p: PoolEntry; score: number }[] = [];
  for (const p of pool) {
    if (own.has(p.url) || !(p.app === item.app || named.test(p.title))) continue;
    const t = Date.parse(p.publishedAt ?? '');
    if (!Number.isFinite(t) || (Number.isFinite(at) && Math.abs(t - at) > windowHours * 3_600_000)) continue;
    const words = new Set(keyWords(p.title).filter((w) => !appWords.has(w)));
    let score = 0;
    for (const r of refs) {
      const shared = new Set(r.filter((w) => words.has(w))).size;
      const fit = shared / Math.max(1, Math.min(new Set(r).size, words.size));
      if (shared >= 2 && fit > score) score = fit;
    }
    if (score >= 0.4) found.push({ p, score });
  }
  const sites = new Set(item.sources.map((s) => s.publisher));
  return found
    .sort((a, b) => b.score - a.score)
    .map((f) => f.p)
    .filter((p) => !sites.has(p.source) && sites.add(p.source))
    .slice(0, max);
}

/** WordPress news sites that answer a search as a feed (/?s=…&feed=rss2), with readable article pages (Nov 2026). */
const SEARCHABLE: [string, string][] = [
  ['9to5Google', 'https://9to5google.com'],
  ['9to5Mac', 'https://9to5mac.com'],
  ['TechCrunch', 'https://techcrunch.com'],
  ['Droid Life', 'https://www.droid-life.com'],
];

/**
 * The last resort for a card with no picture: search those sites for the same story. A change is often first
 * reported days before the story that reached us (YouTube's tab bar: 9to5Google on 22 Oct, the backlash on 4 Nov),
 * so the search looks back three weeks.
 */
export async function searchCoverage(item: Pick<Item, 'app' | 'headline' | 'sources' | 'published_at'>, fetchImpl: typeof fetch = fetch): Promise<PoolEntry[]> {
  const appWords = new Set(keyWords(item.app));
  // The words that name the story are the ones the headline and its sources' titles share ("subscriptions",
  // "redesign"); then the longest of the rest.
  const head = [...new Set(keyWords(item.headline).filter((w) => !appWords.has(w)))];
  const inTitles = new Set(item.sources.flatMap((s) => keyWords(s.title)));
  const words = [...head.filter((w) => inTitles.has(w)), ...head.filter((w) => !inTitles.has(w)).sort((a, b) => b.length - a.length)].slice(0, 2);
  if (words.length < 2) return [];
  const q = encodeURIComponent(`${item.app} ${words.join(' ')}`);
  const found: PoolEntry[] = [];
  await Promise.all(
    SEARCHABLE.map(async ([name, site]) => {
      const r = await readFeed({ name, url: `${site}/?s=${q}&feed=rss2`, kind: 'outlet', app: null }, fetchImpl);
      for (const e of r.entries.slice(0, 5)) found.push({ title: e.title, url: normalizeUrl(e.url), source: name, app: null, publishedAt: e.publishedAt });
    }),
  );
  return relatedCoverage(item, found, 3, 21 * 24);
}

/**
 * Who else covered the story, from Google News, and the real address of each article, from that site's news sitemap.
 * Google News search works from the laptop but wraps every link in a redirect that can't be followed; it does give
 * each result's site and headline, and most news sites list their recent articles in a news sitemap (the one Google
 * News reads), headline and address together. Found this way on 5 Nov: Android Police and 9to5Google for the Messages
 * redesign, SammyGuru for the Galaxy Z Flip cover screen, Tech Build Africa for WhatsApp.
 */
export async function newsCoverage(item: Pick<Item, 'app' | 'headline' | 'sources' | 'published_at'>, fetchImpl: typeof fetch = fetch): Promise<PoolEntry[]> {
  const appWords = new Set(keyWords(item.app));
  const head = [...new Set(keyWords(item.headline).filter((w) => !appWords.has(w)))];
  const inTitles = new Set(item.sources.flatMap((s) => keyWords(s.title)));
  const words = [...head.filter((w) => inTitles.has(w)), ...head.filter((w) => !inTitles.has(w)).sort((a, b) => b.length - a.length)].slice(0, 3);
  if (words.length < 2) return [];
  let xml = '';
  try {
    xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(`${item.app} ${words.join(' ')}`)}+when:21d&hl=en-US&gl=US&ceid=US:en`, { fetchImpl, timeoutMs: 15_000 });
  } catch {
    return [];
  }
  const own = new Set(item.sources.map((s) => s.publisher.toLowerCase()));
  const listed = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: decodeEntities(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/ - [^-]+$/, ''),
    site: (m[1].match(/<source url="([^"]+)"/)?.[1] ?? '').replace(/\/$/, ''),
    source: decodeEntities(m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? ''),
    publishedAt: parseDate(m[1].match(/<pubDate>([^<]+)/)?.[1])?.toISOString() ?? null,
  }));
  // Only results about this story; then the real address from each site's news sitemap.
  // The search already named the app, so a result needn't repeat it ("Some Galaxy Z Flip users aren't impressed…"
  // is about Samsung); it still has to share the words that name the story.
  const same = relatedCoverage(item, listed.filter((l) => l.site && !own.has(l.source.toLowerCase())).map((l) => ({ ...l, url: `${l.site}#${l.title}`, app: item.app })), 6, 21 * 24);
  const found = await mapLimit(same, 4, async (r) => {
    const site = r.url.split('#')[0];
    const url = await fromNewsSitemap(site, r.title, fetchImpl);
    return url ? { ...r, url } : null;
  });
  return found.filter((f): f is PoolEntry => !!f).slice(0, 3);
}

const SITEMAPS = ['/news-sitemap.xml', '/sitemap-news.xml', '/sitemap_news.xml', '/news_sitemap.xml', '/sitemaps/news.xml'];
/** The address of the article with this headline in a site's news sitemap, if the site has one. */
async function fromNewsSitemap(site: string, title: string, fetchImpl: typeof fetch): Promise<string | null> {
  const want = keyWords(title);
  for (const path of SITEMAPS) {
    let body: string;
    try {
      body = await fetchText(site + path, { fetchImpl, timeoutMs: 12_000, maxBytes: 4_000_000 });
    } catch {
      continue;
    }
    if (/<sitemapindex/.test(body)) {
      const child = body.match(/<loc>([^<]+)<\/loc>/)?.[1];
      if (!child) continue;
      try {
        body = await fetchText(decodeEntities(child), { fetchImpl, timeoutMs: 12_000, maxBytes: 4_000_000 });
      } catch {
        continue;
      }
    }
    if (!/<urlset/.test(body)) continue;
    let best: { loc: string; score: number } | null = null;
    for (const u of body.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = decodeEntities(u[1].match(/<loc>([^<]+)/)?.[1] ?? '');
      const t = decodeEntities(u[1].match(/<news:title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/news:title>/)?.[1] ?? '');
      const have = new Set(keyWords(`${t} ${loc.replace(/[-/]/g, ' ')}`));
      const score = want.filter((w) => have.has(w)).length / Math.max(1, want.length);
      if (loc && (!best || score > best.score)) best = { loc, score };
    }
    return best && best.score >= 0.7 ? normalizeUrl(best.loc) : null;
  }
  return null;
}

/**
 * Pictures for the picture step: the item's own sources first, then other coverage of the same story. `credit`
 * adds the other site to an item's sources when its picture was the one chosen.
 */
export function withRelatedPictures(pool: PoolEntry[], getMeta: (url: string) => Promise<PageMeta | null>, search?: (item: Item) => Promise<PoolEntry[]>, forced = new Set<string>()) {
  const from = new Map<string, PoolEntry>();
  const picturesOf = (list: PoolEntry[]) =>
    Promise.all(
      list.map(async (r) => {
        const m = await getMeta(r.url);
        // The share picture gets no words of its own: the article's headline as its caption once made a cover
        // illustration pass for the "after" picture ("…what it looks like after the upgrade").
        const imgs: PageImage[] = [...(m?.image && !isStockImage(m.image) ? [{ src: m.image, alt: '', caption: '' }] : []), ...(m?.images ?? [])];
        for (const i of imgs) if (!from.has(i.src)) from.set(i.src, r);
        return imgs;
      }),
    );
  const imagesFor = async (item: Item): Promise<PageImage[][]> => {
    const own = await Promise.all(item.sources.map(async (s) => (await getMeta(s.url))?.images ?? []));
    const more = await picturesOf(relatedCoverage(item, pool));
    const all = [...own, ...more];
    // Nothing usable from the story's own sites or today's other coverage: search for earlier coverage.
    const usable = all.flat().some((i) => !isStockImage(i.src) && !oldUpload(i.src, item.published_at));
    const current = item.image && !isStockImage(item.image) && !oldUpload(item.image, item.published_at);
    if (((!usable && !current) || forced.has(item.id)) && search) all.push(...(await picturesOf(await search(item))));
    return all;
  };
  const credit = (items: Item[]): Item[] =>
    items.map((item) => {
      const used = [item.compare?.after, item.compare?.before, item.image].map((u) => (u ? from.get(u) : undefined)).find(Boolean);
      if (!used || item.sources.some((s) => s.url === used.url)) return item;
      return { ...item, sources: [...item.sources, { title: used.title, url: used.url, publisher: used.source }] };
    });
  return { imagesFor, credit };
}

/**
 * The whole picture step for a set of items, the same in the morning run and in `backfill-compare`:
 * 1. the item's own pages and other coverage read this run;
 * 2. for an item still without a picture: other sites found by search (WordPress search feeds, Google News with
 *    each site's news sitemap), and the step runs again for it;
 * 3. still nothing: the story is not publishable until an exact change image is found.
 */
/** A news card is publishable only with a picture of this change: one image, or the after side of a pair. */
export const hasChangePicture = (item: Pick<Item, 'image' | 'compare'>) => !!(item.compare?.after || item.image);

/** Every news card must pass this before the site is built. */
export const cardsWithoutChangePictures = (items: Item[]) => items.filter((item) => !hasChangePicture(item));

export async function pickPictures(opts: {
  cfg: Config;
  items: Item[];
  pool: PoolEntry[];
  getMeta: (url: string) => Promise<PageMeta | null>;
  llm: Llm | null;
  releaseShots: Map<string, {
    screenshot: string | null;
    screenshots?: string[];
    previousScreenshot: string | null;
    previousScreenshots?: string[];
    previousVersion: string | null;
  }>;
  /** Unset when finishing offline: no searching, and pictures are not checked to load. */
  fetchImpl?: typeof fetch;
}): Promise<CompareResult> {
  const { cfg, pool, getMeta, llm, releaseShots, fetchImpl } = opts;
  const forced = new Set<string>();
  const search = fetchImpl
    ? async (item: Item) => {
        const [wp, news] = await Promise.all([searchCoverage(item, fetchImpl), newsCoverage(item, fetchImpl)]);
        const seen = new Set<string>();
        return [...wp, ...news].filter((p) => !seen.has(p.source) && seen.add(p.source));
      }
    : undefined;
  const related = withRelatedPictures(pool, getMeta, search, forced);
  const first = await addCompares(cfg, opts.items, related.imagesFor, llm, releaseShots, fetchImpl);
  const notes = [...first.notes];
  let items = first.items;
  let usage = first.usage;
  const bare = (i: Item) => !hasChangePicture(i);
  if (search && items.some(bare)) {
    for (const i of items.filter(bare)) forced.add(i.id);
    const again = await addCompares(cfg, items.filter(bare), related.imagesFor, llm, releaseShots, fetchImpl);
    const byId = new Map(again.items.map((i) => [i.id, i]));
    items = items.map((i) => byId.get(i.id) ?? i);
    notes.push(...again.notes.map((n) => `${n} (after searching other sites)`));
    if (again.usage) usage = usage ? { ...usage, input_tokens: usage.input_tokens + again.usage.input_tokens, output_tokens: usage.output_tokens + again.usage.output_tokens, credits: (usage.credits ?? 0) + (again.usage.credits ?? 0) } : again.usage;
  }
  items = related.credit(items);
  // No generic fallback here. If no article shows the reported change, the item stays without a picture and the
  // caller must repair it from exact coverage or leave the story out. Store screenshots and app logos are not
  // evidence of this change.
  for (const i of items.filter(bare)) notes.push(`${i.id}: no verified picture of this change found; do not publish with a generic fallback`);
  return { items, usage, notes };
}
