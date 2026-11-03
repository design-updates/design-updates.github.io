// What `npm run workflows` and `npm run cases` share: options, the model, and the report of kept and dropped posts.

import { mkdirSync, writeFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { apiLlm, companyLlm, companyLogin, type Llm } from './llm.ts';
import { truncate } from './util.ts';
import type { Dropped } from './weekly.ts';

export interface WeeklyArgs {
  dataDir: string;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
}

/** Reads the options; prints help and exits for --help, and exits on an unknown option. */
export function weeklyArgs(command: string, file: string): WeeklyArgs {
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
    console.log(`npm run ${command} -- [options]
  --force     pick this week's posts again, even if it is already done
  --dry-run   read feeds and apply the rules, but call no model and write nothing
  --data DIR  write ${file} to DIR instead of data/ (for trying things out)
  --verbose   list every dropped post, including old and off-topic ones`);
    process.exit(0);
  }
  return { dataDir, force: args.has('--force'), dryRun: args.has('--dry-run'), verbose: args.has('--verbose') };
}

export function pickLlm(cfg: Config): Llm | null {
  if (cfg.provider === 'company') {
    const login = companyLogin();
    return login ? companyLlm(login) : null;
  }
  return process.env.ANTHROPIC_API_KEY ? apiLlm(process.env.ANTHROPIC_API_KEY) : null;
}

/** Prints lines as they come and saves them all to .cache/<name>-last.txt at the end. */
export function reporter(verbose: boolean) {
  const lines: string[] = [];
  const out = (s = '') => {
    lines.push(s);
    console.log(s);
  };
  const dropped = (title: string, list: Dropped[]) => {
    if (!list.length) return;
    out(`\n${title} (${list.length})`);
    const each = verbose ? list : list.filter((d) => !d.bulk);
    for (const d of each) out(`  - ${truncate(d.title, 90)}  [${d.source}]\n      ${d.reason}`);
    if (!verbose) {
      const counts = new Map<string, number>();
      for (const d of list.filter((x) => x.bulk)) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
      for (const [reason, n] of counts) out(`  - ${n} × ${reason}  (--verbose to list them)`);
    }
  };
  const save = (name: string) => {
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/${name}-last.txt`, `${lines.join('\n')}\n`);
  };
  return { out, dropped, save };
}
