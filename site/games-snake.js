// Snake: eat the dots, miss the walls and your own tail. It speeds up a little with every dot.

const N = 16; // squares across and down
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };

export function snakeGame(ctx) {
  let body = [];
  let dir = 'right';
  let queue = []; // turns pressed faster than the snake moves
  let food = null;
  let score = 0;
  let status = 'ready'; // ready, running, paused, over
  let record = false;
  let timer = 0;
  let card = null;
  let canvas = null;
  let sized = null;
  let themed = null;

  function fresh() {
    body = [[5, 8], [4, 8], [3, 8]];
    dir = 'right';
    queue = [];
    score = 0;
    record = false;
    place();
  }

  function place() {
    const free = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!body.some(([bx, by]) => bx === x && by === y)) free.push([x, y]);
    food = free[Math.floor(Math.random() * free.length)];
  }

  const speed = () => Math.max(70, 150 - score * 4);

  function tick() {
    if (queue.length) dir = queue.shift();
    const [dx, dy] = DIRS[dir];
    const head = [body[0][0] + dx, body[0][1] + dy];
    const eats = head[0] === food[0] && head[1] === food[1];
    // The tail moves away this step unless the snake eats, so the head may take its square.
    const rest = eats ? body : body.slice(0, -1);
    if (head[0] < 0 || head[1] < 0 || head[0] >= N || head[1] >= N || rest.some(([x, y]) => x === head[0] && y === head[1])) return end();
    body = [head, ...rest];
    if (eats) {
      score++;
      if (body.length === N * N) return end();
      place();
    }
    draw();
    paintScore();
    timer = setTimeout(tick, speed());
  }

  function end() {
    status = 'over';
    clearTimeout(timer);
    const best = ctx.store.get('snake.best', 0);
    if (score > best) {
      ctx.store.set('snake.best', score);
      record = score > 0;
    }
    draw();
    paintAll();
  }

  function go() {
    if (status === 'running') return;
    if (status === 'over' || status === 'ready') fresh();
    status = 'running';
    paintAll();
    timer = setTimeout(tick, speed());
  }

  function pause() {
    if (status !== 'running') return;
    status = 'paused';
    clearTimeout(timer);
    paintAll();
  }

  function turn(d) {
    if (status !== 'running') go();
    const last = queue.at(-1) ?? dir;
    const [ax, ay] = DIRS[last];
    const [bx, by] = DIRS[d];
    if (d === last || (ax === -bx && ay === -by)) return; // no turning back on yourself
    if (queue.length < 3) queue.push(d);
  }

  function key(e) {
    const d = KEYMAP[e.key];
    if (d) {
      e.preventDefault();
      turn(d);
    } else if ((e.key === ' ' || e.key === 'p' || e.key === 'P') && !e.target.closest?.('button')) {
      e.preventDefault();
      status === 'running' ? pause() : go();
    }
  }

  function draw() {
    if (!canvas?.isConnected) return;
    const css = getComputedStyle(canvas);
    const v = (name) => css.getPropertyValue(name).trim();
    const dark = document.documentElement.dataset.theme === 'dark';
    const g = canvas.getContext('2d');
    const u = canvas.width / N;
    g.fillStyle = v('--card');
    g.fillRect(0, 0, canvas.width, canvas.height);
    // The faint dot grid of the page, one dot per square.
    g.fillStyle = v('--line');
    g.globalAlpha = 0.14;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) g.fillRect((x + 0.5) * u - 1, (y + 0.5) * u - 1, 2, 2);
    g.globalAlpha = 1;
    // Food: an indigo square on the white board, orange on the dark one, each well over 3:1.
    g.fillStyle = dark ? v('--sun') : v('--accent');
    g.fillRect(food[0] * u + u * 0.2, food[1] * u + u * 0.2, u * 0.6, u * 0.6);
    g.fillStyle = v('--ink');
    for (const [x, y] of body) g.fillRect(x * u + 1, y * u + 1, u - 2, u - 2);
    // An eye on the head, looking the way it goes.
    const [hx, hy] = body[0];
    const [dx, dy] = DIRS[dir];
    g.fillStyle = v('--card');
    const e = Math.max(2, Math.round(u / 5));
    g.fillRect(hx * u + u / 2 - e / 2 + (dx * u) / 5, hy * u + u / 2 - e / 2 + (dy * u) / 5, e, e);
  }

  function fit() {
    const w = canvas.getBoundingClientRect().width;
    const px = Math.round((w * (devicePixelRatio || 1)) / N) * N;
    if (px > 0 && canvas.width !== px) {
      canvas.width = canvas.height = px;
      draw();
    }
  }

  function paintScore() {
    const s = ctx.s();
    const item = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`;
    card.querySelector('#snake-stats').innerHTML = item(s.score, score) + item(s.best, ctx.store.get('snake.best', 0));
  }

  function paintAll() {
    if (!card?.isConnected) return;
    const s = ctx.s();
    paintScore();
    const label = { ready: s.snake.start, running: s.snake.pause, paused: s.snake.resume, over: s.snake.again }[status];
    card.querySelector('#snake-actions').innerHTML = `<button class="act" type="button" data-snake="go">${label}</button>`;
    card.querySelector('#snake-board').classList.toggle('idle', status !== 'running');
    const msg = status === 'over' ? `${s.snake.over(score)}${record ? ` ${s.snake.record}` : ''}` : '';
    const m = card.querySelector('#snake-msg');
    if (m.textContent !== msg) m.textContent = msg;
  }

  function render(el) {
    if (!body.length) fresh();
    card = el;
    const s = ctx.s();
    card.innerHTML = `<p class="game-help">${s.snake.help}</p>
      <dl class="game-stats" id="snake-stats"></dl>
      <div class="game-board snake-board" id="snake-board"><canvas width="${N * 20}" height="${N * 20}" role="img" aria-label="${s.snake.label}"></canvas></div>
      <p class="game-msg" id="snake-msg" aria-live="polite"></p>
      <div class="game-actions" id="snake-actions"></div>
      <div class="game-keys snake-pad" role="group" aria-label="${s.snake.label}">${['up', 'left', 'down', 'right'].map((d) => `<button class="act pad-${d}" type="button" data-turn="${d}" aria-label="${s.snake.dirs[d]}">${{ up: '▲', down: '▼', left: '◀', right: '▶' }[d]}</button>`).join('')}</div>`;
    canvas = card.querySelector('canvas');
    sized?.disconnect();
    sized = new ResizeObserver(fit);
    sized.observe(canvas);
    // Swipes on the board turn the snake; a tap starts or pauses it.
    let from = null;
    canvas.addEventListener('pointerdown', (e) => (from = [e.clientX, e.clientY]));
    canvas.addEventListener('pointerup', (e) => {
      if (!from) return;
      const dx = e.clientX - from[0];
      const dy = e.clientY - from[1];
      from = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return status === 'running' ? pause() : go();
      turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    });
    card.addEventListener('click', (e) => {
      const t = e.target.closest('[data-turn], [data-snake]');
      if (!t) return;
      if (t.dataset.turn) turn(t.dataset.turn);
      else status === 'running' ? pause() : go();
    });
    // Redraw when the theme changes, so the board follows light and dark.
    themed ||= new MutationObserver(draw);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    fit();
    draw();
    paintAll();
  }

  return { render, key, pause };
}
