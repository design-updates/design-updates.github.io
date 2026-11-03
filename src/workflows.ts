// AI workflows: a weekly pick of posts in which designers show how they actually use AI in their work.
// Every morning: read the feeds in workflows.yaml and add new posts to a pool (.cache/workflows-pool.json), because
// some feeds only hold a day or two. Once a week, on the first run of the week: take the week's posts, drop the
// obvious misses with rules, read each page, and ask the model for the few worth copying. Writes data/workflows.json.

import { existsSync, readFileSync } from 'node:fs';
import type { Feed } from './config.ts';
import type { Llm } from './llm.ts';
import { textOf, usageOf } from './llm.ts';
import { domainOf, parseDate, parseJsonLoose, readJson, slugify, truncate } from './util.ts';
import { parseYaml } from './yaml.ts';
import { WORKFLOWS_SYSTEM } from './prompts.ts';
import type { CallUsage } from './types.ts';
import { clean, countBetween, DAY, HYPE, orNull, poolFeeds, readPosts, saveWeek, uniqueIds, weekKey, type Dropped, type PoolPost, type ReadPost, type Week, type WeeksFile } from './weekly.ts';

export { articleText, weekKey, FeedsDownError as WorkflowFeedsDownError, type PoolPost } from './weekly.ts';

export interface WorkflowsConfig {
  enabled: boolean;
  maxPicks: number;
  minScore: number;
  feeds: Feed[];
}

export function parseWorkflowsConfig(src: string): WorkflowsConfig {
  const y = (parseYaml(src) ?? {}) as Record<string, unknown>;
  const feeds = (Array.isArray(y.feeds) ? y.feeds : []) as Record<string, unknown>[];
  return {
    enabled: y.enabled !== false,
    maxPicks: Number(y.max_picks) || 5,
    minScore: Number(y.min_score) || 7,
    feeds: feeds.filter((f) => f.url).map((f) => ({ name: String(f.name ?? f.url), url: String(f.url), kind: 'design' as const, app: null })),
  };
}

export const loadWorkflowsConfig = (path = 'workflows.yaml') => parseWorkflowsConfig(existsSync(path) ? readFileSync(path, 'utf8') : 'enabled: false');

export type Stage = 'research' | 'ideas' | 'ux' | 'ui' | 'prototyping' | 'systems' | 'handoff' | 'brand' | 'team';
export type WfType = 'workflow' | 'technique' | 'tool' | 'study';
const STAGES: Stage[] = ['research', 'ideas', 'ux', 'ui', 'prototyping', 'systems', 'handoff', 'brand', 'team'];
const TYPES: WfType[] = ['workflow', 'technique', 'tool', 'study'];

export interface WorkflowZh {
  title: string;
  process: string;
  result: string;
  catch: string | null;
  try_if: string;
}

export interface Workflow {
  id: string;
  title: string;
  post_title: string;
  url: string;
  source: string;
  domain: string;
  author: string | null;
  author_role: string | null;
  published_at: string;
  tools: string[];
  stage: Stage;
  type: WfType;
  process: string;
  result: string;
  catch: string | null;
  try_if: string;
  score: number;
  minutes: number | null;
  image: string | null;
  icon: string;
  zh: WorkflowZh | null;
}

export type WorkflowWeek = Week<Workflow>;
export type WorkflowsFile = WeeksFile<Workflow>;
export type WfDropped = Dropped;

/** AI words and tool names. Posts with none of these in the title or summary are not about AI. Tool names are
    matched with their capitals, so "the cursor" or "a bolt" in a design post does not count. */
const AI_NAMES =
  /\b(AI|A\.I\.|LLMs?|GPT(-?\d[\w.]*)?|ChatGPT|Claude|Gemini|Copilot|Cursor|Midjourney|Firefly|Stable Diffusion|DALL[·-]?E|v0|Lovable|Bolt\.new|Replit|Windsurf|Figma Make|FigJam AI|Galileo|Uizard|Relume|MCP)\b/g;
const AI_WORDS = /\b(prompt(s|ing|ed)?|agentic|AI agents?|vibe[- ]cod(e|ed|ing)|generative|gen ?AI|machine learning|large language models?)\b/gi;
const LISTICLE = /^\s*(top\s+)?(\d{1,2}|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+(best\s+|free\s+|essential\s+|must[- ]have\s+|powerful\s+|ai\s+)*(ai\s+)?(tools|apps|plugins|prompts|ways|tips|websites|resources|alternatives|examples|things|reasons|mistakes|trends)\b/i;
const NOT_A_POST = /\b(webinar|course|bootcamp|hiring|we're hiring|job opening|giveaway|sponsored|press release|newsletter #?\d+|weekly digest|link roundup|this week in)\b/i;

const aiHits = (s: string) => (s.match(AI_NAMES) ?? []).length + (s.match(AI_WORDS) ?? []).length;

export interface PrefilterOut {
  kept: PoolPost[];
  dropped: WfDropped[];
}

/** The week's posts that could be AI workflow posts, most AI-heavy first, at most `max`. */
export function prefilterWorkflows(posts: PoolPost[], ctx: { from: Date; to: Date; judged: Set<string>; max?: number }): PrefilterOut {
  const dropped: WfDropped[] = [];
  const drop = (p: PoolPost, reason: string, bulk = false) => dropped.push({ title: p.title, url: p.url, source: p.source, reason, bulk });
  const scored: [PoolPost, number][] = [];
  for (const p of posts) {
    const at = parseDate(p.publishedAt);
    if (!at || at < ctx.from || at >= ctx.to) {
      drop(p, 'not from this week', true);
      continue;
    }
    if (ctx.judged.has(p.url)) {
      drop(p, 'judged in an earlier week', true);
      continue;
    }
    const head = aiHits(`${p.title} ${p.summary}`);
    const body = aiHits(p.content ?? '');
    if (!head && body < 3) {
      drop(p, 'not about AI', true);
      continue;
    }
    if (LISTICLE.test(p.title)) {
      drop(p, 'listicle');
      continue;
    }
    if (NOT_A_POST.test(p.title)) {
      drop(p, `not a workflow post ("${p.title.match(NOT_A_POST)![0]}")`);
      continue;
    }
    scored.push([p, head * 3 + Math.min(body, 15)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const max = ctx.max ?? 40;
  for (const [p] of scored.slice(max)) drop(p, `more than ${max} candidates; fewer AI mentions than the rest`);
  return { kept: scored.slice(0, max).map(([p]) => p), dropped };
}

export interface JudgeResult {
  picks: Workflow[];
  dropped: WfDropped[];
  usage: CallUsage;
  warnings: string[];
}

/** One model call: which of the week's posts are worth copying, written up. Keeps the best `maxPicks`. */
export async function judgeWeek(llm: Llm, model: string, posts: ReadPost[], cfg: { maxPicks: number; minScore: number }): Promise<JudgeResult> {
  const input = {
    posts: posts.map((p) => ({ cid: p.cid, title: p.title, source: p.source, author: p.author ?? null, published: p.publishedAt.slice(0, 10), url: p.url, text: truncate(p.text, 3500) })),
  };
  const res = await llm.messages({ model, system: WORKFLOWS_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 12_000 });
  const usage = usageOf('workflows', model, res);
  const out = parseJsonLoose(textOf(res.content)) as { picks?: Record<string, unknown>[]; dropped?: { cid?: unknown; reason?: unknown }[] };
  const byCid = new Map(posts.map((p) => [p.cid, p]));
  const done = new Set<string>();
  const dropped: WfDropped[] = [];
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

  const good: Workflow[] = [];
  for (const raw of out.picks ?? []) {
    const p = typeof raw.cid === 'string' ? byCid.get(raw.cid) : undefined;
    if (!p || done.has(p.cid)) continue;
    const score = Math.round(Number(raw.score) || 0);
    const title = clean(raw.title, 160);
    const process = clean(raw.process, 800);
    const result = clean(raw.result, 300);
    const tryIf = clean(raw.try_if, 160);
    if (!title || !process || !result || !tryIf) {
      drop(p, 'model write-up incomplete');
      continue;
    }
    if (score < cfg.minScore) {
      drop(p, `scored ${score}/10, below ${cfg.minScore}`);
      continue;
    }
    const z = raw.zh && typeof raw.zh === 'object' ? (raw.zh as Record<string, unknown>) : null;
    const zh: WorkflowZh | null =
      z && clean(z.title, 100) && clean(z.process, 500)
        ? { title: clean(z.title, 100), process: clean(z.process, 500), result: clean(z.result, 200), catch: orNull(z.catch, 200), try_if: clean(z.try_if, 100) }
        : null;
    if (!zh) warnings.push(`no Chinese write-up for "${truncate(title, 50)}"; the page shows English there`);
    for (const f of [title, process, result]) if (HYPE.test(f)) warnings.push(`hype word in "${truncate(title, 50)}": "${f.match(HYPE)![0]}"`);
    const domain = domainOf(p.url);
    good.push({
      id: slugify(title).slice(0, 60),
      title,
      post_title: truncate(p.title, 200),
      url: p.url,
      source: p.source,
      domain,
      author: orNull(raw.author, 80) ?? (p.author ? truncate(p.author, 80) : null),
      author_role: orNull(raw.author_role, 100),
      published_at: p.publishedAt,
      tools: (Array.isArray(raw.tools) ? raw.tools : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => clean(x, 30)).slice(0, 5),
      stage: STAGES.includes(raw.stage as Stage) ? (raw.stage as Stage) : 'ux',
      type: TYPES.includes(raw.type as WfType) ? (raw.type as WfType) : 'workflow',
      process,
      result,
      catch: orNull(raw.catch, 300),
      try_if: tryIf,
      score: Math.min(10, score),
      minutes: p.minutes,
      image: p.image,
      icon: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
      zh,
    });
    done.add(p.cid);
  }
  good.sort((a, b) => b.score - a.score);
  const picks = good.slice(0, cfg.maxPicks);
  for (const w of good.slice(cfg.maxPicks)) dropped.push({ title: w.post_title, url: w.url, source: w.source, reason: `scored ${w.score}/10; the week's ${cfg.maxPicks} best scored higher` });
  for (const p of posts) if (!done.has(p.cid)) drop(p, 'model did not mention it');
  uniqueIds(picks, 'workflow');
  return { picks, dropped, usage, warnings };
}

export interface WorkflowPaths {
  data: string;
  pool: string;
  judged: string;
}

export const workflowPaths = (dataDir = 'data', cache = '.cache'): WorkflowPaths => ({
  data: `${dataDir}/workflows.json`,
  pool: `${cache}/workflows-pool.json`,
  judged: `${cache}/workflows-judged.json`,
});

export interface WorkflowsReport {
  week: string;
  feeds: { ok: number; failed: { name: string; error: string }[] };
  added: number;
  pooled: number;
  /** Null when this run only pooled (the week's pick is already done). */
  judged: null | { checked: number; candidates: number; picks: Workflow[]; preDropped: WfDropped[]; modelDropped: WfDropped[]; warnings: string[]; usage: CallUsage | null };
}

export async function runWorkflows(opts: {
  cfg: WorkflowsConfig;
  timeZone: string;
  model: string;
  llm: Llm | null;
  now: Date;
  paths: WorkflowPaths;
  fetchImpl?: typeof fetch;
  /** Judge the week again even if it is already in workflows.json. */
  force?: boolean;
  /** Read and filter, but call no model and write nothing. */
  dryRun?: boolean;
}): Promise<WorkflowsReport> {
  const { cfg, now, paths } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Pool: today's feed entries join the posts already waiting.
  const { ok, failed, added, pool } = await poolFeeds({ feeds: cfg.feeds, path: paths.pool, now, addDays: 14, keepDays: 21, what: 'workflow', fetchImpl, dryRun: opts.dryRun });

  const week = weekKey(now, opts.timeZone);
  const file = readJson<WorkflowsFile>(paths.data, { version: 1, updated_at: null, weeks: [] });
  const report: WorkflowsReport = { week, feeds: { ok, failed }, added, pooled: pool.size, judged: null };
  if (!opts.force && file.weeks.some((w) => w.week === week)) return report;

  // 2. The week's pick covers the 7 days before this run.
  const to = now;
  const from = new Date(now.getTime() - 7 * DAY);
  const judged = new Set(readJson<string[]>(paths.judged, []));
  if (opts.force) for (const w of file.weeks.filter((x) => x.week === week)) for (const p of w.picks) judged.delete(p.url);
  const pre = prefilterWorkflows([...pool.values()], { from, to, judged });

  // 3. Read each candidate's text.
  const read = await readPosts(pre.kept, fetchImpl, pre.dropped);
  const checked = countBetween(pool, from, to);
  report.judged = { checked, candidates: read.length, picks: [], preDropped: pre.dropped, modelDropped: [], warnings: [], usage: null };
  if (opts.dryRun) return report;

  let picks: Workflow[] = [];
  if (read.length) {
    if (!opts.llm) throw new Error('No model available for the workflow pick.');
    const j = await judgeWeek(opts.llm, opts.model, read, cfg);
    picks = j.picks;
    report.judged = { ...report.judged, picks, modelDropped: j.dropped, warnings: j.warnings, usage: j.usage };
  }

  saveWeek(paths, file, { week, from: from.toISOString(), to: to.toISOString(), checked, picks, collected_at: now.toISOString() }, judged, read, now);
  return report;
}
