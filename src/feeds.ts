// RSS 2.0 and Atom parsing with regular expressions. Feeds are small and regular enough that this
// is reliable, and it keeps the project free of npm packages.

import type { Config, Feed } from './config.ts';
import { fetchPageMeta } from './pagemeta.ts';
import type { Candidate } from './types.ts';
import { decodeEntities, domainOf, fetchText, mapLimit, normalizeUrl, parseDate, stripHtml, truncate } from './util.ts';

export interface FeedEntry {
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
  image: string | null;
  /** The full post text, when the feed carries it (Medium and Substack feeds do). Up to 8000 characters. */
  content?: string;
  /** dc:creator, or the Atom author's name. */
  author?: string;
}

const tag =(block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
};

const attr = (tagText: string, name: string): string | null => {
  const m = tagText.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

const cdata = (s: string | null): string => (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

function firstImage(block: string, html: string): string | null {
  for (const re of [/<media:content\b[^>]*>/gi, /<media:thumbnail\b[^>]*>/gi, /<enclosure\b[^>]*>/gi]) {
    for (const m of block.matchAll(re)) {
      const url = attr(m[0], 'url');
      const type = attr(m[0], 'type') ?? attr(m[0], 'medium') ?? '';
      if (url && (!type || /image/i.test(type))) return url;
    }
  }
  const img = html.match(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return img ? decodeEntities(img[1]) : null;
}

export function parseFeed(xml: string, base: string): FeedEntry[] {
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(xml) || (!/<item\b/i.test(xml) && /<entry\b/i.test(xml));
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const out: FeedEntry[] = [];
  for (const b of blocks) {
    const title = stripHtml(cdata(tag(b, 'title')));
    let url = '';
    if (isAtom) {
      const links = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
      const alt = links.find((l) => !attr(l, 'rel') || attr(l, 'rel') === 'alternate') ?? links[0];
      url = alt ? (attr(alt, 'href') ?? '') : '';
    } else {
      url = cdata(tag(b, 'link'));
      if (!url) {
        const guid = b.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/i);
        if (guid && !/isPermaLink\s*=\s*["']false/i.test(guid[1])) url = cdata(guid[2]);
      }
    }
    // Some feeds (Fast Company) encode & twice, so decode until nothing changes.
    url = url.trim();
    for (let i = 0; i < 3 && /&(amp|#38);/i.test(url); i++) url = decodeEntities(url);
    url = decodeEntities(url);
    if (!title || !url) continue;
    try {
      url = new URL(url, base).toString();
    } catch {
      continue;
    }
    const dateRaw = isAtom
      ? (tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'issued'))
      : (tag(b, 'pubDate') ?? tag(b, 'dc:date') ?? tag(b, 'published') ?? tag(b, 'updated'));
    const date = parseDate(cdata(dateRaw));
    const html = cdata(isAtom ? (tag(b, 'summary') ?? tag(b, 'content')) : (tag(b, 'description') ?? tag(b, 'content:encoded')));
    const encoded = cdata(tag(b, 'content:encoded') ?? tag(b, 'content') ?? '');
    const full = stripHtml(encoded.length > html.length ? encoded : html);
    const author = truncate(stripHtml(cdata(tag(b, 'dc:creator') ?? tag(tag(b, 'author') ?? '', 'name') ?? '')), 80);
    out.push({
      title,
      url,
      publishedAt: date ? date.toISOString() : null,
      summary: truncate(stripHtml(html), 400),
      image: firstImage(b, `${html}${encoded}`),
      ...(full.length > 600 ? { content: truncate(full, 8000) } : {}),
      ...(author ? { author } : {}),
    });
  }
  return out;
}

export interface FeedResult {
  feed: Feed;
  ok: boolean;
  error?: string;
  entries: FeedEntry[];
}

/** Pages and files that are never articles, whatever the pattern says. */
const NOT_ARTICLE = /\.(css|js|json|png|jpe?g|gif|svg|webp|ico|xml|pdf|woff2?)(\?|$)|\/(page|tag|category|author|feed|search)\//i;

/**
 * The article links on a newsroom page: links (or paths written in the page's script data, for pages built in the
 * browser) on the same site whose path matches the pattern, in page order, newest first on most newsrooms.
 */
export function pageLinks(html: string, pageUrl: string, pattern: RegExp, max = 12): string[] {
  const base = new URL(pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  // href="…", unquoted data-href=… (Trip.com), and quoted paths inside script data.
  for (const m of html.matchAll(/(?:href\s*=\s*["']?|["'(\s])((?:https?:\/\/[a-z0-9.-]+)?\/[^"'()\s<>]*)/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    const path = u.pathname;
    if (!pattern.test(path) || NOT_ARTICLE.test(path) || path === base.pathname) continue;
    const url = normalizeUrl(`${u.origin}${path}`);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** A newsroom page as feed entries: each article link, read for its title, date, summary and picture. */
async function readPage(feed: Feed, fetchImpl: typeof fetch): Promise<FeedResult> {
  const html = await fetchText(feed.url, { fetchImpl, timeoutMs: 20_000, maxBytes: 2_000_000 });
  const links = pageLinks(html, feed.url, feed.page!);
  if (!links.length) return { feed, ok: false, error: 'no article links matched on the page', entries: [] };
  const entries = (
    await mapLimit(links, 4, async (url): Promise<FeedEntry | null> => {
      const meta = await fetchPageMeta(url, fetchImpl);
      if (!meta?.title) return null;
      return { title: truncate(stripHtml(meta.title), 300), url, publishedAt: meta.publishedAt, summary: truncate(stripHtml(meta.description ?? ''), 400), image: meta.image };
    })
  ).filter((e): e is FeedEntry => !!e);
  // Every article failing usually means the site is refusing this reader for now; say so rather than look empty.
  if (!entries.length) return { feed, ok: false, error: `found ${links.length} articles but could not read any`, entries: [] };
  return { feed, ok: true, entries };
}

export async function readFeed(feed: Feed, fetchImpl: typeof fetch = fetch): Promise<FeedResult> {
  try {
    if (feed.page) return await readPage(feed, fetchImpl);
    const xml = await fetchText(feed.url, { fetchImpl, timeoutMs: 20_000 });
    if (!/<(rss|feed|rdf:RDF)\b/i.test(xml)) return { feed, ok: false, error: 'not an RSS or Atom feed', entries: [] };
    return { feed, ok: true, entries: parseFeed(xml, feed.url) };
  } catch (err) {
    return { feed, ok: false, error: (err as Error).message, entries: [] };
  }
}

export function feedCandidates(cfg: Config, results: FeedResult[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of results) {
    for (const e of r.entries) {
      out.push({
        cid: '',
        title: e.title,
        url: normalizeUrl(e.url),
        source: r.feed.name,
        domain: domainOf(e.url),
        publishedAt: e.publishedAt,
        summary: e.summary,
        image: e.image,
        via: 'feed',
        feedDomain: domainOf(r.feed.url),
        trust: r.feed.kind === 'company' ? 'company' : 'outlet',
        app: r.feed.app,
        ...(r.feed.kind === 'design' ? { design: true } : {}),
      });
    }
  }
  return out;
}
