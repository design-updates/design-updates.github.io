// Case studies: a weekly pick of the most inspiring design case studies of shipped work from well-known companies.
// Every morning: read the feeds in casestudies.yaml and add new posts to a pool (.cache/cases-pool.json). Once a
// week, on the first run of the week: take the posts from the last two weeks that were not judged before, drop
// the obvious misses with rules, read each page, and ask the model for the few worth studying. Writes data/cases.json.
// Two weeks, not one, because company design blogs post a case study every few weeks, not every day.

import { existsSync, readFileSync } from 'node:fs';
import type { Feed } from './config.ts';
import type { Llm } from './llm.ts';
import { textOf, usageOf } from './llm.ts';
import { domainOf, parseDate, parseJsonLoose, readJson, slugify, truncate } from './util.ts';
import { parseYaml } from './yaml.ts';
import { CASES_SYSTEM } from './prompts.ts';
import type { CallUsage } from './types.ts';
import { clean, countBetween, DAY, HYPE, poolFeeds, readPosts, saveWeek, uniqueIds, weekKey, type Dropped, type PoolPost, type ReadPost, type Week, type WeeksFile } from './weekly.ts';

export interface CasesConfig {
  enabled: boolean;
  maxPicks: number;
  minScore: number;
  windowDays: number;
  feeds: Feed[];
}

export function parseCasesConfig(src: string): CasesConfig {
  const y = (parseYaml(src) ?? {}) as Record<string, unknown>;
  const feeds = (Array.isArray(y.feeds) ? y.feeds : []) as Record<string, unknown>[];
  return {
    enabled: y.enabled !== false,
    maxPicks: Number(y.max_picks) || 5,
    minScore: Number(y.min_score) || 7,
    windowDays: Number(y.window_days) || 14,
    feeds: feeds.filter((f) => f.url).map((f) => ({ name: String(f.name ?? f.url), url: String(f.url), kind: 'design' as const, app: null })),
  };
}

export const loadCasesConfig = (path = 'casestudies.yaml') => parseCasesConfig(existsSync(path) ? readFileSync(path, 'utf8') : 'enabled: false');

export type Area = 'product' | 'system' | 'brand' | 'research' | 'content';
export type Maker = 'team' | 'agency' | 'designer';
const AREAS: Area[] = ['product', 'system', 'brand', 'research', 'content'];
const MAKERS: Maker[] = ['team', 'agency', 'designer'];

export interface CaseZh {
  title: string;
  problem: string;
  approach: string;
  outcome: string;
  lesson: string;
}

export interface CaseStudy {
  id: string;
  title: string;
  post_title: string;
  url: string;
  source: string;
  domain: string;
  company: string;
  by: string | null;
  maker: Maker;
  area: Area;
  published_at: string;
  problem: string;
  approach: string;
  outcome: string;
  lesson: string;
  score: number;
  minutes: number | null;
  image: string | null;
  /** The company's own icon when the model knows its site, else the publisher's. */
  icon: string;
  zh: CaseZh | null;
}

export type CasesFile = WeeksFile<CaseStudy>;

/** Words that say a post is about design. Strong ones count 2. Engineering blogs mostly fail this, which is the point. */
const STRONG = /\b(redesign(ed|ing|s)?|rebrand(ed|ing|s)?|brand (identity|refresh)|visual identity|design system|case study|behind the design|UX|UI|user experience|user interface|user research|usability|interaction design|content design|product design(er|ers)?)\b/gi;
const WEAK = /\b(design(ed|ing|ers?)?|identity|logo|typeface|icons?|interface|prototyp\w*|accessib\w*|onboarding|experience|illustration|animation)\b/gi;
const NOT_A_CASE = /(^(q&a|design\/leader|[\w ]+ update):|\b(patch notes|interview|webinar|podcast|hiring|job openings?|newsletter|roundup|wallpapers|events guide|the outline|this week in|survey|giveaway|sponsored)\b)/i;
/** Titles mostly in another script (the Duolingo feed carries its posts in many languages). */
const NOT_LATIN = /[^\u0000-\u024F\u2000-\u206F\u2190-\u21FF\s]/gu;

const designHits = (s: string) => (s.match(STRONG) ?? []).length * 2 + (s.match(WEAK) ?? []).length;

export interface CasesPrefilterOut {
  kept: PoolPost[];
  dropped: Dropped[];
}

/** The posts that could be case studies, most design-heavy first, at most `max`. */
export function prefilterCases(posts: PoolPost[], ctx: { from: Date; to: Date; judged: Set<string>; max?: number }): CasesPrefilterOut {
  const dropped: Dropped[] = [];
  const drop = (p: PoolPost, reason: string, bulk = false) => dropped.push({ title: p.title, url: p.url, source: p.source, reason, bulk });
  const scored: [PoolPost, number][] = [];
  for (const p of posts) {
    const at = parseDate(p.publishedAt);
    if (!at || at < ctx.from || at >= ctx.to) {
      drop(p, 'not from the last two weeks', true);
      continue;
    }
    if (ctx.judged.has(p.url)) {
      drop(p, 'judged in an earlier week', true);
      continue;
    }
    if ((p.title.match(NOT_LATIN) ?? []).length > 3) {
      drop(p, 'not in English', true);
      continue;
    }
    const head = designHits(`${p.title} ${p.summary}`);
    const body = (p.content ?? '').match(STRONG)?.length ?? 0;
    if (!head && body < 4) {
      drop(p, 'not about design', true);
      continue;
    }
    if (NOT_A_CASE.test(p.title)) {
      drop(p, `not a case study ("${p.title.match(NOT_A_CASE)![0]}")`);
      continue;
    }
    scored.push([p, head * 3 + Math.min(body, 10)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const max = ctx.max ?? 40;
  for (const [p] of scored.slice(max)) drop(p, `more than ${max} candidates; less about design than the rest`);
  return { kept: scored.slice(0, max).map(([p]) => p), dropped };
}

/** "Koto (agency)": the maker label already says it. */
const MAKER_NOTE = /\s*\((agency|studio|in-house|team|designer)\)/gi;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const iconFor = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

export interface CasesJudgeResult {
  picks: CaseStudy[];
  dropped: Dropped[];
  usage: CallUsage;
  warnings: string[];
}

/** One model call: which posts are case studies worth studying, written up. Keeps the best `maxPicks`. */
export async function judgeCases(llm: Llm, model: string, posts: ReadPost[], cfg: { maxPicks: number; minScore: number }): Promise<CasesJudgeResult> {
  const input = {
    posts: posts.map((p) => ({ cid: p.cid, title: p.title, source: p.source, author: p.author ?? null, published: p.publishedAt.slice(0, 10), url: p.url, text: truncate(p.text, 3500) })),
  };
  const res = await llm.messages({ model, system: CASES_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 12_000 });
  const usage = usageOf('cases', model, res);
  const out = parseJsonLoose(textOf(res.content)) as { picks?: Record<string, unknown>[]; dropped?: { cid?: unknown; reason?: unknown }[] };
  const byCid = new Map(posts.map((p) => [p.cid, p]));
  const done = new Set<string>();
  const dropped: Dropped[] = [];
  const warnings: string[] = [];
  const drop = (p: ReadPost, reason: string) => {
    if (done.has(p.cid)) return;
    done.add(p.cid);
    dropped.push({ title: p.title, url: p.url, source: p.source, reason });
  };
  for (const d of out.dropped ?? []) {
    const p = typeof d.cid === 'string' ? byCid.get(d.cid) : undefined;
    if (p) drop(p, typeof d.reason === 'string' && d.reason ? d.reason : 'dropped by model');
  }

  const good: CaseStudy[] = [];
  for (const raw of out.picks ?? []) {
    const p = typeof raw.cid === 'string' ? byCid.get(raw.cid) : undefined;
    if (!p || done.has(p.cid)) continue;
    const score = Math.round(Number(raw.score) || 0);
    const title = clean(raw.title, 160);
    const company = clean(raw.company, 60);
    const problem = clean(raw.problem, 400);
    const approach = clean(raw.approach, 800);
    const outcome = clean(raw.outcome, 300);
    const lesson = clean(raw.lesson, 160);
    if (!title || !company || !problem || !approach || !outcome || !lesson) {
      drop(p, 'model write-up incomplete');
      continue;
    }
    if (score < cfg.minScore) {
      drop(p, `scored ${score}/10, below ${cfg.minScore}`);
      continue;
    }
    const z = raw.zh && typeof raw.zh === 'object' ? (raw.zh as Record<string, unknown>) : null;
    const zh: CaseZh | null =
      z && clean(z.title, 100) && clean(z.problem, 250) && clean(z.approach, 500)
        ? { title: clean(z.title, 100), problem: clean(z.problem, 250), approach: clean(z.approach, 500), outcome: clean(z.outcome, 200), lesson: clean(z.lesson, 100) }
        : null;
    if (!zh) warnings.push(`no Chinese write-up for "${truncate(title, 50)}"; the page shows English there`);
    for (const f of [title, problem, approach, outcome]) if (HYPE.test(f)) warnings.push(`hype word in "${truncate(title, 50)}": "${f.match(HYPE)![0]}"`);
    const domain = domainOf(p.url);
    const own = typeof raw.company_domain === 'string' ? raw.company_domain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() : '';
    good.push({
      id: slugify(title).slice(0, 60),
      title,
      post_title: truncate(p.title, 200),
      url: p.url,
      source: p.source,
      domain,
      company,
      by: clean(raw.by, 80).replace(MAKER_NOTE, '') || (p.author ? truncate(p.author, 80) : null),
      maker: MAKERS.includes(raw.maker as Maker) ? (raw.maker as Maker) : 'team',
      area: AREAS.includes(raw.area as Area) ? (raw.area as Area) : 'product',
      published_at: p.publishedAt,
      problem,
      approach,
      outcome,
      lesson,
      score: Math.min(10, score),
      minutes: p.minutes,
      image: p.image,
      icon: iconFor(DOMAIN.test(own) ? own : domain),
      zh,
    });
    done.add(p.cid);
  }
  good.sort((a, b) => b.score - a.score);
  const picks = good.slice(0, cfg.maxPicks);
  for (const c of good.slice(cfg.maxPicks)) dropped.push({ title: c.post_title, url: c.url, source: c.source, reason: `scored ${c.score}/10; the week's ${cfg.maxPicks} best scored higher` });
  for (const p of posts) if (!done.has(p.cid)) drop(p, 'model did not mention it');
  uniqueIds(picks, 'case');
  return { picks, dropped, usage, warnings };
}

export interface CasesPaths {
  data: string;
  pool: string;
  judged: string;
}

export const casesPaths = (dataDir = 'data', cache = '.cache'): CasesPaths => ({
  data: `${dataDir}/cases.json`,
  pool: `${cache}/cases-pool.json`,
  judged: `${cache}/cases-judged.json`,
});

export interface CasesReport {
  week: string;
  feeds: { ok: number; failed: { name: string; error: string }[] };
  added: number;
  pooled: number;
  /** Null when this run only pooled (the week's pick is already done). */
  judged: null | { checked: number; candidates: number; picks: CaseStudy[]; preDropped: Dropped[]; modelDropped: Dropped[]; warnings: string[]; usage: CallUsage | null };
}

export async function runCases(opts: {
  cfg: CasesConfig;
  timeZone: string;
  model: string;
  llm: Llm | null;
  now: Date;
  paths: CasesPaths;
  fetchImpl?: typeof fetch;
  /** Judge the week again even if it is already in cases.json. */
  force?: boolean;
  /** Read and filter, but call no model and write nothing. */
  dryRun?: boolean;
}): Promise<CasesReport> {
  const { cfg, now, paths } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Pool: today's feed entries join the posts already waiting.
  const span = cfg.windowDays;
  const { ok, failed, added, pool } = await poolFeeds({ feeds: cfg.feeds, path: paths.pool, now, addDays: span + 7, keepDays: span + 21, what: 'case study', fetchImpl, dryRun: opts.dryRun });

  const week = weekKey(now, opts.timeZone);
  const file = readJson<CasesFile>(paths.data, { version: 1, updated_at: null, weeks: [] });
  const report: CasesReport = { week, feeds: { ok, failed }, added, pooled: pool.size, judged: null };
  if (!opts.force && file.weeks.some((w) => w.week === week)) return report;

  // 2. The pick covers the last two weeks; posts judged in an earlier week are not judged again.
  const to = now;
  const from = new Date(now.getTime() - span * DAY);
  const judged = new Set(readJson<string[]>(paths.judged, []));
  if (opts.force) for (const w of file.weeks.filter((x) => x.week === week)) for (const p of w.picks) judged.delete(p.url);
  const pre = prefilterCases([...pool.values()], { from, to, judged });

  // 3. Read each candidate's text.
  const read = await readPosts(pre.kept, fetchImpl, pre.dropped);
  const checked = countBetween(pool, from, to);
  report.judged = { checked, candidates: read.length, picks: [], preDropped: pre.dropped, modelDropped: [], warnings: [], usage: null };
  if (opts.dryRun) return report;

  let picks: CaseStudy[] = [];
  if (read.length) {
    if (!opts.llm) throw new Error('No model available for the case-study pick.');
    const j = await judgeCases(opts.llm, opts.model, read, cfg);
    picks = j.picks;
    report.judged = { ...report.judged, picks, modelDropped: j.dropped, warnings: j.warnings, usage: j.usage };
  }

  const entry: Week<CaseStudy> = { week, from: from.toISOString(), to: to.toISOString(), checked, picks, collected_at: now.toISOString() };
  saveWeek(paths, file, entry, judged, read, now);
  return report;
}
