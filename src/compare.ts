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

/** Clear cases only. Returns null when the words don't settle it. */
export function pairFromWords(images: PageImage[]): Compare | null {
  const both = images.find((i) => BOTH.test(words(i)));
  if (both) return { before: null, after: both.src, combined: true, from: 'article' };
  const isOld = (i: PageImage) => (OLD.test(words(i)) && !NEW.test(words(i).replace(OLD, ''))) || FILE_OLD.test(i.src);
  const isNew = (i: PageImage) => (NEW.test(words(i)) && !OLD.test(words(i))) || FILE_NEW.test(i.src);
  const before = images.find(isOld);
  const after = images.find((i) => i !== before && isNew(i));
  return before && after ? { before: before.src, after: after.src, from: 'article' } : null;
}

/** A picture whose words or file name say it shows the new design, when there is no old one to pair it with. */
export function newOnly(images: PageImage[]): string | null {
  return images.find((i) => (NEW.test(words(i)) && !OLD.test(words(i))) || FILE_NEW.test(i.src))?.src ?? null;
}

const PICK_SYSTEM = `You choose the picture for one story on a design news page for a product designer. You see the story's headline and what changed, then the pictures from its source articles, numbered.

Pick the picture that shows THE CHANGE ITSELF: the new screens, the new icons, the new logo or the new layout. Prefer a picture that shows the whole change (a grid of all the new icons, the full new screen) over one that shows only part of it or only the brand's usual logo. A photo of people, an office, a device box, an event or an unrelated product is never the answer. A thumbnail of another article is never the answer.

Also say whether the pictures show the old design next to the new one:
- "combined": the number of ONE picture that itself shows old and new together (side by side, before/after), else null.
- "before" and "after": two different pictures, one of the old design and one of the new, of the same thing, else null.

Reply with JSON only: {"best": 2, "combined": null, "before": null, "after": null, "why": "a few words"}. "best" is null if no picture shows the change; then the page keeps its current picture.`;

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

/** Upload month in the address (WordPress: /2026/11/), as the first of that month. */
const uploadedAt = (src: string): Date | null => {
  const m = src.match(/\/(20\d\d)\/(0[1-9]|1[0-2])\//);
  return m ? new Date(`${m[1]}-${m[2]}-01T00:00:00Z`) : null;
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
  if (current && !seen.has(keyOf(current))) add({ src: current, alt: '', caption: '' });
  return out.slice(0, 8);
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Downloads a picture for the model. Null if it is not a picture, too small to matter, or too big to send. */
async function download(src: string, fetchImpl: typeof fetch): Promise<{ type: string; data: string } | null> {
  try {
    const res = await fetchImpl(src, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES.includes(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4_000 || buf.length > 3_500_000) return null;
    return { type, data: buf.toString('base64') };
  } catch {
    return null;
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
  releaseShots: Map<string, { before: string | null; after: string | null; beforeVersion: string | null }>,
  fetchImpl: typeof fetch = fetch,
): Promise<CompareResult> {
  const notes: string[] = [];
  const out = items.map((i) => ({ ...i }));
  const usage: CallUsage[] = [];
  const canLook = !!(llm && llm.mode !== 'manual' && cfg.models.compare);
  const byText: { item: Item; images: PageImage[] }[] = [];

  await mapLimit(out, 3, async (item) => {
    const shots = releaseShots.get(item.id);
    if (shots) {
      if (shots.after && shots.before && shots.before !== shots.after) {
        item.compare = { before: shots.before, after: shots.after, from: 'app-store', before_version: shots.beforeVersion ?? undefined };
        notes.push(`${item.id}: App Store screenshots of ${shots.beforeVersion} and ${item.release?.version}`);
      } else if (shots.after) item.image = shots.after;
      return;
    }
    // A before/after chosen earlier stays: re-picking must not swap a clear pair for a guess.
    if (item.compare) return;
    // With one picture or none there is nothing to choose between.
    const images = candidatePictures(await imagesFor(item), item.image, item.published_at);
    if (images.length < 2) return;
    // Captions that name the old and the new picture are clearer than any guess, so they win.
    const named = pairFromWords(images);
    if (named) {
      item.compare = named;
      notes.push(`${item.id}: ${named.combined ? 'one before/after picture' : 'before and after'} from captions`);
      return;
    }

    if (canLook) {
      const got = await mapLimit(images, 4, async (img) => ({ img, file: await download(img.src, fetchImpl) }));
      const seen = got.filter((g) => g.file);
      if (seen.length >= 2) {
        const content: ContentBlock[] = [{ type: 'text', text: `Headline: ${item.headline}\nWhat changed: ${item.what}` }];
        seen.forEach((g, n) => {
          const file = g.img.src.split('/').pop()?.split('?')[0] ?? '';
          const words = [g.img.alt, g.img.caption, file].filter(Boolean).join(' / ');
          content.push({ type: 'text', text: `Picture ${n}${words ? ` (${words.slice(0, 160)})` : ''}:` });
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
          } else {
            if (best) {
              if (best !== item.image) notes.push(`${item.id}: picture ${seen.findIndex((g) => g.img.src === best)} of ${seen.length} chosen${why}`);
              item.image = best;
            }
          }
          return;
        } catch (err) {
          notes.push(`${item.id}: could not look at the pictures (${(err as Error).message.slice(0, 80)}); used captions`);
        }
      }
    }

    const pair = pairFromWords(images);
    const fresh = pair ? null : newOnly(images);
    if (pair) {
      item.compare = pair;
      notes.push(`${item.id}: ${pair.combined ? 'one before/after picture' : 'before and after'} from captions`);
    } else if (fresh) {
      item.image = fresh;
      notes.push(`${item.id}: picture of the new design from captions`);
    } else byText.push({ item, images });
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
