// Other coverage of the same story. A change usually reaches several sites; when the one the model kept blocks
// readers (Android Authority) or shows only a stock photo, another site's article about the same change can supply
// the picture. That site is then listed as a source too, so the picture is credited.

import { isStockImage, oldUpload } from './compare.ts';
import type { Config } from './config.ts';
import type { PageImage, PageMeta } from './pagemeta.ts';
import { matchApp } from './prefilter.ts';
import type { Candidate, Item } from './types.ts';
import { readFeed } from './feeds.ts';
import { hoursAgo, normalizeUrl, onDomain, parseDate } from './util.ts';

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
 * Pictures for the picture step: the item's own sources first, then other coverage of the same story. `credit`
 * adds the other site to an item's sources when its picture was the one chosen.
 */
export function withRelatedPictures(pool: PoolEntry[], getMeta: (url: string) => Promise<PageMeta | null>, search?: (item: Item) => Promise<PoolEntry[]>) {
  const from = new Map<string, PoolEntry>();
  const picturesOf = (list: PoolEntry[]) =>
    Promise.all(
      list.map(async (r) => {
        const m = await getMeta(r.url);
        const imgs: PageImage[] = [...(m?.image && !isStockImage(m.image) ? [{ src: m.image, alt: r.title, caption: '' }] : []), ...(m?.images ?? [])];
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
    if (!usable && !current && search) all.push(...(await picturesOf(await search(item))));
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
