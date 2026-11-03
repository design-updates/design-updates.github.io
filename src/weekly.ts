// What the weekly pages (AI workflows, Case studies) share: a pool of feed posts kept between runs, the week's key,
// reading each candidate's page, tidying the model's text, and the file of weeks.

import { readFeed, type FeedResult } from './feeds.ts';
import type { Feed } from './config.ts';
import { decodeEntities, fetchText, mapLimit, normalizeUrl, parseDate, readJson, stripHtml, truncate, writeJson } from './util.ts';

/** A post waiting to be judged. */
export interface PoolPost {
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  summary: string;
  content?: string;
  author?: string;
  image: string | null;
}

/** A pooled post with its full text, ready for the model. `cid` is its short id in the model call. */
export interface ReadPost extends PoolPost {
  cid: string;
  text: string;
  minutes: number | null;
}

export interface Dropped {
  title: string;
  url: string;
  source: string;
  reason: string;
  bulk?: boolean;
}

export interface Week<T> {
  /** Monday of the week, YYYY-MM-DD in the reader's time zone. */
  week: string;
  from: string;
  to: string;
  checked: number;
  picks: T[];
  collected_at: string;
}

export interface WeeksFile<T> {
  version: 1;
  updated_at: string | null;
  weeks: Week<T>[];
}

export const DAY = 86_400_000;

/** Monday of the week that `at` falls in, in `timeZone`. */
export function weekKey(at: Date, timeZone: string): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The readable text of an article page, plus its image and author when the page says. */
export function articleText(html: string): { text: string; image: string | null; author: string | null } {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))?.[1] ??
    null;
  // Some blogs (Discord) split one post into several <article> blocks, so all of them are read.
  const articles = [...html.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]).join(' ');
  const body = articles || (html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html);
  const text = stripHtml(body.replace(/<(nav|header|footer|aside|form|noscript|svg|figure)\b[\s\S]*?<\/\1>/gi, ' '));
  const image = meta('og:image');
  const author = meta('author') ?? meta('article:author');
  return { text: truncate(text, 8000), image: image ? decodeEntities(image) : null, author: author && !/^https?:/.test(author) ? decodeEntities(author) : null };
}

/** Reading time at 230 words a minute. Unknown when the text was cut short, since the post is longer than that. */
export const minutesOf = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words > 150 && text.length < 7900 ? Math.max(1, Math.round(words / 230)) : null;
};

export const HYPE = /\b(revolutionary|game[- ]changing|game[- ]changer|seamless(ly)?|powerful|unlock(s|ing)?|leverag(e|es|ing)|supercharge[sd]?|delve)\b/i;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/gu;
/** The model's text without emojis or exclamation marks, cut to `max`. Empty when it is not a string. */
export const clean = (s: unknown, max: number): string =>
  typeof s === 'string' ? truncate(s.replace(EMOJI, '').replace(/！+/g, '。').replace(/\.?!+(?=\s|$)/g, '.').trim(), max) : '';
export const orNull = (s: unknown, max: number) => clean(s, max) || null;

export class FeedsDownError extends Error {
  constructor(what: string) {
    super(`No ${what} feed could be read. Nothing written.`);
    this.name = 'FeedsDownError';
  }
}

/** Reads the feeds and adds new entries to the pool file. Entries older than `addDays` are skipped; pooled posts
    older than `keepDays` are let go. */
export async function poolFeeds(opts: {
  feeds: Feed[];
  path: string;
  now: Date;
  addDays: number;
  keepDays: number;
  what: string;
  fetchImpl: typeof fetch;
  dryRun?: boolean;
}): Promise<{ ok: number; failed: { name: string; error: string }[]; added: number; pool: Map<string, PoolPost> }> {
  const { now } = opts;
  const results: FeedResult[] = await mapLimit(opts.feeds, 6, (f) => readFeed(f, opts.fetchImpl));
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.feed.name, error: r.error ?? 'failed' }));
  if (opts.feeds.length && !ok.length) throw new FeedsDownError(opts.what);
  const pool = new Map<string, PoolPost>(readJson<PoolPost[]>(opts.path, []).map((p) => [p.url, p]));
  const before = pool.size;
  for (const r of ok) {
    for (const e of r.entries) {
      const at = parseDate(e.publishedAt);
      if (!at || now.getTime() - at.getTime() > opts.addDays * DAY || at.getTime() - now.getTime() > DAY) continue;
      const url = normalizeUrl(e.url);
      if (pool.has(url)) continue;
      pool.set(url, { url, title: e.title, source: r.feed.name, publishedAt: at.toISOString(), summary: e.summary, content: e.content, author: e.author, image: e.image });
    }
  }
  for (const [url, p] of pool) if (now.getTime() - Date.parse(p.publishedAt) > opts.keepDays * DAY) pool.delete(url);
  if (!opts.dryRun) writeJson(opts.path, [...pool.values()]);
  return { ok: ok.length, failed, added: pool.size - before, pool };
}

/** Each candidate's text: the feed's own copy when it carries the full post, else the page. Posts that only give
    a preview are dropped. Returned oldest first, with cids p1, p2, ... */
export async function readPosts(posts: PoolPost[], fetchImpl: typeof fetch, dropped: Dropped[]): Promise<ReadPost[]> {
  const read: ReadPost[] = [];
  await mapLimit(posts, 6, async (p) => {
    let text = p.content ?? '';
    let image = p.image;
    let author = p.author;
    if (text.length < 1500) {
      try {
        const page = articleText(await fetchText(p.url, { fetchImpl, timeoutMs: 15_000, maxBytes: 1_500_000 }));
        if (page.text.length > text.length) text = page.text;
        image ??= page.image;
        author ||= page.author ?? undefined;
      } catch {
        // Keep the feed's summary.
      }
    }
    if (text.length < 400) text = `${text} ${p.summary}`.trim();
    if (text.length < 300) {
      dropped.push({ title: p.title, url: p.url, source: p.source, reason: 'only a preview could be read (a member-only post, or the site blocks readers)' });
      return;
    }
    read.push({ ...p, cid: '', text, image, author, minutes: minutesOf(text) });
  });
  read.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  read.forEach((p, i) => (p.cid = `p${i + 1}`));
  return read;
}

/** Posts in the pool published in [from, to). */
export const countBetween = (pool: Map<string, PoolPost>, from: Date, to: Date) =>
  [...pool.values()].filter((p) => {
    const at = Date.parse(p.publishedAt);
    return at >= from.getTime() && at < to.getTime();
  }).length;

/** Gives picks with the same id a -2, -3 ending, so they don't collide on the page. */
export function uniqueIds<T extends { id: string }>(picks: T[], fallback: string) {
  const ids = new Set<string>();
  for (const w of picks) {
    const base = w.id || fallback;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    w.id = id;
  }
}

/** Puts the week first in the file (replacing a run of the same week), keeps a year, and remembers what was judged. */
export function saveWeek<T>(paths: { data: string; judged: string }, file: WeeksFile<T>, entry: Week<T>, judged: Set<string>, read: ReadPost[], now: Date) {
  file.weeks = [entry, ...file.weeks.filter((w) => w.week !== entry.week)].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 52);
  file.updated_at = now.toISOString();
  writeJson(paths.data, file);
  for (const p of read) judged.add(p.url);
  writeJson(paths.judged, [...judged].slice(-3000));
}
