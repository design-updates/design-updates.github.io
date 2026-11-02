// Copies app icons and source favicons into the built site, so the page doesn't depend on Google's and Apple's
// image servers, which may not load in mainland China. Runs at build time on GitHub. Anything that can't be
// downloaded keeps its original address.

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

export const faviconUrl = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16`;

const EXT: [RegExp, string][] = [
  [/png/, 'png'],
  [/jpe?g/, 'jpg'],
  [/svg/, 'svg'],
  [/webp/, 'webp'],
  [/icon/, 'ico'],
];

/** Downloads each image into <outDir>/icons/ and returns original address -> local path, for those that worked. */
export async function mirrorUrls(urls: Iterable<string>, outDir: string, fetchImpl: typeof fetch = fetch): Promise<{ local: Map<string, string>; failed: number }> {
  mkdirSync(join(outDir, 'icons'), { recursive: true });
  const local = new Map<string, string>();
  let failed = 0;
  await mapLimit([...new Set(urls)], 6, async (url) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
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
      if (i.icon) wanted.add(iconAt16(i.icon));
      for (const s of i.sources) wanted.add(faviconUrl(domainOf(s.url)));
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
        sources: i.sources.map((s) => ({ ...s, favicon: local.get(faviconUrl(domainOf(s.url))) ?? null })),
      })),
    })),
  };
  return { radar: out, saved: local.size, failed };
}
