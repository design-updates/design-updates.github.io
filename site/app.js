// Pixel Post front end. Reads data/radar.json and draws today's paper plus the archive. No framework, no build step.

/* ---------- language: English (default) or Simplified Chinese ---------- */

// ?lang=zh or ?lang=en in the address picks a language (for sharing a Chinese link); otherwise the last choice.
let lang = (() => {
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked === 'zh' || asked === 'en') return asked;
  // A shared digest opens in the language it was written in.
  const shared = location.hash.match(/^#d=([\w-]+)/)?.[1];
  if (shared) {
    try {
      const l = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(shared.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))).l;
      if (l === 'zh' || l === 'en') return l;
    } catch {}
  }
  try {
    return localStorage.getItem('radar.lang') === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
})();

const T = {
  en: {
    title: 'Pixel Post · app design changes worth your time',
    skip: 'Skip to today',
    cat: { ota: 'OTA', rail: 'Rail', delivery: 'Delivery', platform: 'Platform', consumer: 'Consumer' },
    kind: { ui: 'UI', ux: 'UX', brand: 'Brand' },
    beta: 'Beta',
    why: 'Why it matters',
    more: 'More',
    less: 'Less',
    viewNews: 'News',
    viewWorkflows: 'AI workflows',
    viewsLabel: 'Pages',
    wfTitle: 'AI workflows',
    wfSummary: (picks, checked) => `This week: <b>${picks}</b> from ${checked} posts by designers on how they use AI. Picked every Monday.`,
    wfQuiet: (checked) => `This week, none of ${checked} posts showed a real process worth copying. Picked every Monday.`,
    wfNone: 'No picks yet. The first list comes with the next Monday run.',
    wfLoading: 'Loading…',
    wfList: 'Weekly picks',
    wfWeek: 'Week of',
    wfQuietRow: 'Quiet week. Nothing worth copying.',
    wfPicks: (n) => (n === 1 ? '1 pick' : `${n} picks`),
    wfResult: 'What came out',
    wfCatch: 'The catch',
    wfTryIf: 'Worth trying if',
    wfRead: 'Read the post',
    wfMin: (n) => `${n} min read`,
    wfBy: (name) => `by ${name}`,
    wfAllStages: 'All',
    wfFilterLabel: 'Filter by stage or tool',
    stage: { research: 'Research', ideas: 'Ideas', ux: 'UX', ui: 'UI', prototyping: 'Prototyping', systems: 'Design systems', handoff: 'Handoff', brand: 'Brand', team: 'Team' },
    wfType: { workflow: 'Workflow', technique: 'Technique', tool: 'Tool', study: 'Study' },
    viewCases: 'Case studies',
    viewGames: 'Games',
    gmTitle: 'Games',
    gmSummary: 'A break between reads. <b>Zip</b> and <b>Word</b> are one puzzle a day, the same for everyone; <b>Snake</b> never ends. Scores stay in this browser.',
    csTitle: 'Case studies',
    csSummary: (picks, checked) => `This week: <b>${picks}</b> from ${checked} posts by top design teams and the design press. Shipped work from well-known companies only. Picked every Monday.`,
    csQuiet: (checked) => `This week, none of ${checked} posts was a case study of shipped work from a well-known company. Picked every Monday.`,
    csQuietRow: 'Quiet week. No case worth studying.',
    csPicks: (n) => (n === 1 ? '1 case' : `${n} cases`),
    csApproach: 'What they did',
    csOutcome: 'What happened',
    csLesson: 'Take away',
    csRead: 'Read the case',
    csFilterLabel: 'Filter by area',
    area: { product: 'Product', system: 'Design system', brand: 'Brand', research: 'Research', content: 'Content' },
    maker: { team: 'In-house team', agency: 'Agency', designer: 'Designer' },
    pattern: 'Pattern',
    sources: (n) => `${n} source${n === 1 ? '' : 's'}`,
    today: 'Today',
    yesterday: 'Yesterday',
    justNow: 'just now',
    hoursAgo: (h) => `${h}h ago`,
    daysAgo: (d) => `${d} days ago`,
    agoYesterday: 'yesterday',
    greet: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', late: 'Still up' },
    greeting: (g, name) => `${g}${name ? `, ${name}` : ''}.`,
    changes: (count, n) => `${count} change${n === 1 ? '' : 's'}`,
    summaryToday: (changes, apps) => `${changes} today · <b>${apps}</b>`,
    summaryQuiet: 'Quiet day, nothing worth your time.',
    summaryNone: 'No editions yet. The first one arrives after the next daily run.',
    summaryFrom: (when, changes, apps, stale) => `No edition yet today. From ${when}: ${changes} · <b>${apps}</b>.${stale}`,
    summaryWasQuiet: (when, stale) => `No edition yet today. ${when[0].toUpperCase()}${when.slice(1)} was quiet.${stale}`,
    stale: ' The daily run may have failed; check the log on the laptop.',
    and: (shown, rest) => `${shown.join(', ')} and ${rest} more`,
    list: (apps) => apps.join(', '),
    quietTitle: 'Quiet day.',
    quietBody: (isToday) => `Nothing worth your time${isToday ? ' today' : ''}. Every source was checked and nothing met the bar, which is the point.`,
    quietRow: 'Quiet day. Nothing worth your time.',
    earlier: 'Earlier',
    unreadCount: (n) => `${n} unread`,
    unread: 'Unread',
    all: 'All',
    noMatch: 'Nothing here with these filters.',
    showAll: 'Show everything',
    noArchive: 'Earlier days will collect here.',
    issue: (n, date) => `${n ? `<b>No. ${n}</b> · ` : ''}${date}`,
    footerName: 'Pixel Post · a morning paper for one',
    footerRun: (when) => `Last run ${when} · `,
    footerFeeds: (n, search, ai) => `${n} feeds${search ? ' and web search' : ''}, filtered by ${ai}`,
    loadFailed: 'Could not load data/radar.json.',
    toLight: 'Switch to light mode',
    toDark: 'Switch to dark mode',
    toCleanFont: 'Switch to a simpler font',
    toPixelFont: 'Switch to the pixel font',
    langButton: '中',
    langLabel: '切换到中文',
    home: 'Pixel Post, home',
    filterLabel: 'Filter earlier changes',
    save: 'Save',
    saved: 'Saved',
    note: 'Note',
    editNote: 'Edit note',
    saveNote: 'Save note',
    addNote: 'Add a note for later',
    digest: 'Saved',
    digestTitle: 'Saved',
    digestEmpty: 'Nothing saved this week. Save items with the star and they collect here.',
    prevWeek: 'Earlier week',
    nextWeek: 'Later week',
    remove: 'Remove',
    sharedTitle: (from) => (from ? `Digest from ${from}` : 'Shared digest'),
    sharedMissing: (n) => `${n} item${n === 1 ? '' : 's'} in this link ${n === 1 ? 'is' : 'are'} no longer on the page.`,
    close: 'Close',
    before: 'Before',
    after: 'After',
    beforeAfter: 'Before and after',
    storeNotes: (store, version) => (store === 'app-store' ? `App Store notes · v${version}` : 'Google Play notes'),
    textNote: 'Note',
  },
  zh: {
    title: 'Pixel Post · 值得一看的应用设计变化',
    skip: '跳到今天',
    cat: { ota: 'OTA', rail: '铁路', delivery: '外卖出行', platform: '平台', consumer: '消费' },
    kind: { ui: 'UI', ux: 'UX', brand: '品牌' },
    beta: '测试版',
    why: '为什么重要',
    more: '展开',
    less: '收起',
    viewNews: '资讯',
    viewWorkflows: 'AI 工作流',
    viewsLabel: '页面',
    wfTitle: 'AI 工作流',
    wfSummary: (picks, checked) => `本周：从 ${checked} 篇设计师分享 AI 用法的文章中选出 <b>${picks}</b>。每周一更新。`,
    wfQuiet: (checked) => `本周 ${checked} 篇文章里，没有一篇展示了值得借鉴的具体流程。每周一更新。`,
    wfNone: '还没有内容。下周一运行后会出现第一期。',
    wfLoading: '加载中…',
    wfList: '每周精选',
    wfWeek: '当周',
    wfQuietRow: '本周很安静，没有值得借鉴的内容。',
    wfPicks: (n) => `${n} 篇`,
    wfResult: '成果',
    wfCatch: '不足',
    wfTryIf: '适合',
    wfRead: '阅读原文',
    wfMin: (n) => `${n} 分钟阅读`,
    wfBy: (name) => `作者 ${name}`,
    wfAllStages: '全部',
    wfFilterLabel: '按阶段或工具筛选',
    stage: { research: '调研', ideas: '构思', ux: 'UX', ui: 'UI', prototyping: '原型', systems: '设计系统', handoff: '交付', brand: '品牌', team: '团队' },
    wfType: { workflow: '工作流', technique: '技巧', tool: '工具', study: '研究' },
    viewCases: '设计案例',
    viewGames: '游戏',
    gmTitle: '游戏',
    gmSummary: '读累了就玩一会儿。<b>Zip</b> 和 <b>Word</b> 每天一题，大家的题目相同；<b>Snake</b> 可以一直玩。成绩只保存在这个浏览器里。',
    csTitle: '设计案例',
    csSummary: (picks, checked) => `本周：从 ${checked} 篇顶尖设计团队和设计媒体的文章中选出 <b>${picks}</b>。只收知名公司已上线的作品。每周一更新。`,
    csQuiet: (checked) => `本周 ${checked} 篇文章里，没有知名公司已上线作品的案例。每周一更新。`,
    csQuietRow: '本周很安静，没有值得研究的案例。',
    csPicks: (n) => `${n} 个案例`,
    csApproach: '做法',
    csOutcome: '结果',
    csLesson: '启发',
    csRead: '阅读案例',
    csFilterLabel: '按领域筛选',
    area: { product: '产品', system: '设计系统', brand: '品牌', research: '调研', content: '内容' },
    maker: { team: '内部团队', agency: '设计公司', designer: '设计师' },
    pattern: '趋势',
    sources: (n) => `${n} 个来源`,
    today: '今天',
    yesterday: '昨天',
    justNow: '刚刚',
    hoursAgo: (h) => `${h}小时前`,
    daysAgo: (d) => `${d}天前`,
    agoYesterday: '昨天',
    greet: { morning: '早上好', afternoon: '下午好', evening: '晚上好', late: '还没睡' },
    greeting: (g, name) => `${g}${name ? `，${name}` : ''}。`,
    changes: (count) => `${count} 项变化`,
    summaryToday: (changes, apps) => `今天 ${changes} · <b>${apps}</b>`,
    summaryQuiet: '今天很安静，没有值得看的内容。',
    summaryNone: '还没有内容。下一次每日运行后会出现第一期。',
    summaryFrom: (when, changes, apps, stale) => `今天的还没出。${when}：${changes} · <b>${apps}</b>。${stale}`,
    summaryWasQuiet: (when, stale) => `今天的还没出。${when}很安静。${stale}`,
    stale: '每日运行可能失败了，请查看笔记本上的日志。',
    and: (shown, rest) => `${shown.join('、')} 等 ${shown.length + rest} 个`,
    list: (apps) => apps.join('、'),
    quietTitle: '安静的一天。',
    quietBody: (isToday) => `${isToday ? '今天' : ''}没有值得你花时间的内容。所有来源都检查过了，没有达到标准的，这正是它的用意。`,
    quietRow: '安静的一天，没有值得看的内容。',
    earlier: '往期',
    unreadCount: (n) => `${n} 条未读`,
    unread: '未读',
    all: '全部',
    noMatch: '这些筛选条件下没有内容。',
    showAll: '显示全部',
    noArchive: '往期内容会出现在这里。',
    issue: (n, date) => `${n ? `<b>第 ${n} 期</b> · ` : ''}${date}`,
    footerName: 'Pixel Post · 一个人的早报',
    footerRun: (when) => `上次运行 ${when} · `,
    footerFeeds: (n, search, ai) => `${n} 个信息源${search ? '和网页搜索' : ''}，由 ${ai} 筛选`,
    loadFailed: '无法加载 data/radar.json。',
    toLight: '切换到浅色模式',
    toDark: '切换到深色模式',
    toCleanFont: '切换到简洁字体',
    toPixelFont: '切换到像素字体',
    langButton: 'EN',
    langLabel: 'Switch to English',
    home: 'Pixel Post，首页',
    filterLabel: '筛选往期变化',
    save: '收藏',
    saved: '已收藏',
    note: '备注',
    editNote: '编辑备注',
    saveNote: '保存备注',
    addNote: '写条备注，留着以后看',
    digest: '收藏',
    digestTitle: '收藏',
    digestEmpty: '本周还没有收藏。点星标收藏条目，它们会出现在这里。',
    prevWeek: '上一周',
    nextWeek: '下一周',
    remove: '移除',
    sharedTitle: (from) => (from ? `${from} 分享的周报` : '分享的周报'),
    sharedMissing: (n) => `链接里有 ${n} 条已不在页面上。`,
    close: '关闭',
    before: '改版前',
    after: '改版后',
    beforeAfter: '改版前后对比',
    storeNotes: (store, version) => (store === 'app-store' ? `App Store 更新说明 · v${version}` : 'Google Play 更新说明'),
    textNote: '备注',
  },
};
const t = () => T[lang];

/** The item's text in the current language; English when there is no Chinese write-up (older items). */
const txt = (item, field) => (lang === 'zh' && item.zh?.[field]) || item[field];
const patternOf = (day) => (lang === 'zh' && day.pattern_zh) || day.pattern;
// ?still turns motion off, for screenshots.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('still');
if (reduced) document.documentElement.classList.add('still');
const $ = (s, el = document) => el.querySelector(s);

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const favicon = (domain, px = 16) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${px}`;

/** The same icon at another size: App Store artwork and Google favicons both take a size in the URL. */
function iconAt(url, px) {
  if (!url) return null;
  if (/mzstatic\.com/.test(url)) return url.replace(/\/\d+x\d+bb\.(png|jpg|webp)$/, `/${px}x${px}bb.png`);
  if (/google\.com\/s2\/favicons/.test(url)) return url.replace(/sz=\d+/, `sz=${Math.min(64, Math.max(16, px))}`);
  return url;
}
const iconFor = (item) => item.icon || favicon(domainOf(item.sources?.[0]?.url));
/** The large icon (128px App Store artwork, 64px favicon) for a card without a picture. */
const bigIcon = (item) => item.icon_large || iconAt(iconFor(item), 128);

/** A card or row with no picture of the change: the app's icon, sharp, on a soft tint of the card's colour. */
// A small favicon (Google Messages has only 32px) is shown at its own size, never enlarged into a blur.
const placeholderHtml = (src) => `<span class="ph-icon notch"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.parentElement.style.setProperty('--own', this.naturalWidth + 'px')" onerror="this.parentElement.remove()"></span>`;

/* ---------- pixel art ---------- */

/** rows of characters → crisp SVG; each character maps to a fill (and optional class). Runs are merged. */
function pixels(rows, palette, cls = '') {
  const w = Math.max(...rows.map((r) => r.length));
  let out = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let run = 1;
      while (row[x + run] === ch) run++;
      const p = palette[ch];
      if (p) {
        const [fill, c] = Array.isArray(p) ? p : [p];
        out += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${fill}"${c ? ` class="${c}"` : ''}/>`;
      }
      x += run;
    }
  });
  return `<svg class="pixel-art ${cls}" viewBox="0 0 ${w} ${rows.length}" shape-rendering="crispEdges" aria-hidden="true">${out}</svg>`;
}

function grid(n, fn) {
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => fn(x, y)).join(''));
}

/** A folded pixel newspaper. Its lines (digits 1–5) print in one after another when the page opens. */
const PAPER = [
  'oooooooooooooo..',
  'o............ooo',
  'o.mmmmmmmmmm.o.o',
  'o.mmmmmmmmmm.o.o',
  'o............o.o',
  'o.pppp.111111o.o',
  'o.pppp.......o.o',
  'o.pppp.222222o.o',
  'o.pppp.......o.o',
  'o.333333333..o.o',
  'o............o.o',
  'o.44444444444o.o',
  'o............o.o',
  'o.5555555....o.o',
  'o............ooo',
  'oooooooooooooo..',
];
function paperLogo() {
  const line = (n) => ['var(--ink-3)', `line l${n}`];
  return pixels(PAPER, { o: 'var(--ink)', m: 'var(--ink)', p: 'var(--accent)', 1: line(1), 2: line(2), 3: line(3), 4: line(4), 5: line(5) });
}

const SUN = [
  '....a..a....',
  '.a........a.',
  '....oooo....',
  '...oooooo...',
  'a.oooooooo.a',
  '..oooooooo..',
  '..oooooooo..',
  'a.oooooooo.a',
  '...oooooo...',
  '....oooo....',
  '.a........a.',
  '....a..a....',
];
const sun = (cls) => pixels(SUN, { o: 'var(--sun)', a: 'var(--ink-3)' }, cls);

function moon(cls) {
  const rows = grid(12, (x, y) => {
    const inA = Math.hypot(x + 0.5 - 6, y + 0.5 - 6.5) <= 5;
    const inB = Math.hypot(x + 0.5 - 8.6, y + 0.5 - 4.4) <= 4.1;
    if (inA && !inB) return 'o';
    if ((x === 10 && y === 9) || (x === 9 && y === 1)) return 's';
    return '.';
  });
  return pixels(rows, { o: 'var(--ink)', s: 'var(--accent)' }, cls);
}

const CUP = [
  '................',
  '.....s...t......',
  '......s...t.....',
  '.....s...t......',
  '................',
  '..cccccccccc....',
  '..ckkkkkkkkc....',
  '..cwwwwwwwwcccc.',
  '..cwwwwwwwwc..c.',
  '..cwwwwwwwwc..c.',
  '..cwwwwwwwwcccc.',
  '..cwwwwwwwwc....',
  '...cwwwwwwc.....',
  '....cccccc......',
  '.cccccccccccccc.',
  '................',
];
const cup = () => pixels(CUP, { c: 'var(--ink)', k: '#b2902f', w: 'var(--card)', s: ['var(--ink-3)', 'steam'], t: ['var(--ink-3)', 'steam s2'] });

const TREND = [
  '............',
  '.........aa.',
  '.........aa.',
  '.....ii..aa.',
  '.....ii..aa.',
  '.ii..ii..aa.',
  '.ii..ii..aa.',
  '.ii..ii..aa.',
  '............',
  'oooooooooooo',
];
const trend = () => pixels(TREND, { a: 'var(--accent)', i: 'var(--ink-2)', o: 'var(--ink)' });

/* ---------- dates ---------- */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYmd = (s) => new Date(`${s}T12:00:00`);
const fmt = (d, o) => new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', o).format(d);
const today = new Date();
const todayYmd = ymd(today);
const yesterdayYmd = ymd(new Date(today.getTime() - 86_400_000));

function dayName(date) {
  if (date === todayYmd) return t().today;
  if (date === yesterdayYmd) return t().yesterday;
  return fmt(fromYmd(date), { weekday: 'long' });
}

function ago(iso) {
  const at = new Date(iso).getTime();
  if (!at) return '';
  const h = (Date.now() - at) / 3_600_000;
  if (h < 1) return t().justNow;
  if (h < 24) return t().hoursAgo(Math.round(h));
  const d = Math.round(h / 24);
  if (d === 1) return t().agoYesterday;
  if (d < 7) return t().daysAgo(d);
  return fmt(new Date(at), { day: 'numeric', month: 'short' });
}

/* ---------- read state ---------- */

// "Unread" means collected after your previous visit. The previous visit is frozen for this tab, so
// reloading does not clear the dots; opening an item does.
let prevVisit = sessionStorage.getItem('radar.prevVisit');
if (prevVisit === null) {
  prevVisit = store.get('radar.lastVisit', '') || new Date(Date.now() - 3 * 86_400_000).toISOString();
  try {
    sessionStorage.setItem('radar.prevVisit', prevVisit);
  } catch {}
}
store.set('radar.lastVisit', new Date().toISOString());
const read = new Set(store.get('radar.read', []));
const isUnread = (item) => !read.has(item.id) && item.collected_at > prevVisit;
function markRead(ids) {
  for (const id of ids) read.add(id);
  store.set('radar.read', [...read].slice(-2000));
}

/* ---------- saved items and notes (this browser only) ---------- */

const saved = store.get('radar.saved', {}); // id -> { note, at }
const isSaved = (id) => !!saved[id];
const noteOf = (id) => saved[id]?.note ?? '';
function setSaved(id, on) {
  if (on) saved[id] = { note: noteOf(id), at: saved[id]?.at ?? new Date().toISOString() };
  else delete saved[id];
  store.set('radar.saved', saved);
  paintSaved(id);
}
function setNote(id, note) {
  saved[id] = { note, at: saved[id]?.at ?? new Date().toISOString() };
  store.set('radar.saved', saved);
  paintSaved(id);
}
/** Updates every star for an item, the row marker and the digest count, without redrawing the page. */
function paintSaved(id) {
  const on = isSaved(id);
  for (const b of document.querySelectorAll(`.save-btn[data-save="${CSS.escape(id)}"]`)) {
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.save-label').textContent = on ? t().saved : t().save;
  }
  document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-saved', on);
  paintDigestCount();
}

/* ---------- small pieces ---------- */

function appIcon(item, big = false) {
  const src = iconAt(iconFor(item), 16);
  return `<img class="icon notch${big ? ' icon-lg' : ''}" src="${esc(src)}" alt="" width="${big ? 32 : 24}" height="${big ? 32 : 24}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
}

function metaRow(item, big = false) {
  return `<div class="meta">
    <span class="app">${appIcon(item, big)}${esc(item.app)}</span>
    <span class="tag" data-cat="${esc(item.category)}">${t().cat[item.category] ?? esc(item.category)}</span>
    ${kindTag(item)}
    ${item.beta ? `<span class="beta">${t().beta}</span>` : ''}
    ${releaseTag(item)}
    <span class="when"><time datetime="${esc(item.published_at)}">${ago(item.published_at)}</time></span>
  </div>`;
}

/** UI, UX or Brand, as a small outlined label. Older items have none. */
const kindTag = (item) => (item.kind && t().kind[item.kind] ? `<span class="kind" data-kind="${esc(item.kind)}">${t().kind[item.kind]}</span>` : '');

function sources(item) {
  const list = item.sources ?? [];
  const icons = list.map((s) => `<img src="${esc(s.favicon || favicon(domainOf(s.url)))}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer">`).join('');
  const links = list.map((s) => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-read="${esc(item.id)}">${esc(s.publisher || domainOf(s.url))}</a>`).join(', ');
  return `<div class="sources"><span class="stack" aria-hidden="true">${icons}</span><span>${t().sources(list.length)}</span><span aria-hidden="true">·</span><span>${links}</span></div>`;
}

/** "App Store notes · v26.44" on items that came from an app's own version notes. */
const releaseTag = (item) => (item.release ? `<span class="release">${esc(t().storeNotes(item.release.store, item.release.version))}</span>` : '');

/** Star and note for an item. A saved note shows as text; Note / Edit note opens a box with Save note inside it. */
function actions(item) {
  const on = isSaved(item.id);
  const note = noteOf(item.id);
  return `<div class="actions">
    <button class="act save-btn" type="button" data-save="${esc(item.id)}" aria-pressed="${on}"><span class="star" aria-hidden="true"></span><span class="save-label">${on ? t().saved : t().save}</span></button>
    <button class="act note-btn" type="button" data-note="${esc(item.id)}" aria-expanded="false">${note ? t().editNote : t().note}</button>
  </div>
  <p class="note-text" data-note-text-for="${esc(item.id)}"${note ? '' : ' hidden'}><b>${t().textNote}</b><span>${esc(note)}</span></p>
  <div class="note-editor" data-editor-for="${esc(item.id)}" hidden>
    <textarea class="note-box" data-note-for="${esc(item.id)}" rows="3" placeholder="${esc(t().addNote)}">${esc(note)}</textarea>
    <button class="note-save" type="button" data-note-save="${esc(item.id)}" disabled>${t().saveNote}</button>
  </div>`;
}

/** After a save (or un-star): every copy of this item shows the note as text and closes its box. */
function paintNote(id) {
  const note = noteOf(id);
  for (const p of document.querySelectorAll(`.note-text[data-note-text-for="${CSS.escape(id)}"]`)) {
    p.hidden = !note;
    p.querySelector('span').textContent = note;
  }
  for (const ed of document.querySelectorAll(`.note-editor[data-editor-for="${CSS.escape(id)}"]`)) {
    ed.hidden = true;
    ed.querySelector('textarea').value = note;
    ed.querySelector('.note-save').disabled = true;
  }
  for (const b of document.querySelectorAll(`.note-btn[data-note="${CSS.escape(id)}"]`)) {
    b.textContent = note ? t().editNote : t().note;
    b.setAttribute('aria-expanded', 'false');
  }
}

/** Old and new design side by side (or one picture that shows both). */
function compareHtml(item) {
  const c = item.compare;
  const label = (k) => `<figcaption>${k === 'before' ? (c.from === 'app-store' && c.before_version ? `${t().before} · v${esc(c.before_version)}` : t().before) : c.from === 'app-store' && item.release ? `${t().after} · v${esc(item.release.version)}` : t().after}</figcaption>`;
  const pic = (src) => `<img src="${esc(src)}" alt="" loading="eager" referrerpolicy="no-referrer" decoding="async">`;
  const href = esc(safeUrl(item.sources?.[0]?.url));
  if (c.combined || !c.before) {
    return `<a class="frame photo" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" data-read="${esc(item.id)}"><div class="compare notch one"><figure>${pic(c.after)}<figcaption>${c.combined ? t().beforeAfter : t().after}</figcaption></figure></div></a>`;
  }
  return `<a class="frame photo" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" data-read="${esc(item.id)}"><div class="compare notch"><figure class="half">${pic(c.before)}${label('before')}</figure><figure class="half">${pic(c.after)}${label('after')}</figure></div></a>`;
}

function why(item) {
  return `<p class="why"><b>${t().why}</b>${esc(txt(item, 'why'))}</p>`;
}

/** A photo if there is one; otherwise the app's icon on a plain tile. */
function media(item) {
  if (item.compare?.after) return compareHtml(item);
  const href = esc(safeUrl(item.sources?.[0]?.url));
  const style = `--c: var(--${esc(item.category)})`;
  if (item.image) {
    return `<a class="frame photo" href="${href}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" data-read="${esc(item.id)}">
      <div class="media notch${reduced ? '' : ' pending'}" style="${style}">
        <img src="${esc(item.image)}" alt="" loading="eager" referrerpolicy="no-referrer" decoding="async">
      </div></a>`;
  }
  // The collector and build both reject news stories without an image of the reported change. This empty return
  // is only a last guard for old/corrupt data; never substitute an app logo for the display image.
  return '';
}

/* ---------- today ---------- */

/*
 * Every story today is the same card: its text on the left, its own picture on the right. The summary shows two
 * lines; More opens why it matters, the sources and Save / Note, with Less at the very end. Phones stack each
 * picture above its text.
 */
function cardHtml(item, i) {
  const h = i === 0 ? 'h2' : 'h3';
  return `<article class="story card reveal" data-id="${esc(item.id)}">
    <div class="story-text">
      ${metaRow(item)}
      <${h} class="headline"><a href="${esc(safeUrl(item.sources?.[0]?.url))}" target="_blank" rel="noopener" data-read="${esc(item.id)}">${esc(txt(item, 'headline'))}</a></${h}>
      <p class="what clamp">${esc(txt(item, 'what'))}</p>
      <div class="fold">
        <div class="more-body" id="more-${esc(item.id)}" hidden>
          <div class="more-in">
            ${why(item)}
            ${sources(item)}
            ${actions(item)}
          </div>
        </div>
        ${moreBtn(`more-${item.id}`)}
      </div>
    </div>
    ${media(item)}
  </article>`;
}

/** Cards and rows open the same way: the headline goes to the source, More + shows the rest here. */
function moreBtn(id) {
  const chevron = '<svg class="chev" viewBox="0 0 7 4" width="10" height="6" aria-hidden="true" shape-rendering="crispEdges"><path d="M0 0h7v1H6v1H5v1H4v1H3V3H2V2H1V1H0z" fill="currentColor"/></svg>';
  return `<button class="more" type="button" aria-expanded="false" aria-controls="${esc(id)}"><span class="more-label">${t().more}</span>${chevron}</button>`;
}

function patternHtml(text) {
  return `<aside class="pattern reveal">${trend()}<p><span class="label">${t().pattern}</span>${esc(text)}</p></aside>`;
}

function quietHtml(day) {
  return `<div class="quiet reveal">${cup()}<p><strong>${t().quietTitle}</strong>${t().quietBody(day.date === todayYmd)}</p></div>`;
}

function renderToday(day) {
  const el = $('#today');
  if (!day) {
    el.innerHTML = '';
    return;
  }
  if (day.quiet || !day.items.length) {
    el.innerHTML = quietHtml(day);
    return;
  }
  const cards = day.items.map(cardHtml);
  el.innerHTML = [cards[0], day.pattern ? patternHtml(patternOf(day)) : '', ...cards.slice(1)].join('');
}

/* ---------- archive ---------- */

const filter = { cat: 'all', kind: null, unread: false };

function rowHtml(item) {
  const unread = isUnread(item);
  const href = esc(safeUrl(item.sources?.[0]?.url));
  const link = `href="${href}" target="_blank" rel="noopener" data-read="${esc(item.id)}"`;
  // The thumbnail sits beside the headline and the opened text, so opening a row adds no gap. It links to the source, like the headline.
  const c = item.compare;
  const thumb = c?.after && c.before && !c.combined
    ? `<a class="row-thumb notch split" ${link} tabindex="-1" aria-hidden="true"><img src="${esc(c.before)}" alt="" loading="lazy" referrerpolicy="no-referrer"><img src="${esc(c.after)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : c?.after
      ? `<a class="row-thumb notch" ${link} tabindex="-1" aria-hidden="true"><img src="${esc(c.after)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
      : item.image
    ? `<a class="row-thumb notch${reduced ? '' : ' pending'}" ${link} tabindex="-1" aria-hidden="true" style="--c: var(--${esc(item.category)})"><img src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : '';
  return `<li class="row reveal ${unread ? 'unread' : 'read'}${isSaved(item.id) ? ' is-saved' : ''}" data-cat="${esc(item.category)}" data-kind="${esc(item.kind ?? '')}" data-id="${esc(item.id)}">
    <div class="row-head">
      <span class="dot" aria-hidden="true"></span>
      ${appIcon(item).replace('class="icon', 'class="icon row-icon')}
      <div class="row-main">
        <p class="row-top"><span class="app">${esc(item.app)}</span><span class="tag" data-cat="${esc(item.category)}"><span class="tag-label">${t().cat[item.category] ?? ''}</span></span>${kindTag(item)}${item.beta ? `<span class="beta">${t().beta}</span>` : ''}${releaseTag(item)}<span class="saved-mark" aria-hidden="true"></span><span class="when">${ago(item.published_at)}</span>${unread ? `<span class="sr-only">${t().unread}</span>` : ''}</p>
        <h3 class="row-title"><a ${link}>${esc(txt(item, 'headline'))}</a></h3>
        <p class="what clamp">${esc(txt(item, 'what'))}</p>
      </div>
    </div>
    ${thumb}
    <div class="fold row-fold">
      <div class="more-body" id="more-${esc(item.id)}" hidden>
        <div class="more-in">
          ${why(item)}
          ${sources(item)}
          ${actions(item)}
        </div>
      </div>
      ${moreBtn(`more-${item.id}`)}
    </div>
  </li>`;
}

function dayHtml(day) {
  const d = fromYmd(day.date);
  const rail = `<div class="rail"><span class="rail-fill" aria-hidden="true"></span><div class="rail-inner reveal"><span class="rail-day">${dayName(day.date)}</span><span class="rail-date">${fmt(d, { day: 'numeric', month: 'short' })}</span></div></div>`;
  if (day.quiet || !day.items.length) {
    return `<section class="day quiet-day" data-date="${day.date}" aria-label="${fmt(d, { dateStyle: 'full' })}">${rail}<div class="rows reveal">${t().quietRow}</div></section>`;
  }
  const unread = day.items.some(isUnread);
  return `<section class="day${unread ? ' has-unread' : ''}" data-date="${day.date}" aria-label="${fmt(d, { dateStyle: 'full' })}">${rail}
    <div>
      ${day.pattern ? `<p class="day-pattern reveal"><b>${t().pattern}</b>${esc(patternOf(day))}</p>` : ''}
      <ul class="rows">${day.items.map(rowHtml).join('')}</ul>
    </div>
  </section>`;
}

function renderFilters(days) {
  const items = days.flatMap((d) => d.items);
  const counts = Object.fromEntries(Object.keys(t().cat).map((c) => [c, items.filter((i) => i.category === c).length]));
  const kinds = Object.fromEntries(Object.keys(t().kind).map((k) => [k, items.filter((i) => i.kind === k).length]));
  const unread = items.filter(isUnread).length;
  $('#archive-title').innerHTML = `${t().earlier}${unread ? `<span class="count">${t().unreadCount(unread)}</span>` : ''}`;
  $('#filters').setAttribute('aria-label', t().filterLabel);
  const kindChips = Object.entries(t().kind)
    .filter(([k]) => kinds[k])
    .map(([k, label]) => `<button class="chip kind-chip" type="button" data-filter="kind:${k}" aria-pressed="${filter.kind === k}">${label} <span class="n">${kinds[k]}</span></button>`);
  $('#filters').innerHTML = [
    `<button class="chip" type="button" data-filter="all" aria-pressed="${filter.cat === 'all' && !filter.kind}">${t().all} <span class="n">${items.length}</span></button>`,
    ...Object.entries(t().cat)
      .filter(([c]) => counts[c])
      .map(([c, label]) => `<button class="chip" type="button" data-filter="${c}" data-cat="${c}" aria-pressed="${filter.cat === c}">${label} <span class="n">${counts[c]}</span></button>`),
    kindChips.length ? `<span class="chip-gap" aria-hidden="true"></span>${kindChips.join('')}` : '',
    unread || filter.unread ? `<button class="chip unread-chip" type="button" data-filter="unread" aria-pressed="${filter.unread}">${t().unread} <span class="n">${unread}</span></button>` : '',
  ].join('');
}

function applyFilters() {
  let shown = 0;
  for (const day of document.querySelectorAll('#archive .day')) {
    const rows = [...day.querySelectorAll('.row')];
    let visible = 0;
    for (const r of rows) {
      const ok =
        (filter.cat === 'all' || r.dataset.cat === filter.cat) && (!filter.kind || r.dataset.kind === filter.kind) && (!filter.unread || r.classList.contains('unread'));
      r.hidden = !ok;
      if (ok) visible++;
    }
    const quiet = day.classList.contains('quiet-day');
    day.hidden = quiet ? filter.cat !== 'all' || !!filter.kind || filter.unread : visible === 0;
    if (!day.hidden) shown++;
  }
  let empty = $('#archive .empty');
  if (!shown && document.querySelector('#archive .day')) {
    if (!empty) {
      empty = document.createElement('p');
      empty.className = 'empty';
      $('#archive').append(empty);
    }
    empty.innerHTML = `${t().noMatch}<button type="button" data-filter="reset">${t().showAll}</button>`;
  } else empty?.remove();
}

function renderArchive(days) {
  const el = $('#archive');
  if (!days.length) {
    el.innerHTML = `<p class="empty">${t().noArchive}</p>`;
    $('#filters').innerHTML = '';
    return;
  }
  el.innerHTML = days.map(dayHtml).join('');
  renderFilters(days);
  applyFilters();
}

/* ---------- top of the page ---------- */

function greeting() {
  const h = today.getHours();
  const g = t().greet;
  if (h >= 4 && h < 12) return g.morning;
  if (h >= 12 && h < 18) return g.afternoon;
  if (h >= 18 && h < 23) return g.evening;
  return g.late;
}

function appList(items) {
  const apps = [...new Set(items.map((i) => i.app))];
  return apps.length > 5 ? t().and(apps.slice(0, 5), apps.length - 5) : t().list(apps);
}

function summaryHtml(latest) {
  if (!latest) return t().summaryNone;
  const n = latest.items.length;
  const changes = (k) => t().changes(`<span class="count">${k}</span>`, k);
  if (latest.date === todayYmd) return n ? t().summaryToday(changes(n), esc(appList(latest.items))) : t().summaryQuiet;
  const when = latest.date === yesterdayYmd ? t().agoYesterday : fmt(fromYmd(latest.date), { weekday: 'long', day: 'numeric', month: 'short' });
  const stale = latest.date < yesterdayYmd ? t().stale : '';
  return n ? t().summaryFrom(when, changes(n), esc(appList(latest.items)), stale) : t().summaryWasQuiet(when, stale);
}

let typing = 0;
function typeInto(el, html) {
  const run = ++typing; // a newer call (language switch) stops an older one mid-line
  if (reduced) {
    el.innerHTML = `${html}<span class="cursor" aria-hidden="true"></span>`;
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = tmp.textContent;
  el.setAttribute('aria-label', text);
  let i = 0;
  const tick = () => {
    if (run !== typing) return;
    i = Math.min(text.length, i + 2);
    el.innerHTML = `${esc(text.slice(0, i))}<span class="cursor typing" aria-hidden="true"></span>`;
    if (i < text.length) setTimeout(tick, 22);
    else {
      el.innerHTML = `${html}<span class="cursor" aria-hidden="true"></span>`;
      el.removeAttribute('aria-label');
    }
  };
  setTimeout(tick, 380);
}

function renderTop(radar, meta, latest) {
  const name = (meta.reader || '').trim();
  const h = today.getHours();
  const sky = h >= 5 && h < 18 ? sun('sky') : moon('sky');
  $('#greeting').innerHTML = `${sky}<span>${esc(t().greeting(greeting(), name))}</span>`;
  typeInto($('#summary'), summaryHtml(latest));
  $('#issue').innerHTML = t().issue(radar.days.length, fmt(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  const updated = radar.updated_at && radar.days.length ? new Date(radar.updated_at) : null;
  $('#footer').innerHTML = `<span>${t().footerName}</span><span>${
    updated ? t().footerRun(fmt(updated, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : ''
  }${t().footerFeeds(meta.feeds ?? '?', meta.search, esc(meta.ai || 'Claude'))}</span>`;
}

/* ---------- motion ---------- */

function drawCover(ctx, img, w, h) {
  const ir = img.naturalWidth / img.naturalHeight;
  const cr = w / h;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  let sx = 0;
  let sy = 0;
  if (ir > cr) {
    sw = sh * cr;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = sw / cr;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

/** Images arrive blocky and sharpen in a few steps, like a slow modem. Started when their card scrolls in. */
function pixelate(box) {
  if (box.dataset.pixelated) return;
  box.dataset.pixelated = '1';
  const img = box.querySelector('img');
  const done = () => box.classList.remove('pending');
  const run = () => {
    if (!img?.naturalWidth) return done();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    box.append(canvas);
    done();
    // Small thumbnails need fewer, smaller steps than a story picture.
    const steps = box.clientWidth < 200 ? [4, 8, 16, 32] : [5, 10, 20, 40, 80];
    let i = 0;
    // However the steps go (a tab in the background slows timers down), the photo ends sharp.
    setTimeout(() => canvas.remove(), 4000);
    const tick = () => {
      if (i === steps.length) return canvas.remove();
      const w = steps[i++];
      const h = Math.max(1, Math.round((w * box.clientHeight) / Math.max(1, box.clientWidth)));
      canvas.width = w;
      canvas.height = h;
      try {
        if (box.classList.contains('whole')) {
          const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
          const dw = img.naturalWidth * k;
          const dh = img.naturalHeight * k;
          ctx.fillStyle = getComputedStyle(box).backgroundColor;
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        } else drawCover(ctx, img, w, h);
      } catch {
        return canvas.remove();
      }
      setTimeout(tick, 85);
    };
    tick();
  };
  if (!img) return done();
  if (img.complete) run();
  else {
    img.addEventListener('load', run, { once: true });
    setTimeout(done, 3000); // never leave an image hidden
  }
}

/** Cards, dates and rows print in, left to right, as they scroll into view. Images inside then sharpen. */
let revealer = null;
function wireReveal() {
  revealer?.disconnect(); // re-drawn after a language switch
  const all = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    for (const el of all) el.classList.remove('reveal');
    for (const box of document.querySelectorAll('.pending')) box.classList.remove('pending');
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      const shown = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
      shown.forEach((e, n) => {
        const el = e.target;
        io.unobserve(el);
        el.style.animationDelay = `${Math.min(n, 6) * 90}ms`;
        el.classList.add('in');
        // If the animation never runs (a background tab, a browser setting), show the card anyway.
        setTimeout(() => {
          el.classList.remove('reveal', 'in');
          el.style.animationDelay = '';
        }, Math.min(n, 6) * 90 + 1200);
        const pending = el.matches('.row') ? el.querySelector('.row-thumb.pending') : el.querySelector('.media.pending');
        if (pending) setTimeout(() => pixelate(pending), Math.min(n, 6) * 90 + 200);
        el.addEventListener(
          'animationend',
          (ev) => {
            // Ignore animations of children and of the date's ::after node; only the print-in itself ends the reveal.
            if (ev.target !== el || ev.pseudoElement || !['print-in', 'drop-in'].includes(ev.animationName)) return;
            el.classList.remove('reveal', 'in');
            el.style.animationDelay = '';
          },
          { once: false },
        );
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  revealer = io;
  for (const el of all) io.observe(el);
}

/** A photo that fails to load (a site that refuses to be shown elsewhere, or a removed file) becomes the app's icon. */
function placeholderOnError(img) {
  img.addEventListener(
    'error',
    () => {
      const holder = img.parentElement;
      if (!holder || img.closest('.ph-icon')) return;
      holder.classList.remove('pending', 'whole');
      holder.closest('.frame')?.classList.remove('photo');
      holder.classList.add('image-error');
      holder.innerHTML = '';
    },
    { once: true },
  );
}

function wireImages() {
  for (const img of document.querySelectorAll('.media img, .row-thumb img')) placeholderOnError(img);
  for (const img of document.querySelectorAll('.media img, .row-thumb img')) fitWhole(img);
  tileIcons();
}

/**
 * Pictures fill their frame, trimming the edges. A picture much wider or taller than the frame (a grid of a
 * dozen app icons, a tall phone screen) would lose what matters, so it is shown whole on the frame's paper instead.
 */
function fitWhole(img) {
  const check = () => {
    const box = img.parentElement;
    if (!img.naturalWidth || !box?.clientWidth || box.classList.contains('placeholder') || img.closest('.ph-icon')) return;
    const ratio = img.naturalWidth / img.naturalHeight / (box.clientWidth / box.clientHeight);
    box.classList.toggle('whole', ratio > 1.35 || ratio < 0.74);
  };
  if (img.complete) check();
  else img.addEventListener('load', check, { once: true });
}

/**
 * Logos sit on a light tile (see .icon in styles.css). This finds the few that are light on a transparent
 * background, such as a white mark, and gives them a dark tile. It reads the pixels, which works for the
 * icons copied into the site; for one still on another server the browser forbids it, and the light tile stays.
 */
const tileCache = new Map(); // src -> true (dark tile) | false
function tileIcons() {
  for (const img of document.querySelectorAll('img.icon, .sources .stack img, .ph-icon img')) {
    const apply = () => {
      if (!tileCache.has(img.src)) tileCache.set(img.src, needsDarkTile(img));
      img.classList.toggle('on-dark', tileCache.get(img.src));
    };
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener('load', apply, { once: true });
  }
}

function needsDarkTile(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 16, 16);
    const px = ctx.getImageData(0, 0, 16, 16).data;
    let seen = 0, clear = 0, light = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 40) {
        clear++;
        continue;
      }
      seen++;
      if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 200) light++;
    }
    // A see-through logo whose ink is mostly near-white. Full-bleed icons (App Store) have no clear pixels.
    return clear > 25 && seen > 0 && light / seen > 0.6;
  } catch {
    return false;
  }
}

function wireLogo() {
  const logo = $('#logo');
  logo.innerHTML = paperLogo();
  if (reduced) return;
  const print = () => {
    logo.classList.remove('printing');
    void logo.offsetWidth; // restart the animation
    logo.classList.add('printing');
  };
  print();
  $('.wordmark').addEventListener('mouseenter', print);
}

/**
 * The timeline fills with the accent colour as you scroll, like a loading bar. The "reading line" sits 45% down the screen
 * and slides to the bottom as you reach the end of the page, so the last day fills completely.
 * Each date turns the accent colour when the fill passes its square. On a phone the sticky date header fills left to right.
 */
function wireRail() {
  let queued = false;
  const update = () => {
    queued = false;
    const days = [...document.querySelectorAll('#archive .day:not([hidden]), #wf-list .day:not([hidden]), #cs-list .day:not([hidden])')].filter((d) => d.offsetParent);
    if (!days.length) return;
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    const nearEnd = maxScroll > 0 ? Math.max(0, (scrollY - (maxScroll - innerHeight)) / innerHeight) : 1;
    const line = innerHeight * (0.45 + 0.55 * Math.min(1, nearEnd));
    for (const day of days) {
      const fill = day.querySelector('.rail-fill');
      const r = day.getBoundingClientRect();
      const px = Math.max(0, Math.min(r.height, line - r.top));
      const stepped = Math.floor(px / 4) * 4;
      fill.style.setProperty('--fill', `${stepped}px`);
      fill.style.setProperty('--tip', stepped > 0 && stepped < r.height - 4 ? '1' : '0');
      fill.style.setProperty('--fill-x', `${Math.round((px / Math.max(1, r.height)) * 100)}%`);
      const node = day.querySelector('.rail-inner').getBoundingClientRect();
      day.classList.toggle('reached', line >= node.top + 12 && px > 0);
    }
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  // Rows opening and filters changing move the days; redraw then too.
  new ResizeObserver(queue).observe($('#archive'));
  new ResizeObserver(queue).observe($('#wf-list'));
  new ResizeObserver(queue).observe($('#cs-list'));
  update();
}

/* ---------- theme ---------- */

function paintTheme() {
  const btn = $('#theme');
  const dark = document.documentElement.dataset.theme === 'dark';
  btn.innerHTML = dark ? sun() : moon();
  btn.setAttribute('aria-label', dark ? t().toLight : t().toDark);
  $('meta[name="theme-color"]').content = dark ? '#000000' : '#f5ffe5';
}

/* ---------- font: the pixel font (default) or a simpler one ---------- */

function paintFont() {
  const btn = $('#font');
  const label = document.documentElement.dataset.font === 'clean' ? t().toPixelFont : t().toCleanFont;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function wireFont() {
  $('#font').addEventListener('click', () => {
    const clean = document.documentElement.dataset.font !== 'clean';
    if (clean) document.documentElement.dataset.font = 'clean';
    else delete document.documentElement.dataset.font;
    try {
      localStorage.setItem('radar.font', clean ? 'clean' : 'pixel');
    } catch {}
    // Text takes a different amount of room in the other font, so the cards are drawn again.
    render();
  });
}

function wireTheme() {
  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('radar.theme', next);
    } catch {}
    paintTheme();
  });
  paintTheme();
}

/* ---------- weekly digest ---------- */

/** Monday of the week a YYYY-MM-DD date falls in. */
function weekOf(dateStr) {
  const d = fromYmd(dateStr);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}
function weekRange(monday) {
  const a = fromYmd(monday);
  const b = new Date(a.getTime() + 6 * 86_400_000);
  const o = { day: 'numeric', month: 'short' };
  return `${fmt(a, o)} – ${fmt(b, o)}`;
}
const allItems = () => (radar.days ?? []).flatMap((d) => d.items.map((i) => ({ ...i, day: d.date })));
let digestWeek = null;

/** Weeks that have saved items, newest first. */
function savedWeeks() {
  const weeks = new Set(allItems().filter((i) => isSaved(i.id)).map((i) => weekOf(i.day)));
  return [...weeks].sort().reverse();
}
function itemsInWeek(week) {
  return allItems().filter((i) => isSaved(i.id) && weekOf(i.day) === week);
}

function paintDigestCount() {
  const n = Object.keys(saved).filter((id) => allItems().some((i) => i.id === id)).length;
  const badge = $('#digest .n');
  if (badge) {
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }
}

// Share links sent before sharing was removed (Nov 2026) carry the week, saved ids with notes and a name in
// the address (#d=...). They still open, read-only.
function fromB64(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}
function digestRow(i, removable) {
  return `<li class="d-item" data-id="${esc(i.id)}">
    <div class="meta"><span class="app">${appIcon(i)}${esc(i.app)}</span>${kindTag(i)}<span class="when">${esc(fmt(fromYmd(i.day), { weekday: 'short', day: 'numeric', month: 'short' }))}</span></div>
    <p class="d-head"><a href="${esc(safeUrl(i.sources?.[0]?.url))}" target="_blank" rel="noopener">${esc(txt(i, 'headline'))}</a></p>
    <p class="d-why">${esc(txt(i, 'why'))}</p>
    ${i.note ? `<p class="d-note"><b>${t().textNote}</b>${esc(i.note)}</p>` : ''}
    ${removable ? `<button class="act d-remove" type="button" data-unsave="${esc(i.id)}">${t().remove}</button>` : ''}
  </li>`;
}

function renderDigest() {
  const box = $('#digest-box');
  const weeks = savedWeeks();
  if (!digestWeek || !weeks.includes(digestWeek)) digestWeek = weeks.includes(weekOf(todayYmd)) ? weekOf(todayYmd) : (weeks[0] ?? weekOf(todayYmd));
  const at = weeks.indexOf(digestWeek);
  const list = itemsInWeek(digestWeek).map((i) => ({ ...i, note: noteOf(i.id) }));
  box.innerHTML = `
    <header class="d-top">
      <h2>${t().digestTitle}</h2>
      <button class="act" type="button" data-close>${t().close}</button>
    </header>
    <div class="d-week">
      <button class="act" type="button" data-week="-1" ${at < 0 || at >= weeks.length - 1 ? 'disabled' : ''} aria-label="${t().prevWeek}">‹</button>
      <span>${esc(weekRange(digestWeek))}</span>
      <button class="act" type="button" data-week="1" ${at <= 0 ? 'disabled' : ''} aria-label="${t().nextWeek}">›</button>
    </div>
    ${
      list.length
        ? `<ol class="d-list">${list.map((i) => digestRow(i, true)).join('')}</ol>`
        : `<p class="empty">${t().digestEmpty}</p>`
    }`;
}

/** A digest someone sent: read-only, from the link alone. */
function renderShared(payload) {
  const box = $('#digest-box');
  const byId = new Map(allItems().map((i) => [i.id, i]));
  const list = (payload.i ?? []).map(([id, note]) => (byId.has(id) ? { ...byId.get(id), note: note ?? '' } : null));
  const found = list.filter(Boolean);
  const missing = list.length - found.length;
  box.innerHTML = `
    <header class="d-top">
      <h2>${esc(t().sharedTitle(payload.f ?? ''))}</h2>
      <button class="act" type="button" data-close>${t().close}</button>
    </header>
    <div class="d-week"><span>${esc(weekRange(payload.w ?? weekOf(todayYmd)))}</span></div>
    ${payload.t ? `<p class="d-intro">${esc(payload.t)}</p>` : ''}
    <ol class="d-list">${found.map((i) => digestRow(i, false)).join('')}</ol>
    ${missing ? `<p class="d-hint">${t().sharedMissing(missing)}</p>` : ''}`;
}

let sharedPayload = null;
function openDigest() {
  const dlg = $('#digest-dialog');
  if (sharedPayload) renderShared(sharedPayload);
  else renderDigest();
  if (!dlg.open) dlg.showModal?.() ?? dlg.setAttribute('open', '');
}

function wireDigest() {
  const dlg = $('#digest-dialog');
  $('#digest').addEventListener('click', () => {
    sharedPayload = null;
    openDigest();
  });
  dlg.addEventListener('close', () => {
    if (sharedPayload) {
      sharedPayload = null;
      history.replaceState(null, '', location.pathname + location.search);
    }
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // click on the backdrop
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.close !== undefined) dlg.close();
    if (b.dataset.week) {
      const weeks = savedWeeks();
      const at = weeks.indexOf(digestWeek) - Number(b.dataset.week);
      if (weeks[at]) digestWeek = weeks[at];
      renderDigest();
    }
    if (b.dataset.unsave) {
      setSaved(b.dataset.unsave, false);
      paintNote(b.dataset.unsave);
      renderDigest();
    }
  });
  // Opened from a share link?
  const d = location.hash.match(/^#d=([\w-]+)/)?.[1];
  if (d) {
    sharedPayload = fromB64(d);
    if (sharedPayload) openDigest();
  }
}

/* ---------- language switch ---------- */

/** Static text in index.html, the switch's own label, and the page language for fonts and screen readers. */
function paintLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t().title;
  $('.skip').textContent = t().skip;
  $('.wordmark').setAttribute('aria-label', t().home);
  const btn = $('#lang');
  btn.textContent = t().langButton;
  btn.setAttribute('aria-label', t().langLabel);
  btn.setAttribute('lang', lang === 'zh' ? 'en' : 'zh-CN');
  const dg = $('#digest .label');
  if (dg) dg.textContent = t().digest;
  paintTheme();
  paintFont();
  if ($('#digest-dialog')?.open) openDigest();
}

function wireLanguage() {
  $('#lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    try {
      localStorage.setItem('radar.lang', lang);
    } catch {}
    render();
  });
}

/* ---------- AI workflows (trial) ---------- */

let workflows = null; // data/workflows.json once loaded
const wfFilter = { stage: null, tool: null };
const wfTxt = (w, field) => (lang === 'zh' && w.zh?.[field]) || w[field];

/** A small pixel spark: the page's mark for AI workflows. */
const SPARK = [
  '.....a.....',
  '.....a.....',
  '....aaa....',
  'aaaaaoaaaaa',
  '....aaa....',
  '.....a.....',
  '.....a..o..',
  '.......ooo.',
  '........o..',
];
const spark = () => pixels(SPARK, { a: 'var(--accent)', o: 'var(--sun)' }, 'sky');

function wfRowHtml(w) {
  const link = `href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener"`;
  const thumb = w.image
    ? `<a class="row-thumb notch${reduced ? '' : ' pending'}" ${link} tabindex="-1" aria-hidden="true" style="--c: var(--accent)" data-fallback="${esc(w.icon_large || iconAt(w.icon, 64))}"><img src="${esc(w.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : `<a class="row-thumb notch placeholder" ${link} tabindex="-1" aria-hidden="true" style="--c: var(--accent)">${placeholderHtml(w.icon_large || iconAt(w.icon, 64))}</a>`;
  const by = [w.author ? t().wfBy(esc(w.author)) : '', w.author_role ? esc(w.author_role) : ''].filter(Boolean).join(', ');
  const icon = `<img class="icon notch row-icon" src="${esc(iconAt(w.icon, 16))}" alt="" width="24" height="24" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
  const catchText = wfTxt(w, 'catch');
  return `<li class="row wf-row reveal read" data-id="${esc(w.id)}" data-stage="${esc(w.stage)}" data-tools="${esc(w.tools.join('|'))}">
    <div class="row-head">
      <span class="dot" aria-hidden="true"></span>
      ${icon}
      <div class="row-main">
        <p class="row-top"><span class="app">${esc(w.source)}</span><span class="kind">${t().stage[w.stage] ?? esc(w.stage)}</span><span class="wf-type">${t().wfType[w.type] ?? esc(w.type)}</span>${w.minutes ? `<span class="when">${t().wfMin(w.minutes)}</span>` : ''}</p>
        <h3 class="row-title"><a ${link}>${esc(wfTxt(w, 'title'))}</a></h3>
        ${by || w.tools.length ? `<p class="wf-by">${by}${by && w.tools.length ? ' · ' : ''}${w.tools.map((x) => `<span class="wf-tool">${esc(x)}</span>`).join('')}</p>` : ''}
        <p class="what clamp">${esc(wfTxt(w, 'process'))}</p>
      </div>
    </div>
    ${thumb}
    <div class="fold row-fold">
      <div class="more-body" id="more-wf-${esc(w.id)}" hidden>
        <div class="more-in">
          <dl class="wf-facts">
            <div><dt>${t().wfResult}</dt><dd>${esc(wfTxt(w, 'result'))}</dd></div>
            ${catchText ? `<div><dt>${t().wfCatch}</dt><dd>${esc(catchText)}</dd></div>` : ''}
            <div><dt>${t().wfTryIf}</dt><dd>${esc(wfTxt(w, 'try_if'))}</dd></div>
          </dl>
          <p class="wf-read"><a class="act" ${link}>${t().wfRead} ↗</a><span class="wf-src">${esc(w.post_title)}</span></p>
        </div>
      </div>
      ${moreBtn(`more-wf-${w.id}`)}
    </div>
  </li>`;
}

function wfWeekHtml(week) {
  const d = fromYmd(week.week);
  const rail = `<div class="rail"><span class="rail-fill" aria-hidden="true"></span><div class="rail-inner reveal"><span class="rail-day">${t().wfWeek}</span><span class="rail-date">${fmt(d, { day: 'numeric', month: 'short' })}</span></div></div>`;
  if (!week.picks.length) {
    return `<section class="day quiet-day" data-week="${week.week}">${rail}<div class="rows reveal">${t().wfQuietRow}</div></section>`;
  }
  return `<section class="day" data-week="${week.week}">${rail}<div><ul class="rows">${week.picks.map(wfRowHtml).join('')}</ul></div></section>`;
}

function renderWfFilters(weeks) {
  const picks = weeks.flatMap((w) => w.picks);
  const stages = Object.keys(t().stage).filter((s) => picks.some((p) => p.stage === s));
  const tools = [...new Set(picks.flatMap((p) => p.tools))].sort((a, b) => picks.filter((p) => p.tools.includes(b)).length - picks.filter((p) => p.tools.includes(a)).length).slice(0, 8);
  const n = (f) => picks.filter(f).length;
  const box = $('#wf-filters');
  box.setAttribute('aria-label', t().wfFilterLabel);
  box.innerHTML = picks.length
    ? [
        `<button class="chip" type="button" data-wf="all" aria-pressed="${!wfFilter.stage && !wfFilter.tool}">${t().wfAllStages} <span class="n">${picks.length}</span></button>`,
        ...stages.map((s) => `<button class="chip" type="button" data-wf="stage:${s}" aria-pressed="${wfFilter.stage === s}">${t().stage[s]} <span class="n">${n((p) => p.stage === s)}</span></button>`),
        tools.length ? '<span class="chip-gap" aria-hidden="true"></span>' : '',
        ...tools.map((x) => `<button class="chip kind-chip" type="button" data-wf="tool:${esc(x)}" aria-pressed="${wfFilter.tool === x}">${esc(x)} <span class="n">${n((p) => p.tools.includes(x))}</span></button>`),
      ].join('')
    : '';
}

function applyWfFilters() {
  for (const day of document.querySelectorAll('#wf-list .day')) {
    const rows = [...day.querySelectorAll('.row')];
    let shown = 0;
    for (const r of rows) {
      const ok = (!wfFilter.stage || r.dataset.stage === wfFilter.stage) && (!wfFilter.tool || r.dataset.tools.split('|').includes(wfFilter.tool));
      r.hidden = !ok;
      if (ok) shown++;
    }
    // Quiet weeks and weeks with nothing matching hide while a filter is on.
    day.hidden = (wfFilter.stage || wfFilter.tool) && !shown;
  }
}

function renderWorkflows() {
  $('#wf-title').innerHTML = `${spark()}<span>${t().wfTitle}</span>`;
  $('#wf-list-title').textContent = t().wfList;
  if (!workflows) {
    $('#wf-summary').textContent = t().wfLoading;
    return;
  }
  const weeks = workflows.weeks ?? [];
  const latest = weeks[0];
  $('#wf-summary').innerHTML = !latest ? t().wfNone : latest.picks.length ? t().wfSummary(t().wfPicks(latest.picks.length), latest.checked) : t().wfQuiet(latest.checked);
  renderWfFilters(weeks);
  $('#wf-list').innerHTML = weeks.map(wfWeekHtml).join('');
  applyWfFilters();
  wireImages();
  wireReveal();
}

async function loadWorkflows() {
  if (workflows) return;
  try {
    const r = await fetch('data/workflows.json', { cache: 'no-store' });
    workflows = r.ok ? await r.json() : { weeks: [] };
  } catch {
    workflows = { weeks: [] };
  }
}

/* ---------- Case studies ---------- */

let cases = null; // data/cases.json once loaded
const csFilter = { area: null };
const csTxt = (c, field) => (lang === 'zh' && c.zh?.[field]) || c[field];

/** A small pixel briefcase: the page's mark for case studies. */
const CASE = [
  '...oooo....',
  '...o..o....',
  'aaaaaaaaaaa',
  'a.........a',
  'aaaaaoaaaaa',
  'a....o....a',
  'a.........a',
  'aaaaaaaaaaa',
];
const briefcase = () => pixels(CASE, { a: 'var(--accent)', o: 'var(--sun)' }, 'sky');

function csRowHtml(c) {
  const link = `href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener"`;
  const thumb = c.image
    ? `<a class="row-thumb notch${reduced ? '' : ' pending'}" ${link} tabindex="-1" aria-hidden="true" style="--c: var(--accent)" data-fallback="${esc(c.icon_large || iconAt(c.icon, 64))}"><img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : `<a class="row-thumb notch placeholder" ${link} tabindex="-1" aria-hidden="true" style="--c: var(--accent)">${placeholderHtml(c.icon_large || iconAt(c.icon, 64))}</a>`;
  const icon = `<img class="icon notch row-icon" src="${esc(iconAt(c.icon, 16))}" alt="" width="24" height="24" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
  const by = c.by ?? '';
  const source = c.source.toLowerCase().startsWith(c.company.toLowerCase()) ? '' : esc(c.source);
  return `<li class="row wf-row cs-row reveal read" data-id="${esc(c.id)}" data-area="${esc(c.area)}">
    <div class="row-head">
      <span class="dot" aria-hidden="true"></span>
      ${icon}
      <div class="row-main">
        <p class="row-top"><span class="app">${esc(c.company)}</span><span class="kind">${t().area[c.area] ?? esc(c.area)}</span><span class="wf-type">${t().maker[c.maker] ?? esc(c.maker)}</span>${c.minutes ? `<span class="when">${t().wfMin(c.minutes)}</span>` : ''}</p>
        <h3 class="row-title"><a ${link}>${esc(csTxt(c, 'title'))}</a></h3>
        ${by || source ? `<p class="wf-by">${[by ? t().wfBy(esc(by)) : '', source].filter(Boolean).join(' · ')}</p>` : ''}
        <p class="what clamp">${esc(csTxt(c, 'problem'))}</p>
      </div>
    </div>
    ${thumb}
    <div class="fold row-fold">
      <div class="more-body" id="more-cs-${esc(c.id)}" hidden>
        <div class="more-in">
          <dl class="wf-facts">
            <div><dt>${t().csApproach}</dt><dd>${esc(csTxt(c, 'approach'))}</dd></div>
            <div><dt>${t().csOutcome}</dt><dd>${esc(csTxt(c, 'outcome'))}</dd></div>
            <div><dt>${t().csLesson}</dt><dd>${esc(csTxt(c, 'lesson'))}</dd></div>
          </dl>
          <p class="wf-read"><a class="act" ${link}>${t().csRead} ↗</a><span class="wf-src">${esc(c.post_title)}</span></p>
        </div>
      </div>
      ${moreBtn(`more-cs-${c.id}`)}
    </div>
  </li>`;
}

function csWeekHtml(week) {
  const d = fromYmd(week.week);
  const rail = `<div class="rail"><span class="rail-fill" aria-hidden="true"></span><div class="rail-inner reveal"><span class="rail-day">${t().wfWeek}</span><span class="rail-date">${fmt(d, { day: 'numeric', month: 'short' })}</span></div></div>`;
  if (!week.picks.length) {
    return `<section class="day quiet-day" data-week="${week.week}">${rail}<div class="rows reveal">${t().csQuietRow}</div></section>`;
  }
  return `<section class="day" data-week="${week.week}">${rail}<div><ul class="rows">${week.picks.map(csRowHtml).join('')}</ul></div></section>`;
}

function renderCsFilters(weeks) {
  const picks = weeks.flatMap((w) => w.picks);
  const areas = Object.keys(t().area).filter((a) => picks.some((p) => p.area === a));
  const box = $('#cs-filters');
  box.setAttribute('aria-label', t().csFilterLabel);
  // One area is no choice, so the chips only show once there are two.
  box.innerHTML =
    areas.length > 1
      ? [
          `<button class="chip" type="button" data-cs="all" aria-pressed="${!csFilter.area}">${t().wfAllStages} <span class="n">${picks.length}</span></button>`,
          ...areas.map((a) => `<button class="chip" type="button" data-cs="${a}" aria-pressed="${csFilter.area === a}">${t().area[a]} <span class="n">${picks.filter((p) => p.area === a).length}</span></button>`),
        ].join('')
      : '';
}

function applyCsFilters() {
  for (const day of document.querySelectorAll('#cs-list .day')) {
    const rows = [...day.querySelectorAll('.row')];
    let shown = 0;
    for (const r of rows) {
      r.hidden = !!csFilter.area && r.dataset.area !== csFilter.area;
      if (!r.hidden) shown++;
    }
    day.hidden = !!csFilter.area && !shown;
  }
}

function renderCases() {
  $('#cs-title').innerHTML = `${briefcase()}<span>${t().csTitle}</span>`;
  $('#cs-list-title').textContent = t().wfList;
  if (!cases) {
    $('#cs-summary').textContent = t().wfLoading;
    return;
  }
  const weeks = cases.weeks ?? [];
  const latest = weeks[0];
  $('#cs-summary').innerHTML = !latest ? t().wfNone : latest.picks.length ? t().csSummary(t().csPicks(latest.picks.length), latest.checked) : t().csQuiet(latest.checked);
  renderCsFilters(weeks);
  $('#cs-list').innerHTML = weeks.map(csWeekHtml).join('');
  applyCsFilters();
  wireImages();
  wireReveal();
}

async function loadCases() {
  if (cases) return;
  try {
    const r = await fetch('data/cases.json', { cache: 'no-store' });
    cases = r.ok ? await r.json() : { weeks: [] };
  } catch {
    cases = { weeks: [] };
  }
}

/* ---------- Games ---------- */

let games = null; // games.js, loaded the first time the tab opens

/** A small pixel game controller: the page's mark for games. */
const PAD = [
  '..aaaaaaa..',
  '.aaaaaaaaa.',
  'aaoaaaaaaaa',
  'aooooaaoaoa',
  'aaoaaaaaaaa',
  'aaaaaaaaaaa',
  'aaa.....aaa',
  '.a.......a.',
];
const gamepad = () => pixels(PAD, { a: 'var(--accent)', o: 'var(--sun)' }, 'sky');

function renderGames() {
  $('#gm-title').innerHTML = `${gamepad()}<span>${t().gmTitle}</span>`;
  $('#gm-summary').innerHTML = t().gmSummary;
  if (games) games.showGames($('#gm-box'), lang);
}

async function loadGames() {
  games ||= await import('./games.js');
}

/* ---------- pages ---------- */

/** The pages besides News, each shown only while its yaml file has it on (meta.json says which). */
const PAGES = {
  cases: { on: () => !!meta.cases, label: () => t().viewCases, render: renderCases, load: loadCases },
  workflows: { on: () => !!meta.workflows, label: () => t().viewWorkflows, render: renderWorkflows, load: loadWorkflows },
  games: { on: () => true, label: () => t().viewGames, render: renderGames, load: loadGames },
};

/** News, Case studies, AI workflows or Games, from the address (#cases, #workflows, #games). */
async function showView() {
  const on = Object.keys(PAGES).filter((k) => PAGES[k].on());
  $('#views').hidden = !on.length;
  const asked = location.hash.slice(1);
  const view = on.includes(asked) ? asked : 'news';
  document.body.dataset.view = view;
  for (const a of document.querySelectorAll('.view-tab')) {
    const v = a.dataset.view;
    a.hidden = v !== 'news' && !on.includes(v);
    a.textContent = v === 'news' ? t().viewNews : PAGES[v].label();
    if (v === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('#views').setAttribute('aria-label', t().viewsLabel);
  // On a phone the tabs scroll sideways; keep the open one in view.
  const current = $('#views').querySelector('[aria-current="page"]');
  if (current && $('#views').scrollWidth > $('#views').clientWidth) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (view !== 'games') games?.leaveGames();
  const page = PAGES[view];
  if (!page) return;
  page.render();
  await page.load();
  page.render();
}

/* ---------- opening a card or row ---------- */

const EASE = 'cubic-bezier(0.3, 0, 0.2, 1)';

/**
 * More / Less. The summary and the opened text grow (or shrink) together in one motion, and the button,
 * pinned to the bottom, rides along. Opening also prints the text in from the top, like the scroll reveal.
 * A second click mid-way starts from wherever the motion has got to. Reduced motion just shows and hides.
 */
function toggleMore(btn) {
  const open = btn.getAttribute('aria-expanded') !== 'true';
  const host = btn.closest('.row, .card');
  const what = host.querySelector('.what');
  const fold = btn.closest('.fold');
  const body = document.getElementById(btn.getAttribute('aria-controls'));
  const inner = body.firstElementChild;
  btn.setAttribute('aria-expanded', String(open));
  btn.querySelector('.more-label').textContent = open ? t().less : t().more;
  host.classList.toggle('open', open);

  if (open && host.classList.contains('unread')) {
    markRead([host.dataset.id]);
    host.classList.replace('unread', 'read');
    const day = host.closest('.day');
    day?.classList.toggle('has-unread', !!day.querySelector('.row.unread'));
    renderFilters(archiveDays);
  }

  // Where things are now, mid-motion or not, before stopping any running animation.
  const from = [what.getBoundingClientRect().height, fold.getBoundingClientRect().height];
  for (const el of [what, fold, inner]) el.getAnimations().forEach((a) => a.cancel());
  fold.classList.remove('moving');

  const settle = (isOpen) => {
    what.classList.toggle('clamp', !isOpen);
    body.hidden = !isOpen;
  };
  if (reduced) return settle(open);

  // Measure the end state, then show the full text while moving so nothing jumps.
  settle(open);
  const to = [what.offsetHeight, fold.offsetHeight];
  settle(true);
  fold.classList.add('moving');
  const timing = { duration: open ? 260 : 220, easing: EASE };
  what.animate([{ height: `${from[0]}px` }, { height: `${to[0]}px` }], timing);
  const run = fold.animate([{ height: `${from[1]}px` }, { height: `${to[1]}px` }], timing);
  if (open) {
    inner.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 320, easing: 'steps(6, end)' });
  }
  run.onfinish = () => {
    fold.classList.remove('moving');
    settle(open);
  };
}

/* ---------- events ---------- */

function wireEvents() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;

    if (t.dataset.read) {
      markRead([t.dataset.read]);
      const row = document.querySelector(`.row[data-id="${CSS.escape(t.dataset.read)}"]`);
      if (row) {
        row.classList.replace('unread', 'read');
        renderFilters(archiveDays);
      }
    }

    if (t.dataset.save) {
      setSaved(t.dataset.save, !isSaved(t.dataset.save));
      if (!isSaved(t.dataset.save)) paintNote(t.dataset.save);
    }
    if (t.dataset.note) {
      const wrap = t.closest('.actions').parentElement;
      const editor = wrap.querySelector(`.note-editor[data-editor-for="${CSS.escape(t.dataset.note)}"]`);
      const text = wrap.querySelector(`.note-text[data-note-text-for="${CSS.escape(t.dataset.note)}"]`);
      const open = editor.hidden;
      editor.hidden = !open;
      text.hidden = open || !noteOf(t.dataset.note);
      t.setAttribute('aria-expanded', String(open));
      if (open) {
        const box = editor.querySelector('textarea');
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
    if (t.dataset.noteSave) saveNoteFrom(t.closest('.note-editor').querySelector('textarea'));

    if (t.classList.contains('more')) toggleMore(t);

    const wf = t.dataset.wf;
    if (wf) {
      if (wf === 'all') Object.assign(wfFilter, { stage: null, tool: null });
      else if (wf.startsWith('stage:')) wfFilter.stage = wfFilter.stage === wf.slice(6) ? null : wf.slice(6);
      else if (wf.startsWith('tool:')) wfFilter.tool = wfFilter.tool === wf.slice(5) ? null : wf.slice(5);
      renderWfFilters(workflows?.weeks ?? []);
      applyWfFilters();
    }

    const cs = t.dataset.cs;
    if (cs) {
      csFilter.area = cs === 'all' || csFilter.area === cs ? null : cs;
      renderCsFilters(cases?.weeks ?? []);
      applyCsFilters();
    }

    const f = t.dataset.filter;
    if (f) {
      if (f === 'unread') filter.unread = !filter.unread;
      else if (f === 'reset') Object.assign(filter, { cat: 'all', kind: null, unread: false });
      else if (f === 'all') Object.assign(filter, { cat: 'all', kind: null });
      else if (f.startsWith('kind:')) filter.kind = filter.kind === f.slice(5) ? null : f.slice(5);
      else filter.cat = f;
      renderFilters(archiveDays);
      applyFilters();
    }
  });
}

/** Saves a note box: stores the note, stars the item, closes the box and shows the note as text. */
function saveNoteFrom(box) {
  setNote(box.dataset.noteFor, box.value.trim());
  paintNote(box.dataset.noteFor);
}

// The Save note button wakes up as soon as the note differs from what is stored.
document.addEventListener('input', (e) => {
  const id = e.target.dataset?.noteFor;
  if (id === undefined) return;
  const btn = e.target.closest('.note-editor')?.querySelector('.note-save');
  if (btn) btn.disabled = e.target.value.trim() === noteOf(id);
});
// Cmd/Ctrl+Enter saves; Escape closes the box without saving.
document.addEventListener('keydown', (e) => {
  if (e.target.dataset?.noteFor === undefined) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveNoteFrom(e.target);
  } else if (e.key === 'Escape') {
    paintNote(e.target.dataset.noteFor);
  }
});

/* ---------- start ---------- */

let radar = { days: [] };
let meta = {};
let archiveDays = [];

/** Draws everything in the current language. Runs at start and again after the 中/EN switch. */
function render() {
  paintLanguage();
  const days = radar.days ?? [];
  const latest = days[0];
  // Today's paper is the newest day; the archive is everything before it.
  archiveDays = days.slice(1);
  renderTop(radar, meta, latest);
  renderToday(latest);
  renderArchive(archiveDays);
  wireImages();
  wireReveal();
  paintDigestCount();
  showView();
}

async function main() {
  wireLogo();
  wireTheme();
  wireFont();
  wireLanguage();
  paintLanguage();
  try {
    const [r, m] = await Promise.all([fetch('data/radar.json', { cache: 'no-store' }), fetch('data/meta.json', { cache: 'no-store' })]);
    if (r.ok) radar = await r.json();
    if (m.ok) meta = await m.json();
  } catch {
    $('#summary').textContent = t().loadFailed;
    return;
  }
  render();
  wireRail();
  wireEvents();
  wireDigest();
  addEventListener('hashchange', () => {
    showView();
    scrollTo(0, 0);
  });
}

main();
