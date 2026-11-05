// npm run backfill-compare [-- --days N] [--missing] [--dry-run]
// Picks the picture again for items already in radar.json, by re-reading their source pages and letting the model
// look at the pictures (see compare.ts). Without --days, only items that have no before/after yet; with --days N,
// every item from the last N days. --missing keeps only items with no picture or a site's stock share card (the
// morning job uses `--days 1 --missing` after a run that could not read most pages); it also reads today's feeds for other
// sites' coverage of the same stories, whose pictures can be used. Only `compare`, `image` and, when another site
// supplied the picture, `sources` change; headlines and text are never touched.

import { addCompares, isStockImage, oldUpload } from './compare.ts';
import { loadConfig } from './config.ts';
import { companyLlm, companyLogin, type Llm } from './llm.ts';
import { feedCandidates, readFeed } from './feeds.ts';
import { fetchPageMeta } from './pagemeta.ts';
import { poolOf, searchCoverage, withRelatedPictures, type PoolEntry } from './related.ts';
import type { Item, Radar } from './types.ts';
import { mapLimit, readJson, writeJson } from './util.ts';

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
// "Missing" includes a picture that no longer loads (a site that refuses to be shown elsewhere, or a removed file).
const loadsHere = async (src: string) => {
  try {
    const res = await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12_000) });
    await res.body?.cancel();
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
};
const broken = new Set<string>();
if (missing) for (const i of all) if (i.image && !i.compare && !(await loadsHere(i.image))) broken.add(i.id);
const todo = missing ? all.filter((i) => !i.compare && (!i.image || broken.has(i.id) || isStockImage(i.image) || oldUpload(i.image, i.published_at))) : all;
console.log(`${todo.length} items ${days ? `from the last ${days} days` : 'without before/after'}${missing ? ' with no picture yet' : ''}`);
const pages = new Map<string, ReturnType<typeof fetchPageMeta>>();
const getMeta = (url: string) => {
  if (!pages.has(url)) pages.set(url, fetchPageMeta(url));
  return pages.get(url)!;
};
// For cards with no picture, other sites' coverage of the same story is read too, from today's feeds.
let pool: PoolEntry[] = [];
if (missing && todo.length) {
  const results = await mapLimit(cfg.feeds, 6, (f) => readFeed(f));
  pool = poolOf(cfg, feedCandidates(cfg, results), new Date());
  console.log(`${pool.length} headlines from ${results.filter((x) => x.ok).length} feeds, for other coverage of the same stories`);
}
const related = withRelatedPictures(pool, getMeta, missing ? (item) => searchCoverage(item) : undefined);
const picked = await addCompares(cfg, todo, related.imagesFor, llm, new Map(), fetch);
const r = { ...picked, items: related.credit(picked.items) };
for (const n of r.notes) console.log(`  ${n}`);
if (r.usage) console.log(`  model: ${r.usage.model} in ${r.usage.input_tokens} out ${r.usage.output_tokens}${r.usage.credits ? ` credits ${r.usage.credits.toFixed(3)}` : ''}`);

const sig = (i: Item) => JSON.stringify([i.image, i.compare ?? null, i.sources.length]);
const before = new Map(todo.map((i) => [i.id, sig(i)]));
const changed = new Map(r.items.filter((i) => before.get(i.id) !== sig(i)).map((i) => [i.id, i]));
console.log(`${changed.size} items get a new picture`);
if (!dry && changed.size) {
  for (const d of radar.days) d.items = d.items.map((i) => (changed.has(i.id) ? { ...i, compare: changed.get(i.id)!.compare ?? null, image: changed.get(i.id)!.image, sources: changed.get(i.id)!.sources } : i));
  writeJson('data/radar.json', radar);
  console.log('Saved data/radar.json');
}
