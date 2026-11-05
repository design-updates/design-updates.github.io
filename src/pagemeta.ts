// Reads an article page for its real publish date, og:image and site name.
// Search results often carry no date, or the date a page was last crawled; the page itself is the check.

import { decodeEntities, fetchText, parseDate } from './util.ts';

/** An image inside the article, with the words around it that say what it shows. */
export interface PageImage {
  src: string;
  alt: string;
  caption: string;
}

export interface PageMeta {
  publishedAt: string | null;
  image: string | null;
  siteName: string | null;
  title: string | null;
  /** og:description or the meta description. */
  description?: string | null;
  /** Up to 12 images from the article body, for finding a before/after pair. */
  images?: PageImage[];
}

// Site chrome, not article pictures. Not plain "logo": design articles are full of logo images.
const NOT_CONTENT = /((site|header|footer|nav|brand)[-_]?logo|favicon|avatar|author|gravatar|sprite|badge|emoji|pixel\.|tracking|spacer|placeholder|advert|banner-ad|\.svg($|\?)|data:image)/i;

const attrOf = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

/** The real picture behind lazy-loading markup: the largest srcset entry when it is a full-size one, else data-src
    or src. Future's sites (Android Central, TechRadar) list only 80–160px thumbnails in srcset, with the full picture in src. */
function imgSrc(tag: string): string | null {
  const plain = attrOf(tag, 'data-src') ?? attrOf(tag, 'data-lazy-src') ?? attrOf(tag, 'data-original') ?? attrOf(tag, 'src');
  const srcset = attrOf(tag, 'data-srcset') ?? attrOf(tag, 'srcset');
  if (srcset) {
    const best = srcset
      .split(',')
      .map((p) => p.trim().split(/\s+/))
      .map(([u, w]) => ({ u, w: Number.parseInt(w ?? '0', 10) || 0 }))
      .sort((a, b) => b.w - a.w)[0];
    if (best?.u && (best.w >= 600 || !plain || plain.startsWith('data:'))) return best.u;
  }
  return plain;
}

export function parseImages(html: string, pageUrl: string): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();
  const add = (tag: string, caption: string) => {
    const raw = imgSrc(tag);
    if (!raw || NOT_CONTENT.test(raw)) return;
    const w = Number(attrOf(tag, 'width'));
    if (w && w < 200) return;
    let src: string;
    try {
      src = new URL(raw, pageUrl).toString();
    } catch {
      return;
    }
    const key = src.replace(/[?#].*$/, '').replace(/-\d+x\d+(?=\.\w+$)/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ src, alt: (attrOf(tag, 'alt') ?? '').slice(0, 200), caption: caption.slice(0, 240) });
  };
  const body = html.slice(0, 600_000);
  for (const f of body.matchAll(/<figure\b[\s\S]*?<\/figure>/gi)) {
    const cap = f[0].match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] ?? '';
    const img = f[0].match(/<img\b[^>]*>/i)?.[0];
    if (img) add(img, decodeEntities(cap.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  }
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) add(m[0], '');
  return out.slice(0, 12);
}

const DATE_KEYS = ['article:published_time', 'og:published_time', 'datepublished', 'pubdate', 'publish-date', 'publishdate', 'date', 'dc.date', 'dc.date.issued', 'sailthru.date', 'parsely-pub-date'];

export function parsePageMeta(html: string, pageUrl: string): PageMeta {
  const head = html.slice(0, 400_000);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    const key = (t.match(/\s(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').toLowerCase();
    const content = t.match(/\scontent\s*=\s*("([^"]*)"|'([^']*)')/i);
    if (key && content && !meta.has(key)) meta.set(key, decodeEntities(content[2] ?? content[3] ?? ''));
  }

  let published: Date | null = null;
  for (const k of DATE_KEYS) {
    published = parseDate(meta.get(k));
    if (published) break;
  }
  if (!published) {
    const ld = head.match(/"datePublished"\s*:\s*"([^"]+)"/);
    published = parseDate(ld?.[1]);
  }
  if (!published) {
    const time = head.match(/<time\b[^>]*\sdatetime\s*=\s*["']([^"']+)["']/i);
    published = parseDate(time?.[1]);
  }
  // A <time> with only readable text, e.g. Trip.com's <time>Jul 21, 2026</time>. Only a full date with a year counts,
  // read as midday UTC so the day does not shift with the time zone.
  if (!published) {
    const text = head.match(/<time\b[^>]*>\s*([A-Z][a-z]{2,8}\.? \d{1,2}, 20\d\d|\d{1,2} [A-Z][a-z]{2,8}\.? 20\d\d)\s*<\/time>/)?.[1];
    if (text) published = parseDate(`${text.replace('.', '')} 12:00 UTC`);
  }

  let image = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src') ?? null;
  if (image) {
    try {
      image = new URL(image, pageUrl).toString();
    } catch {
      image = null;
    }
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    publishedAt: published ? published.toISOString() : null,
    image,
    siteName: meta.get('og:site_name') ?? null,
    title: meta.get('og:title') ?? (title ? decodeEntities(title.trim()) : null),
    description: meta.get('og:description') ?? meta.get('description') ?? meta.get('twitter:description') ?? null,
    images: parseImages(html, pageUrl),
  };
}

/** One retry after a pause: a page that fails right after the Mac wakes up usually loads a few seconds later. */
export async function fetchPageMeta(url: string, fetchImpl: typeof fetch = fetch, retryMs = 4000): Promise<PageMeta | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchText(url, { fetchImpl, timeoutMs: 15_000, maxBytes: 600_000 });
      return parsePageMeta(html, url);
    } catch (err) {
      // A page that answers with an error (403, 404) will answer the same way again.
      if (/^HTTP \d/.test((err as Error).message) || attempt) return null;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  return null;
}
