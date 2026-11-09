import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { imageDimensions } from './compare.ts';
import type { Item, Radar } from './types.ts';
import { readJson } from './util.ts';

export type VerifiedRole = 'image' | 'before' | 'after' | 'combined';

export interface VerifiedAsset {
  path: string;
  story_id: string;
  role: VerifiedRole;
  source_url: string;
  reviewed_content: string;
  width: number;
  height: number;
  sha256: string;
}

interface Manifest {
  version: 1;
  assets: VerifiedAsset[];
}

const mediaType = (path: string) => {
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.gif$/i.test(path)) return 'image/gif';
  return 'image/jpeg';
};

function roleOf(item: Item, path: string): VerifiedRole | null {
  if (item.image === path) return 'image';
  if (item.compare?.before === path) return 'before';
  if (item.compare?.after === path) return item.compare.combined ? 'combined' : 'after';
  return null;
}

/**
 * A reviewed local asset is trusted only while its exact bytes, dimensions, story, role and source still match
 * data/verified-assets.json. This prevents a correctly named but unrelated screenshot from being published.
 */
export function verifyReviewedAssets(radar: Radar, root = '.'): void {
  const manifest = readJson<Manifest>(join(root, 'data/verified-assets.json'), { version: 1, assets: [] });
  const items = new Map(radar.days.flatMap((day) => day.items).map((item) => [item.id, item]));
  const referenced = new Map<string, { item: Item; role: VerifiedRole }>();
  for (const item of items.values()) {
    for (const path of [item.image, item.compare?.before, item.compare?.after]) {
      if (!path?.startsWith('assets/verified/')) continue;
      const role = roleOf(item, path)!;
      if (referenced.has(path)) throw new Error(`Verified asset is assigned to more than one story: ${path}`);
      referenced.set(path, { item, role });
    }
  }

  const registered = new Set<string>();
  for (const asset of manifest.assets) {
    if (registered.has(asset.path)) throw new Error(`Duplicate verified asset manifest entry: ${asset.path}`);
    registered.add(asset.path);
    const use = referenced.get(asset.path);
    if (!use) throw new Error(`Verified asset is registered but not used: ${asset.path}`);
    if (use.item.id !== asset.story_id || use.role !== asset.role) {
      throw new Error(`Verified asset assignment changed: ${asset.path} is ${use.item.id}/${use.role}, expected ${asset.story_id}/${asset.role}`);
    }
    if (!use.item.sources.some((source) => source.url === asset.source_url)) {
      throw new Error(`Verified asset source is not credited by ${asset.story_id}: ${asset.source_url}`);
    }
    if (!asset.reviewed_content.trim()) throw new Error(`Verified asset has no reviewed content description: ${asset.path}`);
    const disk = join(root, 'site', asset.path);
    if (!existsSync(disk)) throw new Error(`Verified asset file is missing: ${asset.path}`);
    const bytes = readFileSync(disk);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== asset.sha256) throw new Error(`Verified asset bytes changed without review: ${asset.path}`);
    const size = imageDimensions(bytes, mediaType(asset.path));
    if (!size || size.width !== asset.width || size.height !== asset.height) {
      throw new Error(`Verified asset dimensions changed without review: ${asset.path}`);
    }
  }

  for (const path of referenced.keys()) {
    if (!registered.has(path)) throw new Error(`Verified asset is used without a manifest entry: ${path}`);
  }
  const diskFiles = readdirSync(join(root, 'site/assets/verified')).filter((name) => !name.startsWith('.'));
  for (const name of diskFiles) {
    const path = `assets/verified/${basename(name)}`;
    if (!registered.has(path)) throw new Error(`Unregistered file in verified assets: ${path}`);
  }
}
