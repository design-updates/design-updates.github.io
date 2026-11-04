// Zip: draw one line through every square of the grid, passing the numbers in order. One puzzle a day.

import { canStep, clock, nextNumber, zipPuzzle, zipSolved } from './games-logic.js';

export function zipGame(ctx) {
  let mode = 'daily'; // or 'practice', a random puzzle that is not counted
  let p = null;
  let path = [];
  let forDay = 0;
  let spent = 0; // seconds on the clock before the current stretch
  let since = 0; // when the clock last started; 0 while stopped
  let solved = false;
  let card = null;
  let ticker = 0;
  let dragging = false;

  const secs = () => spent + (since ? (Date.now() - since) / 1000 : 0);
  const save = () => mode === 'daily' && p && ctx.store.set('zip.day', { day: forDay, path, spent: secs(), solved });

  function start(next) {
    pause();
    mode = next;
    forDay = ctx.day();
    path = [];
    spent = 0;
    if (mode === 'daily') {
      p = zipPuzzle(forDay * 7919 + 17);
      // Today's line so far, step by step, so a damaged save can't break the rules.
      const saved = ctx.store.get('zip.day', null);
      if (saved?.day === forDay) {
        for (const c of saved.path ?? []) {
          if (!canStep(p, path, c)) break;
          path.push(c);
        }
        spent = Number(saved.spent) || 0;
      }
    } else {
      p = zipPuzzle(Math.floor(Math.random() * 2 ** 31));
    }
    solved = zipSolved(p, path);
  }

  function pause() {
    if (since) {
      spent = secs();
      since = 0;
    }
    clearInterval(ticker);
    ticker = 0;
    save();
  }

  function run() {
    if (since || solved || !path.length) return;
    since = Date.now();
    ticker = setInterval(paintTime, 250);
  }

  function stats() {
    const st = ctx.store.get('zip.stats', { played: 0, streak: 0, last: 0, best: null });
    if (st.last < ctx.day() - 1) st.streak = 0; // a missed day ends the streak
    return st;
  }

  function record() {
    const st = ctx.store.get('zip.stats', { played: 0, streak: 0, last: 0, best: null });
    if (st.last === forDay) return;
    st.streak = st.last === forDay - 1 ? st.streak + 1 : 1;
    st.last = forDay;
    st.played++;
    st.best = st.best == null ? secs() : Math.min(st.best, secs());
    ctx.store.set('zip.stats', st);
  }

  /** After every change: stop the clock on a solve, save, and redraw the line and the status. */
  function changed() {
    if (!solved && zipSolved(p, path)) {
      solved = true;
      pause();
      if (mode === 'daily') record();
    } else {
      run();
      save();
    }
    paintBoard();
    paintStatus();
  }

  /** Walks the line from its end to `c`, one square at a time, so a quick drag doesn't skip squares. */
  function toward(c) {
    let moved = false;
    for (let n = 0; n < p.size * 2 && path.length; n++) {
      const head = path[path.length - 1];
      if (head === c) break;
      const hx = head % p.size;
      const hy = Math.floor(head / p.size);
      const options = [];
      if (c % p.size !== hx) options.push(head + Math.sign((c % p.size) - hx));
      if (Math.floor(c / p.size) !== hy) options.push(head + Math.sign(Math.floor(c / p.size) - hy) * p.size);
      const go = options.find((o) => canStep(p, path, o));
      if (go === undefined) break;
      path.push(go);
      moved = true;
    }
    return moved;
  }

  /** A square the line already passes: going back there takes the line back to it. */
  function backTo(c) {
    const i = path.indexOf(c);
    if (i < 0 || i === path.length - 1) return false;
    path.length = i + 1;
    return true;
  }

  const cellAt = (e) => Number(document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.zip-cell')?.dataset.c ?? NaN);

  function wire(board) {
    board.addEventListener('pointerdown', (e) => {
      const c = cellAt(e);
      if (solved || Number.isNaN(c)) return;
      e.preventDefault();
      board.focus({ preventScroll: true });
      dragging = true;
      board.setPointerCapture?.(e.pointerId);
      if (!path.length ? canStep(p, path, c) && path.push(c) : backTo(c) || toward(c)) changed();
    });
    board.addEventListener('pointermove', (e) => {
      if (!dragging || solved) return;
      const c = cellAt(e);
      if (!Number.isNaN(c) && (backTo(c) || toward(c))) changed();
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) board.addEventListener(ev, () => (dragging = false));
  }

  function key(e) {
    if (solved) return;
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -p.size, ArrowDown: p.size }[e.key];
    if (d !== undefined) {
      e.preventDefault();
      if (!path.length) {
        path.push(p.marks.indexOf(1));
        return changed();
      }
      const head = path[path.length - 1];
      const next = head + d;
      if ((d === -1 && head % p.size === 0) || (d === 1 && head % p.size === p.size - 1) || next < 0 || next >= p.size * p.size) return;
      if (path[path.length - 2] === next) path.pop();
      else if (canStep(p, path, next)) path.push(next);
      else return;
      changed();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && path.length) {
      e.preventDefault();
      path.pop();
      changed();
    }
  }

  function paintBoard() {
    const board = card?.querySelector('#zip-board');
    if (!board) return;
    const at = new Map(path.map((c, i) => [c, i]));
    for (const cell of board.children) {
      const c = Number(cell.dataset.c);
      const i = at.get(c);
      let h = '';
      if (i !== undefined) {
        h += '<span class="zip-seg c"></span>';
        for (const o of [path[i - 1], path[i + 1]]) if (o !== undefined) h += `<span class="zip-seg ${o === c - 1 ? 'l' : o === c + 1 ? 'r' : o < c ? 'u' : 'd'}"></span>`;
      }
      if (p.marks[c]) h += `<span class="zip-num">${p.marks[c]}</span>`;
      cell.innerHTML = h;
      cell.classList.toggle('head', c === path[path.length - 1] && !solved);
    }
    board.classList.toggle('solved', solved);
  }

  function paintTime() {
    const t = card?.querySelector('[data-zip-time]');
    if (t) t.textContent = clock(secs());
  }

  function paintStatus() {
    const s = ctx.s();
    const st = stats();
    const item = (dt, dd, attr = '') => `<div><dt>${dt}</dt><dd${attr}>${dd}</dd></div>`;
    card.querySelector('#zip-stats').innerHTML = [
      item(mode === 'daily' ? s.zip.daily : s.zip.practice, mode === 'daily' ? s.no(forDay) : '–'),
      item(s.time, clock(secs()), ' data-zip-time'),
      mode === 'daily' ? item(s.best, st.best == null ? '–' : clock(st.best)) : '',
      mode === 'daily' ? item(s.streak, st.streak) : '',
    ].join('');
    const last = path[path.length - 1];
    const text = solved
      ? `${s.zip.solved(clock(secs()))} ${mode === 'daily' ? s.zip.tomorrow : s.zip.practiceNote}`
      : path.length && p.marks[last] === p.count
        ? s.zip.cover
        : s.zip.next(nextNumber(p, path));
    const msg = card.querySelector('#zip-msg');
    if (msg.textContent !== text) msg.textContent = text;
    const none = !path.length || solved;
    card.querySelector('#zip-actions').innerHTML = [
      `<button class="act" type="button" data-zip="undo"${none ? ' disabled' : ''}>${s.zip.undo}</button>`,
      `<button class="act" type="button" data-zip="clear"${none ? ' disabled' : ''}>${s.zip.clear}</button>`,
      solved && mode === 'daily' ? `<button class="act" type="button" data-zip="share">${s.share}</button>` : '',
      `<button class="act" type="button" data-zip="mode">${mode === 'daily' ? s.zip.practice : s.zip.daily}</button>`,
    ].join('');
  }

  function onClick(e) {
    const a = e.target.closest('[data-zip]')?.dataset.zip;
    if (a === 'undo' && path.length) path.pop();
    else if (a === 'clear') path = [];
    else if (a === 'share') return ctx.copy(`${ctx.s().zip.shareText(forDay, clock(secs()))}\n${ctx.link()}`, e.target.closest('button'));
    else if (a === 'mode') return start(mode === 'daily' ? 'practice' : 'daily'), render(card);
    else return;
    changed();
  }

  function render(el) {
    if (!p || (mode === 'daily' && forDay !== ctx.day())) start('daily');
    card = el;
    const s = ctx.s();
    card.innerHTML = `<p class="game-help">${s.zip.help}</p>
      <dl class="game-stats" id="zip-stats"></dl>
      <div class="game-board zip-board" id="zip-board" tabindex="0" role="group" aria-label="${s.zip.label(p.size)}" aria-describedby="zip-msg" style="--size: ${p.size}">${Array.from({ length: p.size * p.size }, (_, c) => `<div class="zip-cell" data-c="${c}"></div>`).join('')}</div>
      <p class="game-msg" id="zip-msg" aria-live="polite"></p>
      <div class="game-actions" id="zip-actions"></div>`;
    wire(card.querySelector('#zip-board'));
    if (!card.dataset.wired) {
      card.dataset.wired = '1';
      card.addEventListener('click', onClick);
    }
    paintBoard();
    paintStatus();
    if (since) ticker ||= setInterval(paintTime, 250);
  }

  return { render, key, pause };
}
