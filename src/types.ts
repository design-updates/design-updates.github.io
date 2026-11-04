export const CATEGORIES = ['ota', 'rail', 'delivery', 'platform', 'consumer'] as const;
export type Category = (typeof CATEGORIES)[number];

/** What kind of design change an item is. */
export const KINDS = ['ui', 'ux', 'brand'] as const;
export type Kind = (typeof KINDS)[number];

/** Old and new design side by side. `combined` is one image that already shows both. */
export interface Compare {
  before: string | null;
  after: string;
  combined?: boolean;
  /** Where the pair came from: captions in the article, or App Store screenshots of two versions. */
  from: 'article' | 'app-store';
  /** For app-store pairs: the version shown as "before". */
  before_version?: string;
}

/** An item that came from an app's own store version notes rather than a news story. */
export interface Release {
  store: 'app-store' | 'google-play';
  version: string;
}

/** The Simplified Chinese write-up of an item, shown when the page is switched to 中文. */
export interface ItemZh {
  headline: string;
  what: string;
  why: string;
}

/** A news item collected from a feed or a web search, before the model has looked at it. */
export interface Candidate {
  cid: string;
  title: string;
  url: string;
  /** Publisher name, e.g. "9to5Mac" or "Airbnb Newsroom". */
  source: string;
  domain: string;
  publishedAt: string | null;
  summary: string;
  image: string | null;
  via: 'feed' | 'search';
  /** Domain of the feed's own URL, for feed items. A feed's own posts skip the blocklist. */
  feedDomain?: string;
  trust: 'company' | 'outlet';
  /** App the item is about, when the feed or search already knows. */
  app: string | null;
  /** From a design or branding publication: kept without a watchlist match, the model names the brand. */
  design?: boolean;
  /** From the App Store or Google Play version notes. */
  release?: Release & { screenshot?: string | null; previousScreenshot?: string | null; previousVersion?: string | null };
}

export interface Dropped {
  title: string;
  url: string;
  source: string;
  reason: string;
  /** Groups noisy reasons in the log ("older than 48h" happens hundreds of times a day). */
  bulk?: boolean;
}

export interface Source {
  title: string;
  url: string;
  publisher: string;
  /** Set only in the built site: the publisher's icon, copied into the site. */
  favicon?: string | null;
}

/** One reported change, as stored in radar.json and shown on the page. */
export interface Item {
  id: string;
  /** A watchlist app, or another brand named by the model (design news is not limited to the watchlist). */
  app: string;
  category: Category;
  /** UI, UX or Brand. Missing on items written before the design focus (October 2026). */
  kind?: Kind | null;
  /** Publish date in the reader's timezone, YYYY-MM-DD. */
  date: string;
  published_at: string;
  beta: boolean;
  importance: number;
  headline: string;
  what: string;
  why: string;
  sources: Source[];
  image: string | null;
  icon: string | null;
  collected_at: string;
  zh?: ItemZh | null;
  compare?: Compare | null;
  release?: Release | null;
}

export interface Day {
  /** The run date in the reader's timezone, YYYY-MM-DD. */
  date: string;
  collected_at: string;
  quiet: boolean;
  pattern: string | null;
  pattern_zh?: string | null;
  items: Item[];
}

export interface Radar {
  version: 1;
  updated_at: string;
  days: Day[];
}

export interface SeenEvent {
  app: string;
  headline: string;
  date: string;
  urls: string[];
}

export interface Seen {
  events: Record<string, SeenEvent>;
}

export interface CallUsage {
  step: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  /** Company Coding Plan quota used, when the gateway reports it. */
  credits?: number;
}
