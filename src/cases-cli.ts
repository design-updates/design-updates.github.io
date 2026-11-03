// npm run cases [-- --force] [--dry-run] [--data DIR] [--verbose]
// Adds today's posts to the pool; on the first run of a week, picks the week's case studies.
// Prints what was kept and what was dropped, with the reason for each. Saves the report to .cache/cases-last.txt.

import { loadConfig } from './config.ts';
import { LlmUnavailableError } from './llm.ts';
import { casesPaths, loadCasesConfig, runCases } from './casestudies.ts';
import { FeedsDownError } from './weekly.ts';
import { pickLlm, reporter, weeklyArgs } from './weekly-cli.ts';

const args = weeklyArgs('cases', 'cases.json');
const cfg = loadConfig();
const cs = loadCasesConfig();
if (!cs.enabled) {
  console.log('Case studies are turned off (enabled: false in casestudies.yaml).');
  process.exit(0);
}

const { out, dropped, save } = reporter(args.verbose);

try {
  const r = await runCases({
    cfg: cs,
    timeZone: cfg.timezone,
    model: cfg.models.curate,
    llm: args.dryRun ? null : pickLlm(cfg),
    now: new Date(),
    paths: casesPaths(args.dataDir),
    force: args.force,
    dryRun: args.dryRun,
  });
  out(`Case studies · week of ${r.week}`);
  out(`Feeds: ${r.feeds.ok} of ${r.feeds.ok + r.feeds.failed.length} read${r.feeds.failed.length ? ` (failed: ${r.feeds.failed.map((f) => f.name).join(', ')})` : ''}. ${r.added} new posts; ${r.pooled} in the pool.`);
  if (!r.judged) {
    out("This week's pick is already done. Posts were added to the pool for next week.");
  } else {
    const j = r.judged;
    out(`Posts from the last ${cs.windowDays} days: ${j.checked}. After the rules: ${j.candidates} read in full and judged.`);
    out(`\nPicked (${j.picks.length})`);
    for (const p of j.picks) {
      out(`  ${p.score}/10  ${p.title}`);
      out(`        ${p.company} · ${p.by ?? '?'} (${p.maker}) · ${p.area} · ${p.source}`);
      out(`        ${p.url}`);
    }
    if (!j.picks.length && !args.dryRun) out('  None good enough this week. The page shows a quiet week.');
    dropped('Dropped by the model', j.modelDropped);
    dropped('Dropped by the rules', j.preDropped);
    for (const w of j.warnings) out(`  warning: ${w}`);
    if (j.usage) out(`\nUsage: ${j.usage.model}  in ${j.usage.input_tokens}  out ${j.usage.output_tokens}${j.usage.credits != null ? `  company plan credits used: ${j.usage.credits}` : ''}`);
    if (args.dryRun) out('\nDry run: no model was called and nothing was written.');
    else out(`\nWrote ${args.dataDir}/cases.json.`);
  }
  save('cases');
} catch (err) {
  if (err instanceof FeedsDownError || err instanceof LlmUnavailableError) {
    console.error(`Case studies run failed: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
