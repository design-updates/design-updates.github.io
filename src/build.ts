// npm run build: copies the static site and today's data into dist/ for GitHub Pages.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { iconAt16, mirrorAssets, mirrorUrls } from './mirror.ts';
import { emptyRadar } from './radar.ts';
import { readJson, writeJson } from './util.ts';
import { loadCasesConfig } from './casestudies.ts';
import type { WeeksFile } from './weekly.ts';
import { loadWorkflowsConfig } from './workflows.ts';

const cfg = loadConfig();
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/data', { recursive: true });
cpSync('site', 'dist', { recursive: true });
const mirrored = await mirrorAssets(readJson('data/radar.json', emptyRadar()), 'dist');
writeJson('dist/data/radar.json', mirrored.radar);
console.log(`Copied ${mirrored.saved} icons into the site${mirrored.failed ? ` (${mirrored.failed} could not be downloaded and load from their original address)` : ''}.`);
// The weekly pages, each only published while its yaml file has enabled: true. Their icons are copied into the site.
async function publishWeeks(file: string) {
  const data = readJson<WeeksFile<{ icon: string }>>(`data/${file}`, { version: 1, updated_at: null, weeks: [] });
  const { local } = await mirrorUrls(data.weeks.flatMap((w) => w.picks.map((p) => iconAt16(p.icon))), 'dist');
  for (const w of data.weeks) for (const p of w.picks) p.icon = local.get(iconAt16(p.icon)) ?? p.icon;
  writeJson(`dist/data/${file}`, data);
}
// AI workflows (trial) and case studies.
const workflowsOn = loadWorkflowsConfig().enabled;
if (workflowsOn) await publishWeeks('workflows.json');
const casesOn = loadCasesConfig().enabled;
if (casesOn) await publishWeeks('cases.json');
// Page settings the site needs from watchlist.yaml: the name in the greeting and the category labels.
writeJson('dist/data/meta.json', {
  reader: cfg.reader,
  timezone: cfg.timezone,
  feeds: cfg.feeds.length,
  search: cfg.provider === 'anthropic' && cfg.models.searchesPerGroup > 0 && cfg.groups.some((g) => g.search.length),
  ai: cfg.provider === 'gemini' ? 'Gemini' : 'Claude',
  categories: Object.fromEntries(cfg.groups.map((g) => [g.category, g.label])),
  workflows: workflowsOn,
  cases: casesOn,
});
// Browsers keep styles.css and app.js for up to 10 minutes. A version tag that changes with the file makes them
// fetch the new one straight after a publish.
const version = (file: string) => createHash('sha1').update(readFileSync(`site/${file}`)).digest('hex').slice(0, 10);
writeFileSync(
  'dist/index.html',
  readFileSync('site/index.html', 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${version('styles.css')}"`)
    .replace('src="app.js"', `src="app.js?v=${version('app.js')}"`),
);
writeFileSync('dist/.nojekyll', '');
console.log('Built dist/');
