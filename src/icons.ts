// App icons, cached in data/icons.json so they are looked up once, not every run.
// Order: App Store artwork (by appstore_id, else by name search) → the app's favicon.
// Run `npm run icons` to refresh them; delete a line from icons.json to look one up again.

import type { App, Config } from './config.ts';
import { mapLimit, readJson, writeJson } from './util.ts';

export type Icons = Record<string, string | null>;

export const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

type Lookup = { results?: { artworkUrl100?: string; artworkUrl512?: string; trackName?: string }[] };

/** Ask for a 128px PNG; the page shows icons at 20–40px. */
const sized = (art: string) => art.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/, '/128x128bb.png');

async function appStoreIcon(app: App, fetchImpl: typeof fetch): Promise<{ url: string; name: string } | null> {
  const url = app.appstoreId
    ? `https://itunes.apple.com/lookup?id=${app.appstoreId}&country=${app.storeCountry ?? 'us'}`
    : `https://itunes.apple.com/search?term=${encodeURIComponent(app.name)}&entity=software&country=us&limit=5`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as Lookup;
  const want = app.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  // A name search must find something actually called like the app, not a lookalike.
  const hit = app.appstoreId ? data.results?.[0] : data.results?.find((r) => (r.trackName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(want));
  const art = hit?.artworkUrl512 ?? hit?.artworkUrl100;
  return art ? { url: sized(art), name: hit?.trackName ?? '' } : null;
}

/** `cache: false` when the lookup failed (offline, App Store down), so the next run tries again. */
export async function resolveIcon(app: App, fetchImpl: typeof fetch = fetch): Promise<{ icon: string; note: string; cache: boolean }> {
  const domain = app.iconDomain ?? app.domains[0];
  if (!app.iconDomain) {
    try {
      const hit = await appStoreIcon(app, fetchImpl);
      if (hit) return { icon: hit.url, note: `App Store: ${hit.name}`, cache: true };
    } catch {
      return { icon: favicon(domain), note: `favicon of ${domain} (App Store lookup failed)`, cache: false };
    }
  }
  return { icon: favicon(domain), note: `favicon of ${domain}`, cache: true };
}

/** Fills in icons the cache does not have yet. With refresh, looks every app up again. */
export async function ensureIcons(cfg: Config, path: string, opts: { fetchImpl?: typeof fetch; refresh?: boolean; log?: (s: string) => void } = {}): Promise<Icons> {
  const cache = readJson<Icons>(path, {});
  const missing = cfg.apps.filter((a) => opts.refresh || !cache[a.name]);
  if (!missing.length) return cache;
  const found = await mapLimit(missing, 4, async (a) => ({ app: a, ...(await resolveIcon(a, opts.fetchImpl)) }));
  const result = { ...cache };
  for (const f of found) {
    result[f.app.name] = f.icon;
    if (f.cache) cache[f.app.name] = f.icon;
    opts.log?.(`  ${f.app.name.padEnd(16)} ${f.note}`);
  }
  writeJson(path, Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b))));
  return result;
}

if (import.meta.main) {
  const { loadConfig } = await import('./config.ts');
  console.log('Looking up app icons…');
  await ensureIcons(loadConfig(), 'data/icons.json', { refresh: true, log: console.log });
  console.log('Saved data/icons.json');
}
