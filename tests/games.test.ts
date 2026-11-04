import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain JavaScript from the site, no types
import { adjacent, canStep, clock, dailyWord, dayNumber, nextNumber, scoreGuess, shareRows, zipPuzzle, zipSolved } from '../site/games-logic.js';
// @ts-expect-error plain JavaScript from the site, no types
import { WORDS } from '../site/games-words.js';

test('puzzle numbers follow the reader’s calendar day', () => {
  assert.equal(dayNumber(new Date(2026, 10, 3, 0, 5)), 1);
  assert.equal(dayNumber(new Date(2026, 10, 3, 23, 55)), 1);
  assert.equal(dayNumber(new Date(2026, 10, 4, 0, 1)), 2);
  assert.equal(dayNumber(new Date(2027, 10, 3, 12)), 366);
});

test('every Zip puzzle has one path through every square, through the numbers in order', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const p = zipPuzzle(seed);
    const { size, solution, marks } = p;
    assert.equal(new Set(solution).size, size * size, `seed ${seed}: every square once`);
    for (let i = 1; i < solution.length; i++) assert.ok(adjacent(size, solution[i - 1], solution[i]), `seed ${seed}: unbroken`);
    const order = solution.map((c: number) => marks[c]).filter(Boolean);
    assert.deepEqual(order, Array.from({ length: p.count }, (_, k) => k + 1), `seed ${seed}: numbers in order`);
    assert.equal(marks[solution[0]], 1);
    assert.equal(marks[solution[solution.length - 1]], p.count);
    // Walking the solution step by step is allowed all the way, and solves it.
    const path: number[] = [];
    for (const c of solution) {
      assert.ok(canStep(p, path, c), `seed ${seed}: step to ${c}`);
      path.push(c);
    }
    assert.ok(zipSolved(p, path));
  }
  assert.deepEqual(zipPuzzle(7), zipPuzzle(7), 'the same seed, the same puzzle');
  assert.notDeepEqual(zipPuzzle(7).solution, zipPuzzle(8).solution);
});

test('Zip: the path starts on 1, takes the numbers in order, and stops at the last one', () => {
  const p = zipPuzzle(3);
  const one = p.marks.indexOf(1);
  const notOne = p.marks.findIndex((m: number) => m === 0);
  assert.equal(canStep(p, [], notOne), false);
  assert.equal(canStep(p, [], one), true);
  const two = p.marks.indexOf(2);
  // Jumping straight to 3 next to 1 is refused when 2 is not reached yet.
  const path = [one];
  assert.equal(nextNumber(p, path), 2);
  for (let c = 0; c < p.marks.length; c++) if (p.marks[c] > 2 && adjacent(p.size, one, c)) assert.equal(canStep(p, path, c), false);
  assert.equal(canStep(p, path, path[0]), false, 'no square twice');
  assert.ok(two >= 0);
  const done = p.solution.slice();
  assert.equal(canStep(p, done, done[0]), false, 'nothing after the last number');
});

test('Word: right place first, then wrong place, and a repeated letter counts once per copy in the answer', () => {
  assert.deepEqual(scoreGuess('PIXEL', 'PIXEL'), [2, 2, 2, 2, 2]);
  assert.deepEqual(scoreGuess('LAYER', 'PIXEL'), [1, 0, 0, 2, 0]);
  assert.deepEqual(scoreGuess('LLAMA', 'LABEL'), [2, 1, 1, 0, 0], 'two Ls, LABEL has two');
  assert.deepEqual(scoreGuess('EERIE', 'SERIF'), [0, 2, 2, 2, 0], 'SERIF has one E, already used in place');
  assert.deepEqual(scoreGuess('AAAAA', 'ALIGN'), [2, 0, 0, 0, 0]);
  assert.equal(shareRows([[0, 1, 2]]), '⬛🟧🟪');
  assert.equal(clock(75), '1:15');
});

test('Word: every answer is five capital letters, once each, with both meanings; a new word every day for months', () => {
  for (const [w, en, zh] of WORDS) {
    assert.match(w, /^[A-Z]{5}$/);
    assert.ok(en.length > 5 && zh.length > 2, w);
  }
  assert.equal(new Set(WORDS.map((w: string[]) => w[0])).size, WORDS.length, 'no repeats');
  const run = Array.from({ length: WORDS.length }, (_, i) => dailyWord(i + 1, WORDS)[0]);
  assert.equal(new Set(run).size, WORDS.length, 'each word once before any comes back');
  assert.deepEqual(dailyWord(1 + WORDS.length, WORDS), dailyWord(1, WORDS));
});
