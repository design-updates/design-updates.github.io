// Reads and checks watchlist.yaml, so a typo there gives a clear message instead of a crash mid-run.

import { readFileSync } from 'node:fs';
import { CATEGORIES, type Category } from './types.ts';
import { parseYaml } from './yaml.ts';

export interface App {
  name: string;
  category: Category;
  aliases: string[];
  domains: string[];
  appstoreId: number | null;
  /** The App Store country the app is listed in, when it is not in the default one (stores.country). Zomato is
   *  only in India's store, Careem in the UAE's, SNCF Connect in France's. */
  storeCountry: string | null;
  /** Google Play package name, for version notes. */
  playId: string | null;
  iconDomain: string | null;
}

export interface Group {
  category: Category;
  label: string;
  search: string[];
  apps: App[];
}

export interface Feed {
  name: string;
  url: string;
  /** company: every item is about `app`. outlet: news site, matched to apps by name or design words.
   *  design: design or branding publication, every item goes to the model, which names the brand. */
  kind: 'company' | 'outlet' | 'design';
  app: string | null;
  /** A newsroom web page instead of a feed: its links matching this pattern (a regular expression on the path) are
   *  the articles. Each is then read for its title, date and summary. */
  page?: RegExp;
}

export type Provider = 'company' | 'gemini' | 'anthropic';

export interface Config {
  reader: string;
  /** Where the model calls go. RADAR_PROVIDER overrides it. */
  provider: Provider;
  timezone: string;
  windowHours: number;
  models: { curate: string; search: string; searchTool: string; searchesPerGroup: number; maxCandidates: number; compare: string };
  /** Check App Store / Google Play version notes of the watchlist apps. */
  stores: { appStore: boolean; googlePlay: boolean; country: string };
  prices: Record<string, { input: number; output: number }>;
  webSearchPer1000: number;
  groups: Group[];
  apps: App[];
  feeds: Feed[];
  trust: { outlets: string[]; blockedDomains: string[]; dropWords: string[] };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`watchlist.yaml: ${message}`);
    this.name = 'ConfigError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown, where: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${where} should be a list`);
  return v.map((x) => String(x));
};

export function loadConfig(path = 'watchlist.yaml'): Config {
  return parseConfig(readFileSync(path, 'utf8'), process.env);
}

export function parseConfig(src: string, env: Record<string, string | undefined> = {}): Config {
  const y = parseYaml(src);
  if (!isObj(y)) throw new ConfigError('expected a mapping at the top level');
  const models = isObj(y.models) ? y.models : {};
  const prices = isObj(y.prices) ? y.prices : {};
  if (!isObj(y.groups)) throw new ConfigError('missing "groups"');

  const groups: Group[] = [];
  for (const [key, raw] of Object.entries(y.groups)) {
    if (!CATEGORIES.includes(key as Category)) throw new ConfigError(`group "${key}" must be one of ${CATEGORIES.join(', ')}`);
    if (!isObj(raw)) throw new ConfigError(`group "${key}" should be a mapping`);
    const category = key as Category;
    const apps = (Array.isArray(raw.apps) ? raw.apps : []).map((a, i): App => {
      if (!isObj(a) || !a.name) throw new ConfigError(`groups.${key}.apps[${i}] needs a name`);
      const name = String(a.name);
      return {
        name,
        category,
        aliases: strList(a.aliases, `${name}.aliases`).length ? strList(a.aliases, `${name}.aliases`) : [name],
        domains: strList(a.domains, `${name}.domains`).map((d) => d.toLowerCase().replace(/^www\./, '')),
        appstoreId: a.appstore_id == null ? null : Number(a.appstore_id),
        storeCountry: a.store_country ? String(a.store_country).toLowerCase() : null,
        playId: a.play_id ? String(a.play_id) : null,
        iconDomain: a.icon_domain ? String(a.icon_domain) : null,
      };
    });
    groups.push({ category, label: String(raw.label ?? key), search: strList(raw.search, `groups.${key}.search`), apps });
  }

  const apps = groups.flatMap((g) => g.apps);
  const seen = new Set<string>();
  for (const a of apps) {
    if (seen.has(a.name)) throw new ConfigError(`app "${a.name}" is listed twice; keep it in one group`);
    seen.add(a.name);
  }

  const feeds = (Array.isArray(y.feeds) ? y.feeds : []).map((f, i): Feed => {
    if (!isObj(f) || !f.url) throw new ConfigError(`feeds[${i}] needs a url`);
    const kind = f.kind === 'company' ? 'company' : f.kind === 'design' ? 'design' : 'outlet';
    const app = f.app ? String(f.app) : null;
    if (kind === 'company' && !app) throw new ConfigError(`feed "${f.name ?? f.url}" is kind: company, so it needs app:`);
    if (app && !seen.has(app)) throw new ConfigError(`feed "${f.name ?? f.url}" names app "${app}", which is not in groups`);
    let page: RegExp | undefined;
    if (f.page !== undefined) {
      try {
        page = new RegExp(String(f.page));
      } catch (err) {
        throw new ConfigError(`feed "${f.name ?? f.url}": page is not a valid pattern (${(err as Error).message})`);
      }
    }
    return { name: String(f.name ?? f.url), url: String(f.url), kind, app, ...(page ? { page } : {}) };
  });

  const trust = isObj(y.trust) ? y.trust : {};
  const priceTable: Config['prices'] = {};
  for (const [model, p] of Object.entries(prices)) {
    if (isObj(p)) priceTable[model] = { input: Number(p.input ?? 0), output: Number(p.output ?? 0) };
  }

  const provider = String(env.RADAR_PROVIDER || y.provider || 'anthropic');
  if (provider !== 'company' && provider !== 'gemini' && provider !== 'anthropic') throw new ConfigError(`provider must be company, gemini or anthropic, not "${provider}"`);
  const company = isObj(y.company) ? y.company : {};
  const gemini = isObj(y.gemini) ? y.gemini : {};
  const curate =
    provider === 'company'
      ? String(company.curate ?? 'kr-claude-opus-5.5')
      : provider === 'gemini'
        ? String(gemini.curate ?? 'gemini-3.8-flash')
        : String(models.curate ?? 'claude-sonnet-5-5');
  // The small second call that picks before/after images. A cheap model is enough.
  const compare =
    provider === 'company'
      ? String(company.compare ?? 'kr-claude-haiku-4-5-20251001')
      : provider === 'gemini'
        ? String(gemini.compare ?? gemini.curate ?? 'gemini-3.8-flash')
        : String(models.compare ?? 'claude-haiku-5-5');
  const stores = isObj(y.stores) ? y.stores : {};

  return {
    reader: String(y.reader ?? ''),
    provider,
    timezone: String(y.timezone ?? 'Asia/Shanghai'),
    windowHours: Number(y.window_hours ?? 48),
    models: {
      curate,
      search: String(models.search ?? 'claude-haiku-5-5'),
      searchTool: String(models.search_tool ?? 'web_search_20250305'),
      searchesPerGroup: Number(models.searches_per_group ?? 3),
      maxCandidates: Number(models.max_candidates ?? 150),
      compare,
    },
    stores: {
      appStore: stores.app_store !== false,
      googlePlay: stores.google_play !== false,
      country: String(stores.country ?? 'us'),
    },
    prices: priceTable,
    webSearchPer1000: Number(prices.web_search_per_1000 ?? 10),
    groups,
    apps,
    feeds,
    trust: {
      outlets: strList(trust.outlets, 'trust.outlets').map((d) => d.toLowerCase()),
      blockedDomains: strList(trust.blocked_domains, 'trust.blocked_domains').map((d) => d.toLowerCase()),
      dropWords: strList(trust.drop_words, 'trust.drop_words'),
    },
  };
}

export const appByName = (cfg: Config, name: string): App | undefined => cfg.apps.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
