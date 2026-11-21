// The games' rules, with no page code in them, so the tests can run them in Node.

/** A small seeded random number generator (mulberry32): the same seed gives the same numbers. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = Date.UTC(2026, 10, 3); // puzzle No. 1 is 3 Nov 2026
/** Today's puzzle number on the reader's own calendar: 1 on 3 Nov 2026, one more each day after. */
export function dayNumber(now = new Date()) {
  return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - FIRST) / 86_400_000) + 1;
}

/* ---------- Zip: one line through every square, through the numbers in order ---------- */

const neighbours = (size, c) => {
  const x = c % size;
  const out = [];
  if (x > 0) out.push(c - 1);
  if (x < size - 1) out.push(c + 1);
  if (c >= size) out.push(c - size);
  if (c < size * (size - 1)) out.push(c + size);
  return out;
};

export const adjacent = (size, a, b) => neighbours(size, a).includes(b);

/** A random path through every square of a size×size grid. It starts as a zigzag and is then reshaped many times
    by "backbite" moves: the end of the path joins a square next to it, and the loop this makes is turned around.
    Every move keeps it one unbroken path through every square. */
export function zipPath(size, rand) {
  let path = [];
  for (let y = 0; y < size; y++) for (let i = 0; i < size; i++) path.push(y * size + (y % 2 ? size - 1 - i : i));
  const moves = size * size * 40;
  for (let k = 0; k < moves; k++) {
    if (rand() < 0.5) path.reverse();
    const end = path[path.length - 1];
    const options = neighbours(size, end).filter((d) => d !== path[path.length - 2]);
    const d = options[Math.floor(rand() * options.length)];
    const i = path.indexOf(d);
    path = path.slice(0, i + 1).concat(path.slice(i + 1).reverse());
  }
  return path;
}

/** A Zip puzzle from a seed: the numbered squares (marks[cell] is its number, 0 for none) and one solution. */
export function zipPuzzle(seed, size = 6, count = 9) {
  const rand = rng(seed);
  const solution = zipPath(size, rand);
  const n = size * size;
  const at = [0];
  for (let j = 1; j < count - 1; j++) {
    const base = Math.round((j * (n - 1)) / (count - 1)) + Math.floor(rand() * 3) - 1;
    at.push(Math.min(n - 2 - (count - 2 - j), Math.max(at[at.length - 1] + 2, base)));
  }
  at.push(n - 1);
  const marks = new Array(n).fill(0);
  at.forEach((pos, k) => (marks[solution[pos]] = k + 1));
  return { size, count, marks, solution };
}

/** The next number the path has to reach. */
export const nextNumber = (p, path) => 1 + Math.max(0, ...path.map((c) => p.marks[c]));

/** Can the path go on into `next`? It has to start on 1, touch the last square, be new, take the numbers in
    order, and stop at the last number. */
export function canStep(p, path, next) {
  if (!path.length) return p.marks[next] === 1;
  const last = path[path.length - 1];
  if (p.marks[last] === p.count) return false;
  if (path.includes(next) || !adjacent(p.size, last, next)) return false;
  const m = p.marks[next];
  return !m || m === nextNumber(p, path);
}

export const zipSolved = (p, path) => path.length === p.size * p.size && p.marks[path[path.length - 1]] === p.count;

/* ---------- Word: guess the five-letter design word ---------- */

/** Colours for a guess: 2 in the right place, 1 in the word but elsewhere, 0 not in it. A repeated letter only
    counts as often as the answer has it, and right-place letters count first. */
export function scoreGuess(guess, answer) {
  const res = [0, 0, 0, 0, 0];
  const left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) res[i] = 2;
    else left[answer[i]] = (left[answer[i]] ?? 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] !== 2 && left[guess[i]] > 0) {
      res[i] = 1;
      left[guess[i]]--;
    }
  }
  return res;
}

/** The day's word: the list in a fixed shuffled order, one a day, starting over when it runs out. */
export function dailyWord(day, words) {
  const order = words.map((_, i) => i);
  const rand = rng(20261103);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const k = (((day - 1) % order.length) + order.length) % order.length;
  return words[order[k]];
}

/** The squares to share, like Wordle's, in the page's own colours. */
export const shareRows = (rows) => rows.map((r) => r.map((s) => ['⬛', '🟧', '🟪'][s]).join('')).join('\n');

/** Seconds as m:ss. */
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Milliseconds until the reader's next midnight, when the next Zip and Word arrive. */
export const untilTomorrow = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

/** A countdown as h:mm:ss. */
export const countdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
