// Cheap, rule-based checks before the model sees anything: trusted source, real publish date inside the
// window, about a watchlist app, not obviously off-topic, not already reported. Every drop has a reason.

import { appByName, type App, type Config } from './config.ts';
import type { Candidate, Dropped } from './types.ts';
import { hoursAgo, onDomain, parseDate } from './util.ts';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word pattern: only adds a word boundary on sides that start or end with a letter or digit. */
function wordPattern(word: string, flags: string): RegExp {
  const pre = /^\w/.test(word) ? '(?<!\\w)' : '';
  const post = /\w$/.test(word) ? '(?!\\w)' : '';
  return new RegExp(`${pre}${escape(word)}${post}`, flags);
}

/** The watchlist app a headline is about: the alias that appears earliest in the text. Exact capitals. When two
    start at the same place, the longer one wins, so "Uber Eats adds..." is Uber Eats, not Uber. */
export function matchApp(cfg: Config, text: string): App | null {
  let best: { app: App; at: number; len: number } | null = null;
  for (const app of cfg.apps) {
    for (const alias of app.aliases) {
      const m = wordPattern(alias, '').exec(text);
      if (m && (!best || m.index < best.at || (m.index === best.at && alias.length > best.len))) best = { app, at: m.index, len: alias.length };
    }
  }
  return best?.app ?? null;
}

/** Headline words that suggest a visible design change. News about any app with these passes to the model. */
const DESIGN_WORDS =
  /\b(redesign(s|ed)?|rebrand(s|ed|ing)?|new (look|logo|icon|design|interface|layout|identity|ui)|logo|logos|icons?|brand identity|visual identity|typeface|font|design (language|system|refresh|overhaul|update)|refresh(ed)?|revamp(s|ed)?|overhaul(s|ed)?|makeover|facelift|dark mode|interface|UI|UX|layout|navigation|tab bar|home ?screen|onboarding|checkout|widget|Liquid Glass|Material (3|You|Expressive)|Human Interface Guidelines)\b/i;

export const looksLikeDesign = (title: string): boolean => DESIGN_WORDS.test(title);

export function dropWord(cfg: Config, title: string): string | null {
  return cfg.trust.dropWords.find((w) => wordPattern(w, 'i').test(title)) ?? null;
}

export interface PrefilterResult {
  kept: Candidate[];
  dropped: Dropped[];
}

export function prefilter(cfg: Config, all: Candidate[], ctx: { now: Date; seenUrls: Set<string> }): PrefilterResult {
  const dropped: Dropped[] = [];
  const drop = (c: Candidate, reason: string, bulk = false) => dropped.push({ title: c.title, url: c.url, source: c.source, reason, bulk });

  // Same URL from a feed and a search (or two feeds): keep one, feeds first.
  const byUrl = new Map<string, Candidate>();
  for (const c of [...all].sort((a, b) => (a.via === b.via ? 0 : a.via === 'feed' ? -1 : 1))) {
    const prev = byUrl.get(c.url);
    if (!prev) byUrl.set(c.url, { ...c });
    else {
      prev.image ??= c.image;
      prev.publishedAt ??= c.publishedAt;
      if (!prev.summary) prev.summary = c.summary;
      prev.app ??= c.app;
    }
  }

  const ok: Candidate[] = [];
  for (const c of byUrl.values()) {
    // An entry with a path (figma.com/community) blocks only that part of the site.
    // A hand-picked feed's own posts are exempt (Airbnb Design lives on medium.com), but a medium.com
    // link reached through another feed, such as Sidebar, is still blocked.
    const blocked = cfg.trust.blockedDomains.find((b) => (b.includes('/') ? c.url.replace(/^https?:\/\/(www\.)?/, '').startsWith(b) : onDomain(c.domain, [b])));
    const ownFeed = c.via === 'feed' && c.feedDomain === c.domain;
    if (blocked && !ownFeed) {
      drop(c, `blocked source (${blocked})`);
      continue;
    }

    // Design publications and design-sounding headlines pass without a watchlist app; the model names the brand.
    const app = (c.app && appByName(cfg, c.app)) || matchApp(cfg, c.title);
    const design = c.design || looksLikeDesign(c.title);
    if (!app && !design) {
      drop(c, 'not about a watchlist app or a design change', true);
      continue;
    }

    const own = app ? onDomain(c.domain, app.domains) : null;
    const outlet = onDomain(c.domain, cfg.trust.outlets);
    // Feeds were chosen by hand, so they are trusted. Search results must come from a known site.
    if (c.via === 'search' && !own && !outlet) {
      drop(c, `not a trusted source (${c.domain})`);
      continue;
    }

    const published = parseDate(c.publishedAt);
    if (!published) {
      drop(c, 'no publish date found');
      continue;
    }
    const age = hoursAgo(published, ctx.now);
    if (age > cfg.windowHours) {
      drop(c, `older than ${cfg.windowHours}h`, true);
      continue;
    }
    if (age < -1) {
      drop(c, 'published after this run', true);
      continue;
    }

    const word = dropWord(cfg, c.title);
    if (word) {
      drop(c, `headline matches drop word "${word}"`);
      continue;
    }

    if (ctx.seenUrls.has(c.url)) {
      drop(c, 'already reported on an earlier day');
      continue;
    }

    ok.push({ ...c, app: app?.name ?? null, trust: own || c.trust === 'company' ? 'company' : 'outlet' });
  }

  // Company posts first, then headlines with design words, then other news about watchlist apps; newest first within
  // each. Anything past the cap is dropped so the model call stays small, so a plain app mention never pushes out
  // a redesign.
  const rank = (c: Candidate) => (c.trust === 'company' ? 0 : c.design || looksLikeDesign(c.title) ? 1 : 2);
  ok.sort((a, b) => rank(a) - rank(b) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  for (const c of ok.slice(cfg.models.maxCandidates)) drop(c, `over the cap of ${cfg.models.maxCandidates} candidates`);
  const kept = ok.slice(0, cfg.models.maxCandidates).map((c, i) => ({ ...c, cid: `c${i + 1}` }));
  return { kept, dropped };
}
