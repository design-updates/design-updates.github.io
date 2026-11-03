import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 AppChangeRadar/0.1';

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|smid|guccounter|taid|partner)$/i;

/** Same article, same string: lowercase host, no www., no tracking parameters, no #hash, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    u.protocol = 'https:';
    return u.toString().replace(/\/+$/, '').replace(/\/\?/, '?');
  } catch {
    return raw.trim();
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** "news.airbnb.com" is on "airbnb.com". */
export function onDomain(domain: string, list: string[]): string | null {
  return list.find((d) => domain === d || domain.endsWith(`.${d}`)) ?? null;
}

/** YYYY-MM-DD for a moment in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const t = raw.trim();
  // Bare dates ("2026-10-28") are read as the start of that day in UTC.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

export function hoursAgo(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 3_600_000;
}

export function ago(from: Date, now: Date): string {
  const h = hoursAgo(from, now);
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Writes through a temp file so a crash never leaves half a JSON file behind. */
export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Pulls the JSON object out of a model reply, tolerating ```json fences or a sentence around it. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error(`model reply was not JSON: ${t.slice(0, 200)}`);
  }
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    hellip: '…', zwnj: '', zwj: '', shy: '', mdash: '—', ndash: '–', middot: '·', bull: '•', trade: '™', reg: '®', copy: '©', eacute: 'é',
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export function stripHtml(s: string): string {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Some feeds escape their HTML (&lt;p&gt;); decode once so those tags are stripped too.
  if (/&lt;\/?[a-z]/i.test(t)) t = decodeEntities(t);
  return decodeEntities(t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/<[^>]*$/, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchText(url: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch; maxBytes?: number } = {}): Promise<string> {
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return opts.maxBytes ? text.slice(0, opts.maxBytes) : text;
}
