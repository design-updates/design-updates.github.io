// The one model call per run that decides what is worth the reader's time and writes it up.
// The model's answer is checked here; anything malformed is dropped with a reason, never shown.

import { appByName, type Config } from './config.ts';
import { textOf, usageOf, type Llm } from './llm.ts';
import { CURATE_SYSTEM } from './prompts.ts';
import { CATEGORIES, KINDS, type CallUsage, type Candidate, type Category, type Dropped, type Item, type ItemZh, type Kind, type Seen } from './types.ts';
import { localDate, parseJsonLoose, slugify, truncate } from './util.ts';

export interface RecentItem {
  event_id: string;
  app: string;
  date: string;
  headline: string;
}

export interface CurateResult {
  items: Item[];
  dropped: Dropped[];
  pattern: string | null;
  pattern_zh: string | null;
  usage: CallUsage;
  warnings: string[];
}

const HYPE = /\b(revolutionary|game[- ]changing|game[- ]changer|seamless(ly)?|exciting|powerful|robust|leverag(e|es|ing)|unlock(s|ing)?|delve|cutting[- ]edge|best[- ]in[- ]class|supercharge[sd]?)\b/i;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/gu;

const clean = (s: unknown, max: number): string =>
  typeof s === 'string' ? truncate(s.replace(EMOJI, '').replace(/\.?!+(?=\s|$)/g, '.'), max) : '';

/** Chinese text: same clean-up, with full-width exclamation marks turned into full stops too. */
const cleanZh = (s: unknown, max: number): string => (typeof s === 'string' ? clean(s.replace(/！+/g, '。'), max) : '');

function zhOf(raw: unknown): ItemZh | null {
  if (!raw || typeof raw !== 'object') return null;
  const z = raw as Record<string, unknown>;
  const out = { headline: cleanZh(z.headline, 120), what: cleanZh(z.what, 400), why: cleanZh(z.why, 260) };
  return out.headline && out.what && out.why ? out : null;
}

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Headline words, for spotting the same event written two ways. */
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
export function similar(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

// Generic news grammar is removed; simple plurals are folded together. This makes a focused follow-up headline a
// subset of a broader rollout ("Phone gets a gradient icon" vs "gradient icons for Messages, Phone and Contacts").
const EVENT_STOP = new Set('the and for with its this that from into onto over under after before latest new adds added adding gets got getting is are was were be being been app apps application applications update updates updated updating rollout rolls rolling rolled test tests tested testing beta android ios mobile now starts started starting brings brought introducing introduces introduced'.split(' '));
const eventWords = (s: string) => {
  const out = new Set<string>();
  for (let word of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (EVENT_STOP.has(word)) continue;
    if (word.endsWith('ies') && word.length > 4) word = `${word.slice(0, -3)}y`;
    else if (word.endsWith('s') && word.length > 4 && !word.endsWith('ss')) word = word.slice(0, -1);
    out.add(word);
  }
  return out;
};

/** The same design event, including one product from a previously-reported multi-product rollout. */
export function sameDesignEvent(a: string, b: string): boolean {
  const x = eventWords(a);
  const y = eventWords(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.75;
}

export function buildCurateInput(cfg: Config, candidates: Candidate[], recent: RecentItem[], now: Date) {
  return {
    today: localDate(now, cfg.timezone),
    window: { from: new Date(now.getTime() - cfg.windowHours * 3_600_000).toISOString(), to: now.toISOString() },
    // Each app with the names that count as it, so sub-brands (Vrbo for Expedia) are not dropped as off-list.
    watchlist: Object.fromEntries(cfg.groups.map((g) => [g.category, Object.fromEntries(g.apps.map((a) => [a.name, a.aliases]))])),
    recently_reported: recent,
    candidates: candidates.map((c) => ({
      cid: c.cid,
      app: c.app,
      title: c.title,
      source: c.source,
      trust: c.trust,
      published_at: c.publishedAt,
      url: c.url,
      summary: truncate(c.summary, c.release ? 900 : 300),
      ...(c.release ? { version_notes: `${c.release.store === 'app-store' ? 'App Store' : 'Google Play'} ${c.release.version}` } : {}),
    })),
  };
}

/** Store and version, when the item came from an app's own version notes. */
function releaseOf(sources: Candidate[]): Item['release'] {
  const r = sources.find((c) => c.release)?.release;
  return r ? { store: r.store, version: r.version } : null;
}

type RawItem = {
  event_id?: unknown;
  app?: unknown;
  category?: unknown;
  domain?: unknown;
  kind?: unknown;
  beta?: unknown;
  importance?: unknown;
  headline?: unknown;
  what?: unknown;
  why?: unknown;
  zh?: unknown;
  source_cids?: unknown;
};

export async function curate(
  cfg: Config,
  llm: Llm,
  candidates: Candidate[],
  ctx: { now: Date; recent: RecentItem[]; seen: Seen; icons: Record<string, string | null> },
): Promise<CurateResult> {
  const input = buildCurateInput(cfg, candidates, ctx.recent, ctx.now);
  const res = await llm.messages({
    model: cfg.models.curate,
    system: CURATE_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    // English and Chinese for every item.
    maxTokens: 16_000,
  });
  const usage = usageOf('curate', cfg.models.curate, res);
  const out = parseJsonLoose(textOf(res.content)) as { items?: RawItem[]; dropped?: { cid?: unknown; reason?: unknown }[]; pattern?: unknown; pattern_zh?: unknown };

  const byCid = new Map(candidates.map((c) => [c.cid, c]));
  const accounted = new Set<string>();
  const dropped: Dropped[] = [];
  const warnings: string[] = [];
  const items: Item[] = [];
  const dropCandidate = (c: Candidate, reason: string) => {
    accounted.add(c.cid);
    dropped.push({ title: c.title, url: c.url, source: c.source, reason });
  };

  for (const d of out.dropped ?? []) {
    const c = typeof d.cid === 'string' ? byCid.get(d.cid) : undefined;
    if (c && !accounted.has(c.cid)) dropCandidate(c, typeof d.reason === 'string' && d.reason ? d.reason : 'dropped by model');
  }

  const recentSeen = Object.entries(ctx.seen.events);
  for (const raw of out.items ?? []) {
    const cids = (Array.isArray(raw.source_cids) ? raw.source_cids : []).filter((x): x is string => typeof x === 'string' && byCid.has(x));
    const srcs = cids.map((cid) => byCid.get(cid)!);
    // A watchlist app, or another well-known brand the model named (design news is not limited to the watchlist).
    const listed = typeof raw.app === 'string' ? appByName(cfg, raw.app) : undefined;
    const brand = listed?.name ?? clean(raw.app, 40);
    const category: Category = listed?.category ?? (CATEGORIES.includes(raw.category as Category) ? (raw.category as Category) : 'consumer');
    const domain = typeof raw.domain === 'string' && DOMAIN.test(raw.domain.trim()) ? raw.domain.trim().toLowerCase().replace(/^www\./, '') : null;
    const kind: Kind | null = KINDS.includes(raw.kind as Kind) ? (raw.kind as Kind) : null;
    const headline = clean(raw.headline, 220);
    const what = clean(raw.what, 700);
    const why = clean(raw.why, 450);
    const fail = (reason: string) => srcs.forEach((c) => !accounted.has(c.cid) && dropCandidate(c, reason));
    if (!srcs.length) {
      warnings.push(`model returned "${headline || 'an item'}" with no valid sources; skipped`);
      continue;
    }
    if (!brand) {
      fail('model did not name the app or brand');
      continue;
    }
    if (!headline || !what || !why) {
      fail('model write-up incomplete');
      continue;
    }
    // Extra syndicated copies beyond the first two still count as handled.
    srcs.sort((a, b) => (a.trust === b.trust ? 0 : a.trust === 'company' ? -1 : 1));
    const kept = srcs.slice(0, 2);
    const extra = srcs.slice(2);

    const id = slugify(typeof raw.event_id === 'string' && raw.event_id ? raw.event_id : `${brand} ${headline}`);
    const repeat =
      ctx.seen.events[id] ??
      recentSeen.find(([, e]) => e.app === brand && similar(e.headline, headline) >= 0.8)?.[1] ??
      recentSeen.find(([, e]) => sameDesignEvent(e.headline, headline))?.[1] ??
      recentSeen.find(([, e]) => e.urls.some((u) => kept.some((k) => k.url === u)))?.[1];
    if (repeat) {
      fail(`already reported on ${repeat.date} ("${truncate(repeat.headline, 60)}")`);
      continue;
    }
    if (items.some((i) => i.id === id)) {
      fail(`duplicate of ${id}`);
      continue;
    }

    for (const c of kept) accounted.add(c.cid);
    for (const c of extra) dropCandidate(c, `syndicated copy of ${id}`);
    for (const field of [headline, what, why]) if (HYPE.test(field)) warnings.push(`hype word in ${id}: "${field.match(HYPE)![0]}"`);
    const zh = zhOf(raw.zh);
    if (!zh) warnings.push(`no Chinese write-up for ${id}; the page shows English there`);

    const published = kept.map((c) => c.publishedAt!).sort()[0];
    items.push({
      id,
      app: brand,
      category,
      kind,
      date: localDate(new Date(published), cfg.timezone),
      published_at: published,
      beta: raw.beta === true,
      importance: Math.min(5, Math.max(1, Math.round(Number(raw.importance) || 2))),
      headline,
      what,
      why,
      sources: kept.map((c) => ({ title: c.title, url: c.url, publisher: c.source })),
      release: releaseOf(kept),
      image: kept.find((c) => c.image)?.image ?? null,
      icon: (listed && ctx.icons[listed.name]) || (domain ? favicon(domain) : null),
      collected_at: ctx.now.toISOString(),
      zh,
    });
  }

  for (const c of candidates) if (!accounted.has(c.cid)) dropCandidate(c, 'not mentioned by the model');

  const pattern = items.length && typeof out.pattern === 'string' && out.pattern.trim() ? clean(out.pattern, 300) : null;
  const pattern_zh = pattern && typeof out.pattern_zh === 'string' && out.pattern_zh.trim() ? cleanZh(out.pattern_zh, 200) : null;
  return { items, dropped, pattern, pattern_zh, usage, warnings };
}
