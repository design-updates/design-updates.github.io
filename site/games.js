// Games: Zip, Word and Snake. Loaded only when the Games tab opens. Scores stay in this browser (localStorage).
// Zip and Word are one puzzle a day, the same for everyone; Snake never ends.

import { dayNumber } from './games-logic.js';
import { snakeGame } from './games-snake.js';
import { wordGame } from './games-word.js';
import { zipGame } from './games-zip.js';

const S = {
  en: {
    names: { zip: 'Zip', word: 'Word', snake: 'Snake' },
    pick: 'Pick a game',
    no: (n) => `No. ${n}`,
    best: 'Best', streak: 'Streak', played: 'Played', wonPct: 'Won', time: 'Time', score: 'Score',
    share: 'Copy result', copied: 'Copied',
    zip: {
      help: 'Draw one line through every square. Start at 1 and pass the numbers in order. Drag with a finger or the mouse, or use the arrow keys.',
      undo: 'Undo', clear: 'Clear', practice: 'Practice puzzle', daily: "Today's puzzle",
      solved: (t) => `Solved in ${t}.`, cover: 'Every square has to be on the line.', next: (n) => `Next number: ${n}.`,
      label: (n) => `Zip puzzle, ${n} by ${n}. Arrow keys draw the line, Backspace takes a step back.`,
      practiceNote: 'Practice: not counted.', tomorrow: 'A new puzzle tomorrow.',
      shareText: (n, t) => `Pixel Post Zip No. ${n} · ${t}`,
    },
    word: {
      help: 'Guess the five-letter design word in six tries. Purple: right letter, right place. Orange with cut corners: in the word, wrong place. Grey: not in the word.',
      enter: 'Enter', del: 'Delete', short: 'Five letters, please.',
      won: (n) => (n === 1 ? 'Got it in one.' : `Got it in ${n}.`), lost: (w) => `The word was ${w}.`,
      state: { 2: 'right place', 1: 'wrong place', 0: 'not in the word' }, board: 'Your guesses',
      tomorrow: 'A new word tomorrow.', shareText: (n, k) => `Pixel Post Word No. ${n} · ${k}/6`,
    },
    snake: {
      help: 'Eat the dots. Miss the walls and your own tail. Arrow keys or WASD, swipe on the board, or the buttons. Space pauses.',
      start: 'Start', again: 'Play again', pause: 'Pause', resume: 'Resume',
      over: (n) => `Game over. Score ${n}.`, record: 'New best.', label: 'Snake board',
      dirs: { up: 'Up', down: 'Down', left: 'Left', right: 'Right' },
    },
  },
  zh: {
    names: { zip: 'Zip 连线', word: 'Word 猜词', snake: 'Snake 贪吃蛇' },
    pick: '选择游戏',
    no: (n) => `第 ${n} 期`,
    best: '最佳', streak: '连续', played: '已玩', wonPct: '胜率', time: '用时', score: '得分',
    share: '复制结果', copied: '已复制',
    zip: {
      help: '用一条线经过每一个方格。从 1 出发，按顺序经过所有数字。用手指或鼠标拖动画线，或用方向键。',
      undo: '撤销', clear: '清空', practice: '练习一题', daily: '今日题目',
      solved: (t) => `用时 ${t} 完成。`, cover: '每个方格都要在线上。', next: (n) => `下一个数字：${n}。`,
      label: (n) => `Zip 谜题，${n} × ${n}。方向键画线，退格键后退一步。`,
      practiceNote: '练习题不计入成绩。', tomorrow: '明天有新题。',
      shareText: (n, t) => `Pixel Post Zip 第 ${n} 期 · ${t}`,
    },
    word: {
      help: '六次之内猜出一个五个字母的设计词（英文）。紫色：字母和位置都对。橙色缺角：有这个字母，位置不对。灰色：没有这个字母。',
      enter: '确定', del: '删除', short: '请输入五个字母。',
      won: (n) => `第 ${n} 次猜中。`, lost: (w) => `答案是 ${w}。`,
      state: { 2: '位置正确', 1: '位置不对', 0: '不在词中' }, board: '你的猜测',
      tomorrow: '明天换一个新词。', shareText: (n, k) => `Pixel Post Word 第 ${n} 期 · ${k}/6`,
    },
    snake: {
      help: '吃掉圆点，别撞墙，也别撞到自己的尾巴。用方向键或 WASD、在游戏区滑动，或点按钮。空格键暂停。',
      start: '开始', again: '再来一局', pause: '暂停', resume: '继续',
      over: (n) => `游戏结束，得分 ${n}。`, record: '新纪录。', label: 'Snake 游戏区',
      dirs: { up: '上', down: '下', left: '左', right: '右' },
    },
  },
};

const ORDER = ['zip', 'word', 'snake'];
const store = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`pp.games.${k}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`pp.games.${k}`, JSON.stringify(v));
    } catch {}
  },
};

let lang = 'en';
let root = null;
let current = null;
let games = null;

/** Copies the result; where the browser won't, shows it in a box to copy by hand. */
async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = S[lang].copied;
    setTimeout(() => (btn.textContent = was), 1600);
  } catch {
    const box = document.createElement('textarea');
    box.className = 'game-copy';
    box.readOnly = true;
    box.value = text;
    btn.after(box);
    box.select();
  }
}

const ctx = { s: () => S[lang], lang: () => lang, store, copy, day: () => dayNumber(), link: () => `${location.origin}${location.pathname}#games` };

function paint() {
  const s = S[lang];
  root.innerHTML = `<div class="archive-head">
      <h2 class="section-title">${s.names[current]}</h2>
      <div class="filters" role="group" aria-label="${s.pick}">${ORDER.map((k) => `<button class="chip" type="button" data-game="${k}" aria-pressed="${k === current}">${s.names[k]}</button>`).join('')}</div>
    </div>
    <div class="game-card" id="game-card"></div>`;
  games[current].render(root.querySelector('#game-card'));
}

/** Draws the Games page into `el` in `language`. Called each time the tab opens and after the 中/EN switch. */
export function showGames(el, language) {
  lang = language;
  if (!games) {
    games = { zip: zipGame(ctx), word: wordGame(ctx), snake: snakeGame(ctx) };
    current = ORDER.includes(store.get('pick')) ? store.get('pick') : 'zip';
    root = el;
    root.addEventListener('click', (e) => {
      const k = e.target.closest('[data-game]')?.dataset.game;
      if (!k || k === current) return;
      games[current].pause?.();
      current = k;
      store.set('pick', k);
      paint();
    });
    // Typing and arrow keys go to the game on screen, unless a text box or the Saved dialog has them.
    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.view !== 'games' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, dialog')) return;
      games[current].key?.(e);
    });
    document.addEventListener('visibilitychange', () => document.hidden && leaveGames());
  }
  paint();
}

/** Pauses Snake and the Zip clock when the page goes away. */
export function leaveGames() {
  for (const g of Object.values(games ?? {})) g.pause?.();
}
