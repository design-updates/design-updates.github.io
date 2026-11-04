// Zip: draw one line through every square of the grid, passing the numbers in order. One puzzle a day.
// When it is solved, the line lights up square by square, then the board turns into a score card that counts
// down to tomorrow's puzzle. "Show my line" brings the finished board back.

import { canStep, clock, countdown, nextNumber, untilTomorrow, zipPuzzle, zipSolved } from './games-logic.js';

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
  let finishing = false; // the solve animation is playing
  let fresh = false; // solved just now, so the score card bursts in
  let showLine = false; // the finished board instead of the score card
  let wait = 0; // the timer that ends the solve animation
  let tick = 0; // the countdown on the score card

  const done = () => solved && !finishing && !showLine;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('still');

  const secs = () => spent + (since ? (Date.now() - since) / 1000 : 0);
  const save = () => mode === 'daily' && p && ctx.store.set('zip.day', { day: forDay, path, spent: secs(), solved });

  function start(next) {
    pause();
    mode = next;
    showLine = false;
    fresh = false;
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
    clearTimeout(wait);
    clearInterval(tick);
    tick = 0;
    finishing = false;
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

  /** After every change: stop the clock on a solve, save, and redraw the line and the status. A solve plays the
      line lighting up, then swaps the board for the score card. */
  function changed() {
    if (!solved && zipSolved(p, path)) {
      solved = true;
      pause();
      if (mode === 'daily') record();
      fresh = true;
      if (!still()) {
        finishing = true;
        wait = setTimeout(() => {
          finishing = false;
          if (card?.isConnected) render(card);
        }, 900 + path.length * 28);
      }
      paintBoard();
      if (!finishing) return render(card);
      paintStatus();
      return;
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
      cell.style.setProperty('--k', i ?? 0);
      cell.classList.toggle('head', c === path[path.length - 1] && !solved);
    }
    board.classList.toggle('solved', solved);
    board.classList.toggle('finishing', finishing);
    board.style.setProperty('--len', path.length);
  }

  function paintTime() {
    const t = card?.querySelector('[data-zip-time]');
    if (t) t.textContent = clock(secs());
  }

  function paintStatus() {
    const s = ctx.s();
    const st = stats();
    const item = (dt, dd, attr = '') => `<div><dt>${dt}</dt><dd${attr}>${dd}</dd></div>`;
    const box = card.querySelector('#zip-stats');
    if (box)
      box.innerHTML = [
        item(mode === 'daily' ? s.zip.daily : s.zip.practice, mode === 'daily' ? s.no(forDay) : '–'),
        item(s.time, clock(secs()), ' data-zip-time'),
        mode === 'daily' ? item(s.best, st.best == null ? '–' : clock(st.best)) : '',
        mode === 'daily' ? item(s.streak, st.streak) : '',
      ].join('');
    const last = path[path.length - 1];
    const text = solved
      ? `${s.zip.solved(clock(secs()))}${mode === 'daily' ? `${ctx.lang() === 'zh' ? '' : ' '}${s.zip.comeBack}` : ''}`
      : path.length && p.marks[last] === p.count
        ? s.zip.cover
        : s.zip.next(nextNumber(p, path));
    const msg = card.querySelector('#zip-msg');
    if (msg.textContent !== text) msg.textContent = text;
    const btn = (a, label, off = false) => `<button class="act" type="button" data-zip="${a}"${off ? ' disabled' : ''}>${label}</button>`;
    card.querySelector('#zip-actions').innerHTML = finishing
      ? ''
      : solved
        ? [
            mode === 'daily' ? btn('share', s.share) : btn('again', s.zip.another),
            btn('line', showLine ? s.zip.backToScore : s.zip.showLine),
            btn('mode', mode === 'daily' ? s.zip.practice : s.zip.daily),
          ].join('')
        : [btn('undo', s.zip.undo, !path.length), btn('clear', s.zip.clear, !path.length), btn('mode', mode === 'daily' ? s.zip.practice : s.zip.daily)].join('');
  }

  /** The score card that takes the board's place once the puzzle is solved. */
  function doneHtml() {
    const s = ctx.s();
    const st = stats();
    const t = secs();
    const best = mode === 'daily' && st.played > 1 && st.best != null && Math.abs(st.best - t) < 0.5;
    const burst = fresh && !still() ? `<span class="zip-burst" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<i style="--a: ${i * 30}deg; --d: ${(i % 3) * 0.05}s"></i>`).join('')}</span>` : '';
    const facts =
      mode === 'daily'
        ? `<dl class="zip-done-facts"><div><dt>${s.best}</dt><dd>${st.best == null ? '–' : clock(st.best)}</dd></div><div><dt>${s.streak}</dt><dd>${st.streak}</dd></div></dl>
           <p class="zip-next">${s.zip.nextIn} <b data-zip-count>${countdown(untilTomorrow())}</b></p>`
        : `<p class="zip-next">${s.zip.practiceNote}</p>`;
    return `<div class="game-board zip-done${fresh && !still() ? ' fresh' : ''}" id="zip-done" role="group" aria-label="${s.zip.solvedTitle}">
      ${burst}
      ${ctx.trophy()}
      <p class="zip-done-kicker">${mode === 'daily' ? `${s.zip.solvedTitle} · ${s.no(forDay)}` : s.zip.solvedTitle}</p>
      <p class="zip-done-time">${clock(t)}</p>
      ${best ? `<p class="zip-done-best">${s.zip.newBest}</p>` : ''}
      ${facts}
    </div>`;
  }

  /** The countdown on the score card. At midnight the next puzzle opens by itself. */
  function runCountdown() {
    clearInterval(tick);
    tick = setInterval(() => {
      const el = card?.querySelector('[data-zip-count]');
      if (!el) return clearInterval(tick);
      const left = untilTomorrow();
      el.textContent = countdown(left);
      if (left <= 1000) {
        clearInterval(tick);
        setTimeout(() => card?.isConnected && render(card), 1200);
      }
    }, 1000);
  }

  function onClick(e) {
    const a = e.target.closest('[data-zip]')?.dataset.zip;
    if (a === 'undo' && path.length) path.pop();
    else if (a === 'clear') path = [];
    else if (a === 'share') return ctx.copy(`${ctx.s().zip.shareText(forDay, clock(secs()))}\n${ctx.link()}`, e.target.closest('button'));
    else if (a === 'mode') return start(mode === 'daily' ? 'practice' : 'daily'), render(card);
    else if (a === 'again') return start('practice'), render(card);
    else if (a === 'line') return (showLine = !showLine), (fresh = false), render(card);
    else return;
    changed();
  }

  function render(el) {
    if (!p || (mode === 'daily' && forDay !== ctx.day())) start('daily');
    card = el;
    const s = ctx.s();
    const over = done();
    card.innerHTML = over
      ? `${doneHtml()}
      <p class="game-msg" id="zip-msg" aria-live="polite"></p>
      <div class="game-actions" id="zip-actions"></div>`
      : `<p class="game-help">${s.zip.help}</p>
      <dl class="game-stats" id="zip-stats"></dl>
      <div class="game-board zip-board" id="zip-board" tabindex="0" role="group" aria-label="${s.zip.label(p.size)}" aria-describedby="zip-msg" style="--size: ${p.size}">${Array.from({ length: p.size * p.size }, (_, c) => `<div class="zip-cell" data-c="${c}"></div>`).join('')}</div>
      <p class="game-msg" id="zip-msg" aria-live="polite"></p>
      <div class="game-actions" id="zip-actions"></div>`;
    if (!card.dataset.wired) {
      card.dataset.wired = '1';
      card.addEventListener('click', onClick);
    }
    if (over) {
      paintStatus();
      // The burst plays once, right after the solve.
      fresh = false;
      if (mode === 'daily') runCountdown();
      return;
    }
    wire(card.querySelector('#zip-board'));
    paintBoard();
    paintStatus();
    if (since) ticker ||= setInterval(paintTime, 250);
  }

  return { render, key, pause };
}
