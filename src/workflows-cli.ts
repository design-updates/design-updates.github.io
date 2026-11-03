// npm run workflows [-- --force] [--dry-run] [--data DIR] [--verbose]
// Adds today's posts to the pool; on the first run of a week, picks the week's AI workflow posts.
// Prints what was kept and what was dropped, with the reason for each. Saves the report to .cache/workflows-last.txt.

import { loadConfig } from './config.ts';
import { LlmUnavailableError } from './llm.ts';
import { pickLlm, reporter, weeklyArgs } from './weekly-cli.ts';
import { loadWorkflowsConfig, runWorkflows, workflowPaths, WorkflowFeedsDownError } from './workflows.ts';

const args = weeklyArgs('workflows', 'workflows.json');
const { dataDir } = args;
const cfg = loadConfig();
const wf = loadWorkflowsConfig();
if (!wf.enabled) {
  console.log('AI workflows are turned off (enabled: false in workflows.yaml).');
  process.exit(0);
}

const { out, dropped: printDropped, save } = reporter(args.verbose);

try {
  const r = await runWorkflows({
    cfg: wf,
    timeZone: cfg.timezone,
    model: cfg.models.curate,
    llm: args.dryRun ? null : pickLlm(cfg),
    now: new Date(),
    paths: workflowPaths(dataDir),
    force: args.force,
    dryRun: args.dryRun,
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
    if (!j.picks.length && !args.dryRun) out('  None good enough this week. The page shows a quiet week.');
    printDropped('Dropped by the model', j.modelDropped);
    printDropped('Dropped by the rules', j.preDropped);
    for (const w of j.warnings) out(`  warning: ${w}`);
    if (j.usage) out(`\nUsage: ${j.usage.model}  in ${j.usage.input_tokens}  out ${j.usage.output_tokens}${j.usage.credits != null ? `  company plan credits used: ${j.usage.credits}` : ''}`);
    if (args.dryRun) out('\nDry run: no model was called and nothing was written.');
    else out(`\nWrote ${dataDir}/workflows.json.`);
  }
  save('workflows');
} catch (err) {
  if (err instanceof WorkflowFeedsDownError || err instanceof LlmUnavailableError) {
    console.error(`Workflows run failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
