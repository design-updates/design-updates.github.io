// Word: guess the day's five-letter design word in six tries.

import { dailyWord, scoreGuess, shareRows } from './games-logic.js';
import { WORDS } from './games-words.js';

const KEYS = ['QWERTYUIOP', 'ASDFGHJKL', '+ZXCVBNM-'];

export function wordGame(ctx) {
  let forDay = 0;
  let answer = null; // [word, English meaning, Chinese meaning]
  let guesses = [];
  let typing = '';
  let card = null;
  let shake = false;
  let note = ''; // spoken after each guess

  const won = () => guesses.at(-1) === answer[0];
  const done = () => won() || guesses.length === 6;

  function start() {
    forDay = ctx.day();
    answer = dailyWord(forDay, WORDS);
    const saved = ctx.store.get('word.day', null);
    guesses = saved?.day === forDay ? (saved.guesses ?? []).filter((g) => /^[A-Z]{5}$/.test(g)).slice(0, 6) : [];
    typing = '';
  }

  function stats() {
    const st = ctx.store.get('word.stats', { played: 0, wins: 0, streak: 0, last: 0 });
    if (st.last < ctx.day() - 1) st.streak = 0;
    return st;
  }

  function record() {
    const st = ctx.store.get('word.stats', { played: 0, wins: 0, streak: 0, last: 0 });
    if (st.last === forDay) return;
    st.played++;
    if (won()) {
      st.wins++;
      st.streak = st.last === forDay - 1 ? st.streak + 1 : 1;
    } else st.streak = 0;
    st.last = forDay;
    ctx.store.set('word.stats', st);
  }

  function type(k) {
    if (done()) return;
    const s = ctx.s();
    if (k === 'Enter') {
      if (typing.length < 5) {
        shake = true;
        note = s.word.short;
      } else {
        guesses.push(typing);
        const sc = scoreGuess(typing, answer[0]);
        note = `${typing.split('').map((ch, i) => `${ch} ${s.word.state[sc[i]]}`).join(', ')}.`;
        typing = '';
        ctx.store.set('word.day', { day: forDay, guesses });
        if (done()) record();
      }
    } else if (k === 'Backspace') typing = typing.slice(0, -1);
    else if (/^[A-Z]$/.test(k) && typing.length < 5) typing += k;
    else return;
    paint(k === 'Enter');
  }

  function key(e) {
    if (e.key === 'Enter' && e.target.closest?.('button, a')) return; // the button's own click handles it
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key === 'Delete' ? 'Backspace' : e.key;
    if (k === 'Enter' || k === 'Backspace' || /^[A-Z]$/.test(k)) {
      e.preventDefault();
      type(k);
    }
  }

  function paint(justEntered = false) {
    const s = ctx.s();
    const rows = [];
    for (let r = 0; r < 6; r++) {
      const g = guesses[r];
      const sc = g ? scoreGuess(g, answer[0]) : null;
      const letters = g ?? (r === guesses.length ? typing.padEnd(5) : '     ');
      const cls = ['word-row', justEntered && r === guesses.length - 1 ? 'just' : '', shake && r === guesses.length ? 'shake' : ''].join(' ');
      const label = g ? ` aria-label="${g}: ${g.split('').map((ch, i) => `${ch} ${s.word.state[sc[i]]}`).join(', ')}"` : ' aria-hidden="true"';
      rows.push(
        `<div class="${cls}" role="${g ? 'listitem' : 'presentation'}"${label}>${[...letters].map((ch, i) => `<span class="tile${sc ? ` t${sc[i]}` : ch.trim() ? ' filled' : ''}" style="--i: ${i}" aria-hidden="true">${ch.trim()}</span>`).join('')}</div>`,
      );
    }
    card.querySelector('#word-board').innerHTML = rows.join('');
    shake = false;

    const best = {};
    for (const g of guesses) scoreGuess(g, answer[0]).forEach((v, i) => (best[g[i]] = Math.max(best[g[i]] ?? -1, v)));
    card.querySelector('#word-keys').innerHTML = KEYS.map(
      (row) =>
        `<div class="key-row">${[...row]
          .map((ch) =>
            ch === '+'
              ? `<button class="key wide" type="button" data-key="Enter">${s.word.enter}</button>`
              : ch === '-'
                ? `<button class="key wide" type="button" data-key="Backspace" aria-label="${s.word.del}">⌫</button>`
                : `<button class="key${best[ch] !== undefined ? ` t${best[ch]}` : ''}" type="button" data-key="${ch}"${best[ch] !== undefined ? ` aria-label="${ch}, ${s.word.state[best[ch]]}"` : ''}>${ch}</button>`,
          )
          .join('')}</div>`,
    ).join('');

    const st = stats();
    const item = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
    card.querySelector('#word-stats').innerHTML = [item(s.zip.daily, s.no(forDay)), item(s.played, st.played), item(s.wonPct, st.played ? `${Math.round((st.wins / st.played) * 100)}%` : '–'), item(s.streak, st.streak)].join('');

    const msg = card.querySelector('#word-msg');
    const end = card.querySelector('#word-end');
    if (done()) {
      msg.textContent = `${note} ${won() ? s.word.won(guesses.length) : s.word.lost(answer[0])}`.trim();
      end.innerHTML = `<p class="word-meaning"><b>${answer[0]}</b> ${ctx.lang() === 'zh' ? answer[2] : answer[1]}</p>
        <div class="game-actions"><button class="act" type="button" data-word="share">${s.share}</button><span class="game-note">${s.word.tomorrow}</span></div>`;
    } else {
      msg.textContent = note;
      end.innerHTML = '';
    }
  }

  function render(el) {
    if (!answer || forDay !== ctx.day()) start();
    card = el;
    note = '';
    const s = ctx.s();
    card.innerHTML = `<p class="game-help">${s.word.help}</p>
      <dl class="game-stats" id="word-stats"></dl>
      <div class="game-board word-board" id="word-board" role="list" aria-label="${s.word.board}"></div>
      <p class="game-msg" id="word-msg" aria-live="polite"></p>
      <div class="game-end" id="word-end"></div>
      <div class="game-keys word-keys" id="word-keys"></div>`;
    // On-screen keys don't take the focus, so a later Enter on the keyboard doesn't press them again.
    card.addEventListener('mousedown', (e) => e.target.closest('.key') && e.preventDefault());
    card.addEventListener('click', (e) => {
      const k = e.target.closest('[data-key]')?.dataset.key;
      if (k) return type(k);
      if (e.target.closest('[data-word="share"]')) {
        const rows = shareRows(guesses.map((g) => scoreGuess(g, answer[0])));
        ctx.copy(`${s.word.shareText(forDay, won() ? guesses.length : 'X')}\n${rows}\n${ctx.link()}`, e.target.closest('button'));
      }
    });
    paint();
  }

  return { render, key };
}
