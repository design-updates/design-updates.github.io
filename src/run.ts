// One collection run: feeds + store version notes + search → rule checks → one model call → before/after pictures
// (a second, small call) → radar.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { addCompares } from './compare.ts';
import { curate } from './curate.ts';
import { feedCandidates, readFeed, type FeedResult } from './feeds.ts';
import { ensureIcons } from './icons.ts';
import type { Llm } from './llm.ts';
import { fetchPageMeta, type PageMeta } from './pagemeta.ts';
import { prefilter } from './prefilter.ts';
import { emptyRadar, mergeDay, recentItems, recordSeen, seenUrls } from './radar.ts';
import { searchGroup, type SearchResult } from './search.ts';
import { checkStores, emptyStores, type StoreState, type StoresResult } from './stores.ts';
import type { CallUsage, Candidate, Dropped, Item, Radar, Seen } from './types.ts';
import { hoursAgo, localDate, mapLimit, parseDate, readJson, writeJson } from './util.ts';

export interface Paths {
  radar: string;
  seen: string;
  runs: string;
  icons: string;
  /** Last version seen in each store, per app. */
  stores: string;
  cache: string;
}

export const defaultPaths = (dir = 'data'): Paths => ({
  radar: join(dir, 'radar.json'),
  seen: join(dir, 'seen.json'),
  runs: join(dir, 'runs.json'),
  icons: join(dir, 'icons.json'),
  stores: join(dir, 'stores.json'),
  cache: '.cache',
});

export interface CollectOptions {
  cfg: Config;
  now: Date;
  llm: Llm | null;
  fetchImpl?: typeof fetch;
  paths: Paths;
  dryRun?: boolean;
  noSearch?: boolean;
  /** Read sources and page details, save them to .cache, and stop: no model, nothing written to data/. */
  gatherOnly?: boolean;
  /** Reuse the sources saved by an earlier --gather-only run instead of reading the network. */
  fromCache?: boolean;
}

export interface Report {
  date: string;
  mode: string;
  feeds: { ok: number; failed: { name: string; error: string }[]; entries: number };
  search: { ran: boolean; skippedReason?: string; groups: { group: string; ok: boolean; error?: string; found: number }[] };
  stores: { ran: boolean; ok: boolean; error?: string; read: number; newVersions: number; passed: number; skipped: StoresResult['skipped'] };
  candidates: number;
  sentToModel: Candidate[];
  preDropped: Dropped[];
  modelDropped: Dropped[];
  kept: Item[];
  added: Item[];
  pattern: string | null;
  quiet: boolean;
  dayExisted: boolean;
  usage: CallUsage[];
  costUsd: number;
  warnings: string[];
  wrote: boolean;
}

export class SourcesDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesDownError';
  }
}

/** Everything a run read from the network, so a manual-mode run can finish offline. */
interface Snapshot {
  date: string;
  /** When the sources were read. A manual-mode rerun uses this as "now" so the saved question is rebuilt exactly. */
  at?: string;
  feeds: Report['feeds'];
  search: Report['search'];
  candidates: Candidate[];
  preDropped: Dropped[];
  total: number;
  usage: CallUsage[];
  /** Page details for every candidate, by URL. */
  pages: Record<string, PageMeta | null>;
  stores?: Report['stores'];
  /** Store versions read this run, saved to data/stores.json once the run is written. */
  storeState?: StoreState;
}

export function costOf(cfg: Config, usage: CallUsage[]): number {
  let usd = 0;
  for (const u of usage) {
    const p = cfg.prices[u.model];
    if (p) usd += (u.input_tokens * p.input + u.output_tokens * p.output) / 1_000_000;
    usd += (u.web_searches * cfg.webSearchPer1000) / 1000;
  }
  return Math.round(usd * 10_000) / 10_000;
}

async function gather(opts: CollectOptions, seen: Seen): Promise<Snapshot> {
  const { cfg, now, llm } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const date = localDate(now, cfg.timezone);

  const searchOff = opts.noSearch
    ? 'turned off with --no-search'
    : !llm
      ? 'no model configured'
      : !llm.canSearch
        ? llm.mode === 'company'
          ? 'the company plan has no working web search'
          : llm.mode === 'gemini'
            ? 'Google Search is not free on current Gemini models'
            : 'manual mode has no web search'
        : cfg.models.searchesPerGroup <= 0
          ? 'searches_per_group is 0'
          : null;

  const storeState = readJson<StoreState>(opts.paths.stores, emptyStores());
  const storesOn = cfg.stores.appStore || cfg.stores.googlePlay;
  const [feedResults, searchResults, storeResult] = await Promise.all([
    mapLimit(cfg.feeds, 6, (f) => readFeed(f, fetchImpl)) as Promise<FeedResult[]>,
    searchOff ? Promise.resolve([] as SearchResult[]) : Promise.all(cfg.groups.filter((g) => g.search.length).map((g) => searchGroup(cfg, g, llm!, now))),
    storesOn ? checkStores(cfg, storeState, now, fetchImpl) : Promise.resolve(null),
  ]);

  const fromSearch = searchResults.flatMap((r) => r.candidates);
  const pages: Snapshot['pages'] = {};
  // Search dates are checked against the page itself: the page's own publish date wins.
  await mapLimit(fromSearch, 6, async (c) => {
    const meta = await fetchPageMeta(c.url, fetchImpl);
    pages[c.url] = meta;
    if (meta?.publishedAt) c.publishedAt = meta.publishedAt;
    if (meta?.image) c.image = meta.image;
    if (meta?.siteName && c.source === c.domain) c.source = meta.siteName;
  });

  const all = [...feedCandidates(cfg, feedResults), ...fromSearch, ...(storeResult?.candidates ?? [])];
  const { kept, dropped } = prefilter(cfg, all, { now, seenUrls: seenUrls(seen) });
  // Page details for what the model will see (og:image, real publish date, article pictures), fetched once here.
  // Store listings are skipped: their notes and screenshots are already in hand.
  await mapLimit(
    kept.filter((c) => !(c.url in pages) && !c.release),
    6,
    async (c) => {
      pages[c.url] = await fetchPageMeta(c.url, fetchImpl);
    },
  );
  return {
    date,
    at: now.toISOString(),
    feeds: {
      ok: feedResults.filter((r) => r.ok).length,
      failed: feedResults.filter((r) => !r.ok).map((r) => ({ name: r.feed.name, error: r.error ?? 'failed' })),
      entries: feedResults.reduce((n, r) => n + r.entries.length, 0),
    },
    search: {
      ran: !searchOff,
      skippedReason: searchOff ?? undefined,
      groups: searchResults.map((r) => ({ group: r.group, ok: r.ok, error: r.error, found: r.candidates.length })),
    },
    candidates: kept,
    preDropped: dropped,
    total: all.length,
    usage: searchResults.flatMap((r) => r.usage),
    pages,
    stores: storeResult
      ? {
          ran: true,
          ok: storeResult.ok,
          error: storeResult.error,
          read: Object.keys(storeResult.latest.appStore).length + Object.keys(storeResult.latest.googlePlay).length,
          newVersions: storeResult.candidates.length + storeResult.skipped.length,
          passed: storeResult.candidates.length,
          skipped: storeResult.skipped,
        }
      : { ran: false, ok: true, read: 0, newVersions: 0, passed: 0, skipped: [] },
    storeState: storeResult?.latest,
  };
}

/** Re-reads each kept item's page: real og:image, and a last check that the story is not an old one re-dated by a feed. */
async function postCheck(cfg: Config, items: Item[], now: Date, getMeta: (url: string) => Promise<PageMeta | null>): Promise<{ items: Item[]; dropped: Dropped[] }> {
  const dropped: Dropped[] = [];
  const checked = await mapLimit(items, 4, async (item) => {
    for (const s of item.sources) {
      const meta = await getMeta(s.url);
      if (!meta) continue;
      const pageDate = parseDate(meta.publishedAt);
      if (pageDate && hoursAgo(pageDate, now) > cfg.windowHours + 24) {
        dropped.push({ title: item.headline, url: s.url, source: s.publisher, reason: `page says it was published ${meta.publishedAt!.slice(0, 10)}, outside the window` });
        return null;
      }
      return { ...item, image: meta.image ?? item.image };
    }
    return item;
  });
  return { items: checked.filter((i): i is Item => i !== null), dropped };
}

export async function collect(opts: CollectOptions): Promise<Report> {
  const { cfg, llm, paths } = opts;
  let now = opts.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const date = localDate(now, cfg.timezone);
  const radar = readJson<Radar>(paths.radar, emptyRadar());
  const seen = readJson<Seen>(paths.seen, { events: {} });

  // Manual mode answers a saved question, so it reuses the sources saved for that day instead of reading
  // the network again (feeds change by the hour, and the question must stay the same).
  const snapPath = join(paths.cache, `candidates-${date}.json`);
  if (opts.fromCache && !existsSync(snapPath)) throw new Error(`No saved sources for ${date} in ${paths.cache}. Run with --gather-only first.`);
  const offline = !opts.gatherOnly && existsSync(snapPath) && (opts.fromCache || llm?.mode === 'manual');
  let snap: Snapshot;
  if (offline) {
    snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
    if (snap.at) now = new Date(snap.at);
    // Days in between may have reported some of these since the snapshot was taken.
    const urls = seenUrls(seen);
    const fresh = snap.candidates.filter((c) => !urls.has(c.url));
    for (const c of snap.candidates) if (urls.has(c.url)) snap.preDropped.push({ title: c.title, url: c.url, source: c.source, reason: 'already reported on an earlier day' });
    snap.candidates = fresh.map((c, i) => ({ ...c, cid: `c${i + 1}` }));
  } else {
    snap = await gather(opts, seen);
    if ((llm?.mode === 'manual' || opts.gatherOnly) && !opts.dryRun) {
      mkdirSync(paths.cache, { recursive: true });
      writeFileSync(snapPath, JSON.stringify(snap, null, 2));
    }
  }

  const report: Report = {
    date,
    mode: opts.dryRun ? 'dry run' : opts.gatherOnly ? 'gather only' : `${llm?.mode ?? 'none'}${offline ? ', saved sources' : ''}`,
    feeds: snap.feeds,
    search: snap.search,
    stores: snap.stores ?? { ran: false, ok: true, read: 0, newVersions: 0, passed: 0, skipped: [] },
    candidates: snap.total,
    sentToModel: snap.candidates,
    preDropped: snap.preDropped,
    modelDropped: [],
    kept: [],
    added: [],
    pattern: null,
    quiet: false,
    dayExisted: radar.days[0]?.date === date,
    usage: [...snap.usage],
    costUsd: 0,
    warnings: [],
    wrote: false,
  };

  if (snap.feeds.ok === 0 && !snap.search.groups.some((g) => g.ok)) {
    throw new SourcesDownError(`No source could be read (${snap.feeds.failed.length} feeds failed${snap.search.ran ? ', search failed' : ''}). Nothing written; a quiet day would be a lie.`);
  }
  if (opts.dryRun || opts.gatherOnly) return report;
  if (!llm) throw new Error('no model configured');

  let items: Item[] = [];
  let pattern: string | null = null;
  let pattern_zh: string | null = null;
  if (snap.candidates.length) {
    const icons = offline ? readJson<Record<string, string | null>>(paths.icons, {}) : await ensureIcons(cfg, paths.icons, { fetchImpl });
    const result = await curate(cfg, llm, snap.candidates, { now, recent: recentItems(radar, date), seen, icons });
    report.usage.push(result.usage);
    report.warnings.push(...result.warnings);
    // A page that could not be read while gathering is tried once more now, for the kept items' pictures.
    const getMeta = async (url: string) => (offline || snap.pages[url] ? (snap.pages[url] ?? null) : (snap.pages[url] = await fetchPageMeta(url, fetchImpl)));
    const post = await postCheck(cfg, result.items, now, getMeta);
    // Before/after: App Store screenshots for version-note items, article pictures for the rest.
    const byUrl = new Map(snap.candidates.map((c) => [c.url, c]));
    const releaseShots = new Map<string, { before: string | null; after: string | null; beforeVersion: string | null }>();
    for (const item of post.items) {
      const rel = item.sources.map((s) => byUrl.get(s.url)?.release).find(Boolean);
      if (rel) releaseShots.set(item.id, { before: rel.previousScreenshot ?? null, after: rel.screenshot ?? null, beforeVersion: rel.previousVersion ?? null });
    }
    const imagesFor = async (item: Item) => Promise.all(item.sources.map(async (s) => (await getMeta(s.url))?.images ?? []));
    const cmp = await addCompares(cfg, post.items, imagesFor, llm, releaseShots, fetchImpl);
    if (cmp.usage) report.usage.push(cmp.usage);
    report.warnings.push(...cmp.notes.map((n) => `before/after: ${n}`));
    items = cmp.items;
    pattern = result.pattern;
    pattern_zh = result.pattern_zh;
    report.modelDropped = [...result.dropped, ...post.dropped];
  }

  const merged = mergeDay(radar, { date, items, pattern, pattern_zh, now });
  writeJson(paths.radar, merged.radar);
  writeJson(paths.seen, recordSeen(seen, merged.added));
  if (snap.storeState && !offline) writeJson(paths.stores, snap.storeState);
  report.kept = items;
  report.added = merged.added;
  report.pattern = merged.day.pattern;
  report.quiet = merged.day.quiet;
  report.costUsd = costOf(cfg, report.usage);
  report.wrote = true;

  const runs = readJson<unknown[]>(paths.runs, []);
  runs.push({
    at: now.toISOString(),
    date,
    mode: report.mode,
    feeds_ok: snap.feeds.ok,
    feeds_failed: snap.feeds.failed.map((f) => f.name),
    candidates: snap.total,
    sent_to_model: snap.candidates.length,
    kept: items.length,
    added: merged.added.length,
    usage: report.usage,
    cost_usd: report.costUsd,
  });
  writeJson(paths.runs, runs.slice(-400));
  return report;
}
