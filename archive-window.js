// Which earlier days the News page shows. The archive opens with the two weeks before today's paper; each
// "View more" adds two more weeks. Pure functions, so they can be tested without a browser.

export const WINDOW_DAYS = 14;

const toDay = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;
const fromDay = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/**
 * The oldest date (YYYY-MM-DD) still shown when `steps` windows are open, counted back from `anchor`, the date of
 * today's paper. With anchor 2026-11-16 and one step, 2 to 15 Nov are shown: 14 calendar days.
 */
export function archiveCutoff(anchor, steps = 1) {
  return fromDay(toDay(anchor) - WINDOW_DAYS * Math.max(1, steps));
}


const time = (iso) => Date.parse(iso) || 0;

/** Cards newest first by when they were published, whatever order they were collected in. */
export const newestFirst = (items) => [...items].sort((a, b) => time(b.published_at) - time(a.published_at));

/**
 * The Earlier list: cards grouped by the day they were published (item.date, in the reader's time zone), newest day
 * first and newest card first within each day, whatever edition collected them. A day an edition found nothing shows
 * as a quiet day when no card was published that day. An edition's pattern note goes with its newest card's day.
 */
export function groupByPublishedDay(days) {
  const groups = new Map();
  const group = (date) => {
    if (!groups.has(date)) groups.set(date, { date, items: [], quiet: false, pattern: null, pattern_zh: null });
    return groups.get(date);
  };
  for (const day of days) {
    for (const item of day.items) group(item.date || day.date).items.push(item);
    if (day.pattern && day.items.length) {
      const g = group(newestFirst(day.items)[0].date || day.date);
      g.pattern ??= day.pattern;
      g.pattern_zh ??= day.pattern_zh ?? null;
    }
  }
  for (const day of days) if ((day.quiet || !day.items.length) && !groups.has(day.date)) groups.set(day.date, { date: day.date, items: [], quiet: true, pattern: null, pattern_zh: null });
  for (const g of groups.values()) g.items = newestFirst(g.items);
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}
