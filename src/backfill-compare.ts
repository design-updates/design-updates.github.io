// npm run backfill-compare [-- --days N] [--missing] [--dry-run]
// Picks the picture again for items already in radar.json, by re-reading their source pages and letting the model
// look at the pictures (see compare.ts). Without --days, only items that have no before/after yet; with --days N,
// every item from the last N days. --missing keeps only items with no picture or a site's stock share card (the
// morning job uses `--days 1 --missing` after a run that could not read most pages). Only `compare` and `image`
// change; headlines and text are never touched.

import { addCompares, isStockImage, oldUpload } from './compare.ts';
import { loadConfig } from './config.ts';
import { companyLlm, companyLogin, type Llm } from './llm.ts';
import { fetchPageMeta } from './pagemeta.ts';
import type { Item, Radar } from './types.ts';
import { readJson, writeJson } from './util.ts';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const daysAt = argv.indexOf('--days');
const days = daysAt >= 0 ? Number(argv[daysAt + 1]) : 0;
if (daysAt >= 0 && !(days >= 1 && days <= 60)) {
  console.error('--days needs a number from 1 to 60.');
  process.exit(2);
}
const cfg = loadConfig();
const radar = readJson<Radar>('data/radar.json', { version: 1, updated_at: '', days: [] });
const login = cfg.provider === 'company' ? companyLogin() : null;
const llm: Llm | null = login ? companyLlm(login) : null;
if (!llm) console.log('No company login found; only captions that clearly say "before"/"after" are used.');

const missing = argv.includes('--missing');
const all = days ? radar.days.slice(0, days).flatMap((d) => d.items) : radar.days.flatMap((d) => d.items).filter((i) => !i.compare);
const todo = missing ? all.filter((i) => !i.compare && (!i.image || isStockImage(i.image) || oldUpload(i.image, i.published_at))) : all;
console.log(`${todo.length} items ${days ? `from the last ${days} days` : 'without before/after'}${missing ? ' with no picture yet' : ''}`);
const pages = new Map<string, Awaited<ReturnType<typeof fetchPageMeta>>>();
const imagesFor = async (item: Item) => {
  const out = [];
  for (const s of item.sources) {
    if (!pages.has(s.url)) pages.set(s.url, await fetchPageMeta(s.url));
    out.push(pages.get(s.url)?.images ?? []);
  }
  return out;
};
const r = await addCompares(cfg, todo, imagesFor, llm, new Map());
for (const n of r.notes) console.log(`  ${n}`);
if (r.usage) console.log(`  model: ${r.usage.model} in ${r.usage.input_tokens} out ${r.usage.output_tokens}${r.usage.credits ? ` credits ${r.usage.credits.toFixed(3)}` : ''}`);

const before = new Map(todo.map((i) => [i.id, JSON.stringify([i.image, i.compare ?? null])]));
const changed = new Map(r.items.filter((i) => before.get(i.id) !== JSON.stringify([i.image, i.compare ?? null])).map((i) => [i.id, i]));
console.log(`${changed.size} items get a new picture`);
if (!dry && changed.size) {
  for (const d of radar.days) d.items = d.items.map((i) => (changed.has(i.id) ? { ...i, compare: changed.get(i.id)!.compare ?? null, image: changed.get(i.id)!.image } : i));
  writeJson('data/radar.json', radar);
  console.log('Saved data/radar.json');
}
