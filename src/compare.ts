// The picture for each kept item: the one that shows the change, not the article's generic header image.
// 1. Version notes from the stores: last version's screenshot next to this one's, when they differ.
// 2. Articles: the model LOOKS at the article's pictures (downloaded here, sent with the headline) and picks the one
//    that shows the change, or an old/new pair, or one picture with both. A grid of the new icons beats the bare
//    logo; a screenshot of the new screen beats a photo of the company.
// 3. With no model, or no picture that could be downloaded, captions and file names decide the clear cases.

import type { Config } from './config.ts';
import { textOf, usageOf, type ContentBlock, type Llm } from './llm.ts';
import type { PageImage } from './pagemeta.ts';
import type { CallUsage, Compare, Item } from './types.ts';
import { mapLimit, parseJsonLoose } from './util.ts';

const OLD = /\b(before|old|older|previous|former|original|outgoing|legacy|prior|was)\b|\b(19|20)\d\d\b.*\b(logo|mark|identity|design)\b/i;
const NEW = /\b(after|new|updated|redesign(ed)?|refreshed|revamped|current|now)\b/i;
const BOTH = /\b(before (and|&|\/|vs\.?) after|old (and|&|\/|vs\.?) new|side[- ]by[- ]side|comparison|compared)\b/i;
const FILE_OLD = /[-_/](old|before|previous|prev|legacy)[-_.]/i;
const FILE_NEW = /[-_/](new|after|updated|redesign)[-_.]/i;

const words = (img: PageImage) => `${img.alt} ${img.caption}`.trim();

/** The words of a picture's file name, for telling whether two pictures are of the same thing. */
const NOT_SUBJECT = /^(old|new|before|after|previous|prev|legacy|updated|redesign|cover|copy|scaled|image|img|jpg|jpeg|png|webp)$/;
const fileWords = (src: string) => new Set((src.split('/').pop()?.split('?')[0].toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !NOT_SUBJECT.test(w)));
const sameSubject = (a: string, b: string) => {
  const x = fileWords(a);
  const y = fileWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.8;
};

/** Clear cases only. Returns null when the words don't settle it. Two pictures named old and new only by their
    file names must be of the same thing ("Messages-pinned-old" and "Messages-pinned-new", not "Messages-icon-redesign"). */
export function pairFromWords(images: PageImage[]): Compare | null {
  const both = images.find((i) => BOTH.test(words(i)));
  if (both) return { before: null, after: both.src, combined: true, from: 'article' };
  const saysOld = (i: PageImage) => OLD.test(words(i)) && !NEW.test(words(i).replace(OLD, ''));
  const saysNew = (i: PageImage) => NEW.test(words(i)) && !OLD.test(words(i));
  const isOld = (i: PageImage) => saysOld(i) || FILE_OLD.test(i.src);
  const isNew = (i: PageImage) => saysNew(i) || FILE_NEW.test(i.src);
  for (const before of images.filter(isOld)) {
    const after = images.find((i) => i !== before && isNew(i) && ((saysOld(before) && saysNew(i)) || sameSubject(before.src, i.src)));
    if (after) return { before: before.src, after: after.src, from: 'article' };
  }
  return null;
}

/** A picture named as the old design: it can be the "before" of a pair, never the card's only picture. */
const isOldOnly = (img: PageImage) => (OLD.test(words(img)) && !NEW.test(words(img).replace(OLD, ''))) || FILE_OLD.test(img.src);

/** A picture whose words or file name say it shows the new design, when there is no old one to pair it with. */
export function newOnly(images: PageImage[]): string | null {
  return images.find((i) => (NEW.test(words(i)) && !OLD.test(words(i))) || FILE_NEW.test(i.src))?.src ?? null;
}

const PICK_SYSTEM = `You choose the picture for one story on a design news page for a product designer. You see the story's headline and what changed, then the pictures from its source articles, numbered.

Pick the picture that shows THE CHANGE ITSELF: the new screens, the new icons, the new logo or the new layout. Prefer a true before/after (one combined picture or a matched pair) over a new-only image when both clearly show the same reported change. Then prefer the clearest, highest-resolution picture that shows the whole change (a grid of all the new icons, the full new screen) over one that shows only part of it or only the brand's usual logo. The dimensions in brackets are source pixels; do not choose a smaller derivative when a larger exact picture is available. A photo of people, an office, a device box, an event or an unrelated product is never the answer. A thumbnail of another article is never the answer.

Also say whether the pictures show the old design next to the new one:
- "combined": the number of ONE picture that itself shows old and new together (side by side, before/after), else null.
- "before" and "after": two different pictures, one of the old design and one of the new, of the same thing, else null.

Reply with JSON only: {"best": 2, "combined": null, "before": null, "after": null, "why": "a few words"}. "best" is null if no picture visibly shows the reported change; then the story is not published.`;

const PICK_TEXT_SYSTEM = `You help a design news page show before/after pictures. For each item you get its headline and the pictures in the source articles, described ONLY by their alt text, caption and file name. You cannot see the pictures.

For each item, pick:
- "before": the index of a picture that shows the OLD design (previous logo, old screen, old app icon), or null.
- "after": the index of a picture that shows the NEW design, or null.
- "combined": the index of ONE picture that shows old and new together, or null.

Only pick an index when its words clearly say what it shows. Photos of people, offices, events and products in use are neither. If you are not sure, use null. A wrong pair is worse than none.

Reply with JSON only: {"items": [{"id": "...", "before": null, "after": 2, "combined": null}]}`;

/** Small images (thumbnails of other articles, author photos) asked for at a small width in their address. */
const TINY = /[?&](w|width|resize)=(\d{1,3})(,|&|$)/i;
const isTiny = (src: string) => {
  const m = src.match(TINY);
  return !!m && Number(m[2]) < 300;
};
/** One key per picture across hosts and sizes: i0.wp.com/site.com/x.jpg?w=1500 and site.com/x.jpg are the same. */
const keyOf = (src: string) => src.replace(/^https?:\/\/i\d\.wp\.com\//, 'https://').replace(/[?#].*$/, '').replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/^https?:\/\/(www\.)?/, '');

/** A site's stock share card (Apple's /news/images/og/app-store-connect-og.png): the same for every article, so it
    never shows the change. An article picture always beats it. */
const STOCK = /\/(og|social|share|sharing)[-_]?(images?)?\/|[-_](og|share|social)\.(png|jpe?g|webp)$|default[-_](og|share|social)|(og|share|social)[-_]default/i;
export const isStockImage = (src: string | null) => !!src && STOCK.test(src.replace(/[?#].*$/, ''));

/** Upload month in the address (WordPress: /2026/11/), as the first of that month. */
const uploadedAt = (src: string): Date | null => {
  const m = src.match(/\/(20\d\d)\/(0[1-9]|1[0-2])\//);
  return m ? new Date(`${m[1]}-${m[2]}-01T00:00:00Z`) : null;
};

/** A picture uploaded more than two months before the story belongs to an older article (Android Authority's feed
    reuses old header photos), so it cannot show this change. */
export const oldUpload = (src: string | null, publishedAt?: string) => {
  const up = src ? uploadedAt(src) : null;
  const story = publishedAt ? Date.parse(publishedAt) : NaN;
  return !!up && Number.isFinite(story) && story - up.getTime() > 62 * 86_400_000;
};

/**
 * The article pictures worth showing the model: the first few from each source, no thumbnails, no repeats, and
 * none uploaded more than two months before the story. Those belong to older articles linked on the page; a 2022
 * photo of the previous icons once passed for the new ones.
 */
export function candidatePictures(perSource: PageImage[][], current: string | null, publishedAt?: string): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();
  const story = publishedAt ? Date.parse(publishedAt) : NaN;
  const add = (img: PageImage) => {
    if (isTiny(img.src)) return;
    const up = uploadedAt(img.src);
    if (up && Number.isFinite(story) && story - up.getTime() > 62 * 86_400_000) return;
    const k = keyOf(img.src);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(img);
  };
  for (const list of perSource) list.slice(0, 5).forEach(add);
  // The page's own share picture is a candidate too, unless it is the site's stock card.
  if (current && !seen.has(keyOf(current)) && !isStockImage(current)) add({ src: current, alt: '', caption: '' });
  return out.slice(0, 8);
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Reads the intrinsic size from common web image headers without decoding or adding an image dependency. */
export function imageDimensions(buf: Buffer, type: string): ImageDimensions | null {
  if (type === 'image/png' && buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (type === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (type === 'image/webp' && buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (type === 'image/jpeg' && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buf.length) {
      if (buf[at] !== 0xff) { at++; continue; }
      const marker = buf[at + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = buf.readUInt16BE(at + 2);
      if (length < 2 || at + 2 + length > buf.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

/** Images below this size visibly blur in the enlarged viewer. Unknown formats remain eligible for the visual check. */
export function usefulImageSize(size: ImageDimensions | null): boolean {
  return !size || (Math.min(size.width, size.height) >= 300 && size.width * size.height >= 300_000);
}

/** Downloads a picture for the model. Null if it is not a picture, too small to matter, or too big to send. */
async function download(src: string, fetchImpl: typeof fetch): Promise<{ type: string; data: string; size: ImageDimensions | null } | null> {
  try {
    const res = await fetchImpl(src, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.includes(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const size = imageDimensions(buf, type);
    if (buf.length < 4_000 || buf.length > 3_500_000 || !usefulImageSize(size)) return null;
    return { type, data: buf.toString('base64'), size };
  } catch {
    return null;
  }
}

/** Does the picture load and contain enough source pixels for both the card and enlarged viewer? */
async function loads(src: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(src, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.includes(type)) {
      await res.body?.cancel();
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length >= 4_000 && usefulImageSize(imageDimensions(buf, type));
  } catch {
    return false;
  }
}

export interface CompareResult {
  items: Item[];
  usage: CallUsage | null;
  notes: string[];
}

/**
 * Sets each kept item's picture (`image`, and `compare` when there is an old/new pair).
 * imagesFor gives the article pictures for each of an item's sources, in source order.
 */
export async function addCompares(
  cfg: Config,
  items: Item[],
  imagesFor: (item: Item) => Promise<PageImage[][]>,
  llm: Llm | null,
  releaseShots: Map<string, {
    screenshot: string | null;
    screenshots?: string[];
    previousScreenshot: string | null;
    previousScreenshots?: string[];
    previousVersion: string | null;
  }>,
  /** Also used to check that each picture loads; without it, pictures are not checked (tests). */
  fetchImpl?: typeof fetch,
): Promise<CompareResult> {
  const verify = fetchImpl;
  fetchImpl ??= fetch;
  const notes: string[] = [];
  const out = items.map((i) => ({ ...i }));
  const usage: CallUsage[] = [];
  const canLook = !!(llm && llm.mode !== 'manual' && cfg.models.compare);
  const byText: { item: Item; images: PageImage[] }[] = [];

  await mapLimit(out, 3, async (item) => {
    // A before/after chosen earlier stays: re-picking must not swap a clear pair for a guess.
    if (item.compare) return;
    const perSource = await imagesFor(item);
    // Store version notes may carry screenshots from this and the previous version. They are candidates, not an
    // automatic pair: the vision model still has to confirm that they visibly show the reported change.
    const shots = releaseShots.get(item.id);
    if (shots) {
      const store: PageImage[] = [];
      const before = shots.previousScreenshots?.length ? shots.previousScreenshots : [shots.previousScreenshot].filter((s): s is string => !!s);
      const after = shots.screenshots?.length ? shots.screenshots : [shots.screenshot].filter((s): s is string => !!s);
      before.forEach((src, n) => store.push({ src, alt: `App Store screenshot ${n + 1} from version ${shots.previousVersion ?? 'before'}`, caption: '' }));
      after.forEach((src, n) => store.push({ src, alt: `App Store screenshot ${n + 1} from version ${item.release?.version ?? 'current'}`, caption: '' }));
      if (store.length) perSource.push(store);
    }
    let images = candidatePictures(perSource, item.image, item.published_at);
    if (verify) {
      const ok = await mapLimit(images, 4, async (img) => ((await loads(img.src, verify)) ? img : null));
      const kept = ok.filter((i): i is PageImage => !!i);
      for (const img of images) if (!kept.includes(img)) notes.push(`${item.id}: ${img.src.split('/')[2]} does not let other sites show ${img.src.split('/').pop()?.split('?')[0]}`);
      images = kept;
      // The card's own picture is one that doesn't load: drop it.
      if (item.image && !images.some((i) => i.src === item.image) && !(await loads(item.image, verify))) item.image = null;
    }
    if (!images.length) {
      // Nothing better on the page (or the page is blocked): a stock share card or an old reused photo is still not
      // the change, so the app icon shows instead.
      if (isStockImage(item.image) || oldUpload(item.image, item.published_at)) {
        notes.push(`${item.id}: no picture of the change could be read; the app icon shows`);
        item.image = null;
      }
      return;
    }
    // A single image still has to be verified by the vision model. Articles often have one stock header image that
    // does not show the change. With no vision model, only captions/file names that explicitly identify the new
    // design are accepted below.
    // Captions that name the old and the new picture are clearer than any guess, so they win. A pair comes from one
    // article: an old picture on one site and a new one on another may be of different changes.
    const allowed = new Set(images.map((i) => keyOf(i.src)));
    const named = perSource.map((list) => pairFromWords(list.filter((i) => allowed.has(keyOf(i.src))))).find(Boolean) ?? null;
    if (named) {
      item.compare = named;
      notes.push(`${item.id}: ${named.combined ? 'one before/after picture' : 'before and after'} from captions`);
      return;
    }

    if (canLook) {
      const got = await mapLimit(images, 4, async (img) => ({ img, file: await download(img.src, fetchImpl) }));
      const seen = got.filter((g) => g.file);
      if (seen.length >= 1) {
        const content: ContentBlock[] = [{ type: 'text', text: `Headline: ${item.headline}\nWhat changed: ${item.what}` }];
        seen.forEach((g, n) => {
          const file = g.img.src.split('/').pop()?.split('?')[0] ?? '';
          const words = [g.img.alt, g.img.caption, file].filter(Boolean).join(' / ');
          content.push({ type: 'text', text: `Picture ${n}${words ? ` (${words.slice(0, 160)})` : ''}${g.file!.size ? ` [${g.file!.size.width}x${g.file!.size.height}]` : ''}:` });
          content.push({ type: 'image', source: { type: 'base64', media_type: g.file!.type, data: g.file!.data } });
        });
        try {
          const res = await llm!.messages({ model: cfg.models.compare!, system: PICK_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 300 });
          usage.push(usageOf('pictures', cfg.models.compare!, res));
          const a = parseJsonLoose(textOf(res.content)) as { best?: unknown; combined?: unknown; before?: unknown; after?: unknown; why?: unknown };
          const pick = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < seen.length ? seen[v as number].img.src : null);
          const [best, combined, before, after] = [pick(a.best), pick(a.combined), pick(a.before), pick(a.after)];
          const why = typeof a.why === 'string' ? ` (${a.why.slice(0, 80)})` : '';
          if (combined) {
            item.compare = { before: null, after: combined, combined: true, from: 'article' };
            notes.push(`${item.id}: one picture with old and new${why}`);
          } else if (before && after && before !== after) {
            item.compare = { before, after, from: 'article' };
            notes.push(`${item.id}: old and new pictures${why}`);
          } else if (best && isOldOnly(seen.find((g) => g.img.src === best)!.img)) {
            notes.push(`${item.id}: the picture chosen shows the old design, so it is not used`);
            item.image = null;
          } else if (best) {
            if (best !== item.image) notes.push(`${item.id}: picture ${seen.findIndex((g) => g.img.src === best)} of ${seen.length} chosen${why}`);
            item.image = best;
          } else {
            // The visual check found no picture of this change. Do not keep an existing header or feed image.
            item.image = null;
            notes.push(`${item.id}: visual check found no picture of the reported change`);
          }
          return;
        } catch (err) {
          notes.push(`${item.id}: could not look at the pictures (${(err as Error).message.slice(0, 80)}); used captions`);
        }
      }
    }

    // Captions that name a pair were handled above; one that names only the new design is used as it is.
    const fresh = newOnly(images);
    if (fresh) {
      item.image = fresh;
      notes.push(`${item.id}: picture of the new design from captions`);
    } else {
      // With no usable visual result, captions/file names get one conservative chance below. Nothing is selected
      // merely because it is the first image in an article.
      item.image = null;
      byText.push({ item, images });
    }
  });

  // Without being able to look, the model still gets the pictures' words, for what captions alone don't settle.
  if (byText.length && canLook) {
    const input = {
      items: byText.map(({ item, images }) => ({
        id: item.id,
        headline: item.headline,
        kind: item.kind,
        pictures: images.map((img, i) => ({ i, alt: img.alt, caption: img.caption, file: img.src.split('/').pop()?.split('?')[0] ?? '' })),
      })),
    };
    try {
      const res = await llm!.messages({ model: cfg.models.compare!, system: PICK_TEXT_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 2000 });
      usage.push(usageOf('compare', cfg.models.compare!, res));
      const answer = parseJsonLoose(textOf(res.content)) as { items?: { id?: string; before?: unknown; after?: unknown; combined?: unknown }[] };
      for (const a of answer.items ?? []) {
        const job = byText.find((j) => j.item.id === a.id);
        if (!job) continue;
        const pick = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < job.images.length ? job.images[v as number].src : null);
        const [combined, before, after] = [pick(a.combined), pick(a.before), pick(a.after)];
        if (combined) job.item.compare = { before: null, after: combined, combined: true, from: 'article' };
        else if (before && after && before !== after) job.item.compare = { before, after, from: 'article' };
        else if (after) job.item.image = after;
      }
    } catch (err) {
      notes.push(`picture step skipped: ${(err as Error).message}`);
    }
  }
  // One usage line for the whole step, so the run's cost report stays short.
  const total: CallUsage | null = usage.length
    ? usage.reduce((a, u) => ({ ...a, input_tokens: a.input_tokens + u.input_tokens, output_tokens: a.output_tokens + u.output_tokens, credits: (a.credits ?? 0) + (u.credits ?? 0) }), { ...usage[0], step: 'pictures', input_tokens: 0, output_tokens: 0, credits: 0 })
    : null;
  return { items: out, usage: total, notes };
}
