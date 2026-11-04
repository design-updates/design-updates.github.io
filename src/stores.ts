// "Changes nobody announces": App Store and Google Play version notes for the watchlist apps.
// Every run reads the latest version of each app. A version not seen before, released inside the window, whose
// notes mention a design change, becomes a candidate for the model like any news item. Most apps write
// "bug fixes and improvements", so this fires rarely, which is the point.
// What was seen is kept in data/stores.json, including each version's first screenshot, so a flagged version
// can be shown next to the previous one.

import type { App, Config } from './config.ts';
import type { Candidate } from './types.ts';
import { decodeEntities, fetchText, hoursAgo, mapLimit, parseDate, stripHtml, truncate } from './util.ts';

export interface StoreVersion {
  version: string;
  date: string | null;
  notes: string;
  screenshot: string | null;
}

export interface StoreState {
  appStore: Record<string, StoreVersion>;
  googlePlay: Record<string, StoreVersion>;
}

export const emptyStores = (): StoreState => ({ appStore: {}, googlePlay: {} });

/** Version-note phrases that mean nothing about design. Removed before looking for design words. */
const BOILERPLATE =
  /(bug fixes?|performance|stability|improvements? (to|under)[^.]*|under the hood|make[s]? the (app|experience)[^.]*|we update the app[^.]*|thanks for using[^.]*|keep your [^.]*updates? turned on[^.]*|to make sure you don't miss a thing[^.]*)/gi;

const DESIGN =
  /\b(redesign(s|ed)?|new (look|design|layout|home|homepage|tab|navigation|icon|interface|experience|way to)|fresh (look|design)|refresh(ed)?|revamp(ed)?|overhaul(ed)?|layout|interface|UI\b|dark mode|theme|home ?(screen|page|tab)|tab bar|navigation|onboarding|checkout|widget|live activit(y|ies)|map view|look and feel|all in one app|one app)/i;

/** Do these version notes describe something users will see? */
export function notesMentionDesign(notes: string): boolean {
  return DESIGN.test(notes.replace(BOILERPLATE, ' '));
}

type Lookup = { results?: { trackId: number; version?: string; currentVersionReleaseDate?: string; releaseNotes?: string; screenshotUrls?: string[] }[] };

/** One lookup per store country: most apps are in the default store, a few only in their home country's. */
export async function readAppStore(apps: App[], country: string, fetchImpl: typeof fetch): Promise<Map<string, StoreVersion>> {
  const out = new Map<string, StoreVersion>();
  const byCountry = new Map<string, App[]>();
  for (const a of apps.filter((x) => x.appstoreId)) {
    const cc = a.storeCountry ?? country;
    byCountry.set(cc, [...(byCountry.get(cc) ?? []), a]);
  }
  for (const [cc, list] of byCountry) {
    const res = await fetchImpl(`https://itunes.apple.com/lookup?id=${list.map((a) => a.appstoreId).join(',')}&country=${encodeURIComponent(cc)}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`App Store lookup (${cc}) HTTP ${res.status}`);
    const data = (await res.json()) as Lookup;
    for (const r of data.results ?? []) {
      const app = list.find((a) => a.appstoreId === r.trackId);
      if (!app || !r.version) continue;
      out.set(app.name, {
        version: r.version,
        date: parseDate(r.currentVersionReleaseDate)?.toISOString() ?? null,
        notes: truncate((r.releaseNotes ?? '').replace(/\s+/g, ' '), 1200),
        screenshot: r.screenshotUrls?.[0] ?? null,
      });
    }
  }
  return out;
}

/** Google Play has no API; the app page shows "What's new" and "Updated on". No version number, so the notes stand in for it. */
export function parsePlayPage(html: string): StoreVersion | null {
  const at = html.search(/What[’']s new/);
  if (at < 0) return null;
  const chunk = html.slice(at, at + 4000);
  const body = chunk.match(/<div[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? chunk.replace(/^What[’']s new/, '');
  const notes = stripHtml(body.replace(/<br\s*\/?>/gi, ' ')).split(/\b(flag|Flag as inappropriate|Data safety|App support|More by)\b/)[0].trim();
  if (!notes) return null;
  const updated = decodeEntities(html.match(/Updated on<\/div>\s*<div[^>]*>([^<]+)</)?.[1] ?? '').trim();
  // "Oct 30, 2026" is a calendar date, not a moment: read it as that day in UTC, not in this computer's time zone.
  const date = updated ? parseDate(`${updated} UTC`) : null;
  // A short hash of the notes plays the part of a version number.
  let h = 0;
  for (const ch of notes) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { version: date ? `${date.toISOString().slice(0, 10)}·${h.toString(36).slice(0, 4)}` : h.toString(36), date: date?.toISOString() ?? null, notes: truncate(notes, 1200), screenshot: null };
}

export async function readGooglePlay(apps: App[], fetchImpl: typeof fetch): Promise<Map<string, StoreVersion>> {
  const out = new Map<string, StoreVersion>();
  await mapLimit(
    apps.filter((a) => a.playId),
    4,
    async (a) => {
      try {
        const html = await fetchText(`https://play.google.com/store/apps/details?id=${encodeURIComponent(a.playId!)}&hl=en_US&gl=US`, { fetchImpl, timeoutMs: 20_000 });
        const v = parsePlayPage(html);
        if (v) out.set(a.name, v);
      } catch {
        /* one app failing is fine */
      }
    },
  );
  return out;
}

export interface StoresResult {
  ok: boolean;
  error?: string;
  /** The latest versions read this run, to save once the run is written. */
  latest: StoreState;
  candidates: Candidate[];
  /** New versions that were not passed on, with why (for the run log). */
  skipped: { app: string; store: string; version: string; reason: string }[];
}

function toCandidate(app: App, store: 'app-store' | 'google-play', v: StoreVersion, previous: StoreVersion | undefined): Candidate {
  const storeName = store === 'app-store' ? 'App Store' : 'Google Play';
  const base = store === 'app-store' ? `https://apps.apple.com/${app.storeCountry ?? 'us'}/app/id${app.appstoreId}` : `https://play.google.com/store/apps/details?id=${app.playId}`;
  const sep = base.includes('?') ? '&' : '?';
  return {
    cid: '',
    title: `${app.name} ${store === 'app-store' ? `${v.version} ` : ''}version notes: ${truncate(v.notes, 120)}`,
    // One URL per version, so a later version is not mistaken for one already reported.
    url: `${base}${sep}version=${encodeURIComponent(v.version)}`,
    source: `${storeName} notes`,
    domain: store === 'app-store' ? 'apps.apple.com' : 'play.google.com',
    publishedAt: v.date,
    summary: v.notes,
    image: v.screenshot,
    via: 'feed',
    trust: 'company',
    app: app.name,
    release: { store, version: v.version, screenshot: v.screenshot, previousScreenshot: previous?.screenshot ?? null, previousVersion: previous?.version ?? null },
  };
}

export async function checkStores(cfg: Config, state: StoreState, now: Date, fetchImpl: typeof fetch): Promise<StoresResult> {
  const latest: StoreState = { appStore: { ...state.appStore }, googlePlay: { ...state.googlePlay } };
  const candidates: Candidate[] = [];
  const skipped: StoresResult['skipped'] = [];
  const errors: string[] = [];

  const consider = (store: 'app-store' | 'google-play', found: Map<string, StoreVersion>, seen: Record<string, StoreVersion>, into: Record<string, StoreVersion>) => {
    for (const [name, v] of found) {
      const app = cfg.apps.find((a) => a.name === name)!;
      const before = seen[name];
      into[name] = v;
      if (before?.version === v.version) continue;
      const published = parseDate(v.date);
      const label = { app: name, store, version: v.version };
      if (!published || hoursAgo(published, now) > cfg.windowHours) {
        if (before) skipped.push({ ...label, reason: 'released outside the window' });
        continue;
      }
      if (!notesMentionDesign(v.notes)) {
        skipped.push({ ...label, reason: 'notes mention no design change' });
        continue;
      }
      candidates.push(toCandidate(app, store, v, before));
    }
  };

  if (cfg.stores.appStore) {
    try {
      consider('app-store', await readAppStore(cfg.apps, cfg.stores.country, fetchImpl), state.appStore, latest.appStore);
    } catch (err) {
      errors.push(`App Store: ${(err as Error).message}`);
    }
  }
  if (cfg.stores.googlePlay) {
    const play = await readGooglePlay(cfg.apps, fetchImpl);
    if (!play.size && cfg.apps.some((a) => a.playId)) errors.push('Google Play: no app page could be read');
    consider('google-play', play, state.googlePlay, latest.googlePlay);
  }
  return { ok: errors.length === 0, error: errors.join('; ') || undefined, latest, candidates, skipped };
}
