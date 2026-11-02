// npm run workflows [-- --force] [--dry-run] [--data DIR] [--verbose]
// Adds today's posts to the pool; on the first run of a week, picks the week's AI workflow posts.
// Prints what was kept and what was dropped, with the reason for each. Saves the report to .cache/workflows-last.txt.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { apiLlm, companyLlm, companyLogin, LlmUnavailableError, type Llm } from './llm.ts';
import { truncate } from './util.ts';
import { loadWorkflowsConfig, runWorkflows, workflowPaths, WorkflowFeedsDownError, type WfDropped } from './workflows.ts';

const argv = process.argv.slice(2);
const dataAt = argv.indexOf('--data');
const dataDir = dataAt >= 0 ? argv.splice(dataAt, 2)[1] : 'data';
const args = new Set(argv);
for (const a of args) {
  if (!['--force', '--dry-run', '--verbose', '--help'].includes(a)) {
    console.error(`Unknown option ${a}. Try --help.`);
    process.exit(2);
  }
}
if (args.has('--help')) {
  console.log(`npm run workflows -- [options]
  --force     pick this week's posts again, even if it is already done
  --dry-run   read feeds and apply the rules, but call no model and write nothing
  --data DIR  write workflows.json to DIR instead of data/ (for trying things out)
  --verbose   list every dropped post, including old and off-topic ones`);
  process.exit(0);
}

const cfg = loadConfig();
const wf = loadWorkflowsConfig();
if (!wf.enabled) {
  console.log('AI workflows are turned off (enabled: false in workflows.yaml).');
  process.exit(0);
}

function pickLlm(): Llm | null {
  if (cfg.provider === 'company') {
    const login = companyLogin();
    return login ? companyLlm(login) : null;
  }
  return process.env.ANTHROPIC_API_KEY ? apiLlm(process.env.ANTHROPIC_API_KEY) : null;
}

const lines: string[] = [];
const out = (s = '') => {
  lines.push(s);
  console.log(s);
};
function printDropped(title: string, list: WfDropped[]) {
  if (!list.length) return;
  out(`\n${title} (${list.length})`);
  const each = args.has('--verbose') ? list : list.filter((d) => !d.bulk);
  for (const d of each) out(`  - ${truncate(d.title, 90)}  [${d.source}]\n      ${d.reason}`);
  if (!args.has('--verbose')) {
    const counts = new Map<string, number>();
    for (const d of list.filter((x) => x.bulk)) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
    for (const [reason, n] of counts) out(`  - ${n} × ${reason}  (--verbose to list them)`);
  }
}

try {
  const r = await runWorkflows({
    cfg: wf,
    timeZone: cfg.timezone,
    model: cfg.models.curate,
    llm: args.has('--dry-run') ? null : pickLlm(),
    now: new Date(),
    paths: workflowPaths(dataDir),
    force: args.has('--force'),
    dryRun: args.has('--dry-run'),
  });
  out(`AI workflows · week of ${r.week}`);
  out(`Feeds: ${r.feeds.ok} of ${r.feeds.ok + r.feeds.failed.length} read${r.feeds.failed.length ? ` (failed: ${r.feeds.failed.map((f) => f.name).join(', ')})` : ''}. ${r.added} new posts; ${r.pooled} in the pool.`);
  if (!r.judged) {
    out("This week's pick is already done. Posts were added to the pool for next week.");
  } else {
    const j = r.judged;
    out(`Posts from the last 7 days: ${j.checked}. After the rules: ${j.candidates} read in full and judged.`);
    out(`\nPicked (${j.picks.length})`);
    for (const p of j.picks) {
      out(`  ${p.score}/10  ${p.title}`);
      out(`        ${p.source}${p.author ? ` · ${p.author}` : ''}${p.author_role ? `, ${p.author_role}` : ''} · ${p.tools.join(', ')} · ${p.stage} · ${p.type}`);
      out(`        ${p.url}`);
    }
    if (!j.picks.length && !args.has('--dry-run')) out('  None good enough this week. The page shows a quiet week.');
    printDropped('Dropped by the model', j.modelDropped);
    printDropped('Dropped by the rules', j.preDropped);
    for (const w of j.warnings) out(`  warning: ${w}`);
    if (j.usage) out(`\nUsage: ${j.usage.model}  in ${j.usage.input_tokens}  out ${j.usage.output_tokens}${j.usage.credits != null ? `  company plan credits used: ${j.usage.credits}` : ''}`);
    if (args.has('--dry-run')) out('\nDry run: no model was called and nothing was written.');
    else out(`\nWrote ${dataDir}/workflows.json.`);
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/workflows-last.txt', `${lines.join('\n')}\n`);
} catch (err) {
  if (err instanceof WorkflowFeedsDownError || err instanceof LlmUnavailableError) {
    console.error(`Workflows run failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
