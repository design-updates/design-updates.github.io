// Copies every picture, app icon and source favicon into the built site, so published cards do not depend on
// publishers allowing hotlinks later, and Google's or Apple's image servers do not need to load in mainland China.
// Runs at build time on GitHub. Anything that cannot be downloaded keeps its original address.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Radar } from './types.ts';
import { domainOf, mapLimit } from './util.ts';

/** The 16px version the page shows (same rule as iconAt in site/app.js). */
export function iconAt16(url: string): string {
  if (/mzstatic\.com/.test(url)) return url.replace(/\/\d+x\d+bb\.(png|jpg|webp)$/, '/16x16bb.png');
  if (/google\.com\/s2\/favicons/.test(url)) return url.replace(/sz=\d+/, 'sz=16');
  return url;
}

/** The large version, for the placeholder on a card without a picture: 128px App Store artwork, 64px favicons. */
export function iconLarge(url: string): string {
  if (/mzstatic\.com/.test(url)) return url.replace(/\/\d+x\d+(bb)?\.(png|jpg|webp)$/, '/128x128bb.png');
  if (/google\.com\/s2\/favicons/.test(url)) return url.replace(/sz=\d+/, 'sz=64');
  return url;
}

export const faviconUrl = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16`;

const EXT: [RegExp, string][] = [
  [/png/, 'png'],
  [/jpe?g/, 'jpg'],
  [/svg/, 'svg'],
  [/webp/, 'webp'],
  [/avif/, 'avif'],
  [/gif/, 'gif'],
  [/icon/, 'ico'],
];

/** Downloads each image into <outDir>/icons/ and returns original address -> local path, for those that worked.
    The directory name is kept for compatibility; it now contains card pictures too. */
export async function mirrorUrls(urls: Iterable<string>, outDir: string, fetchImpl: typeof fetch = fetch): Promise<{ local: Map<string, string>; failed: number }> {
  mkdirSync(join(outDir, 'icons'), { recursive: true });
  const local = new Map<string, string>();
  let failed = 0;
  await mapLimit([...new Set(urls)], 6, async (url) => {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`HTTP ${res.status} ${type}`);
      const ext = EXT.find(([re]) => re.test(type))?.[1] ?? 'img';
      const name = `icons/${createHash('sha1').update(url).digest('hex').slice(0, 12)}.${ext}`;
      writeFileSync(join(outDir, name), Buffer.from(await res.arrayBuffer()));
      local.set(url, name);
    } catch {
      failed++;
    }
  });
  return { local, failed };
}

export async function mirrorAssets(radar: Radar, outDir: string, fetchImpl: typeof fetch = fetch): Promise<{ radar: Radar; saved: number; failed: number }> {
  const wanted = new Set<string>();
  for (const d of radar.days) {
    for (const i of d.items) {
      if (i.icon) {
        wanted.add(iconAt16(i.icon));
        wanted.add(iconLarge(i.icon));
      }
      for (const s of i.sources) wanted.add(faviconUrl(domainOf(s.url)));
      if (i.image) wanted.add(i.image);
      if (i.compare?.before) wanted.add(i.compare.before);
      if (i.compare?.after) wanted.add(i.compare.after);
      for (const shot of i.store_shots ?? []) wanted.add(shot);
    }
  }
  const { local, failed } = await mirrorUrls(wanted, outDir, fetchImpl);
  const out: Radar = {
    ...radar,
    days: radar.days.map((d) => ({
      ...d,
      items: d.items.map((i) => ({
        ...i,
        icon: i.icon ? (local.get(iconAt16(i.icon)) ?? i.icon) : i.icon,
        icon_large: i.icon ? (local.get(iconLarge(i.icon)) ?? iconLarge(i.icon)) : null,
        image: i.image ? (local.get(i.image) ?? i.image) : i.image,
        compare: i.compare
          ? { ...i.compare, before: i.compare.before ? (local.get(i.compare.before) ?? i.compare.before) : i.compare.before, after: local.get(i.compare.after) ?? i.compare.after }
          : i.compare,
        store_shots: i.store_shots?.map((shot) => local.get(shot) ?? shot) ?? i.store_shots,
        sources: i.sources.map((s) => ({ ...s, favicon: local.get(faviconUrl(domainOf(s.url))) ?? null })),
      })),
    })),
  };
  return { radar: out, saved: local.size, failed };
}
