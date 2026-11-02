// RSS 2.0 and Atom parsing with regular expressions. Feeds are small and regular enough that this
// is reliable, and it keeps the project free of npm packages.

import type { Config, Feed } from './config.ts';
import type { Candidate } from './types.ts';
import { decodeEntities, domainOf, fetchText, normalizeUrl, parseDate, stripHtml, truncate } from './util.ts';

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
    url = decodeEntities(url.trim());
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

export async function readFeed(feed: Feed, fetchImpl: typeof fetch = fetch): Promise<FeedResult> {
  try {
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
