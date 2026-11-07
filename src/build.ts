// npm run build: copies the static site and today's data into dist/ for GitHub Pages.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { iconAt16, iconLarge, mirrorAssets, mirrorUrls } from './mirror.ts';
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
console.log(`Copied ${mirrored.saved} pictures and icons into the site${mirrored.failed ? ` (${mirrored.failed} could not be downloaded and keep their original address)` : ''}.`);
// The weekly pages, each only published while its yaml file has enabled: true. Their icons are copied into the site.
async function publishWeeks(file: string) {
  const data = readJson<WeeksFile<{ icon: string; icon_large?: string; image?: string | null }>>(`data/${file}`, { version: 1, updated_at: null, weeks: [] });
  const { local } = await mirrorUrls(data.weeks.flatMap((w) => w.picks.flatMap((p) => [iconAt16(p.icon), iconLarge(p.icon), ...(p.image ? [p.image] : [])])), 'dist');
  for (const w of data.weeks)
    for (const p of w.picks) {
      p.icon_large = local.get(iconLarge(p.icon)) ?? iconLarge(p.icon);
      p.icon = local.get(iconAt16(p.icon)) ?? p.icon;
      if (p.image) p.image = local.get(p.image) ?? p.image;
    }
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
// Browsers keep styles.css and the scripts for up to 10 minutes. A version tag that changes with the files makes
// them fetch the new ones straight after a publish. The scripts share one tag, so app.js and the games files it
// loads never mix an old and a new copy.
const hash = (...parts: (string | Buffer)[]) => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 10);
};
const scripts = readdirSync('site').filter((f) => f.endsWith('.js')).sort();
const js = hash(...scripts.flatMap((f) => [f, readFileSync(`site/${f}`)]));
for (const f of scripts) {
  writeFileSync(`dist/${f}`, readFileSync(`site/${f}`, 'utf8').replace(/(import\s*\(?\s*(?:[^'"]*?from\s*)?['"])(\.\/[\w-]+\.js)(['"])/g, `$1$2?v=${js}$3`));
}
writeFileSync(
  'dist/index.html',
  readFileSync('site/index.html', 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${hash(readFileSync('site/styles.css'))}"`)
    .replace('src="app.js"', `src="app.js?v=${js}"`),
);
writeFileSync('dist/.nojekyll', '');
console.log('Built dist/');
