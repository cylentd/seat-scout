// Static assets: the stylesheet and the browser-side script, generated from the
// shared theme so colours stay in lockstep with the server-rendered markup.
import { ACCENT, SEAT_COLORS, SEAT_STATES } from './theme.mjs';

export function styles() {
  return `
:root {
  color-scheme: dark;
  --bg:#0b0a10; --surface:#15121d; --surface-2:#1c1826; --border:#272233;
  --text:#eae7f2; --muted:#9b95a4; --muted-2:#767183; --accent:${ACCENT};
  --center:${SEAT_COLORS[4]}; --midback:${SEAT_COLORS[3]}; --flexible:${SEAT_COLORS[2]};
  --front:${SEAT_COLORS[1]}; --accessible:${SEAT_COLORS[5]}; --taken:${SEAT_COLORS[0]};
}
* { box-sizing:border-box; margin:0; -webkit-tap-highlight-color:transparent; }
html { scroll-behavior:smooth; scrollbar-gutter:stable; scrollbar-color:var(--border) transparent; }
body { background:var(--bg); color:var(--text); font:15px/1.55 system-ui,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased; padding-bottom:4rem; overflow-x:hidden; }
a { color:inherit; }
button { font:inherit; }
.wrap { max-width:920px; margin:0 auto; padding:0 1rem; }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:8px; border:3px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background:var(--muted-2); }
:is(a,button):focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:6px; }

/* Hero: poster + title + merged pick podium */
.hero { padding:2.2rem 0 0; }
.hero-top { display:flex; gap:1.3rem; align-items:stretch; }
.poster-wrap { flex:none; width:150px; align-self:stretch; border-radius:12px; overflow:hidden;
  border:1px solid var(--border); box-shadow:0 10px 30px rgba(0,0,0,.45); }
.poster-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
.hero-main { flex:1; min-width:0; }
.hero h1 { font-size:1.35rem; font-weight:650; letter-spacing:.01em; text-wrap:balance; }
.hero .sub { color:var(--muted); margin-top:.25rem; font-size:.95rem; }
.no-picks { margin-top:1.2rem; background:var(--surface); border:1px solid var(--border);
  border-radius:14px; padding:1rem 1.1rem; color:var(--muted); }

.picks { display:grid; grid-template-columns:1.8fr 1fr 1fr; gap:.7rem; margin-top:1.2rem; }
.pick { background:var(--surface); border:1px solid var(--border); border-radius:14px;
  padding:1rem 1.1rem; display:flex; flex-direction:column; gap:.4rem; }
.pick .rank { font-size:.72rem; font-weight:700; letter-spacing:.1em; color:var(--muted-2); text-transform:uppercase; }
.pick .when { font-size:1.05rem; font-weight:650; }
.pick .detail { color:var(--muted); font-size:.82rem; }
.pick .booklinks { display:flex; flex-wrap:wrap; gap:.15rem .8rem; }
.pick .mapjump { align-self:flex-start; background:none; border:0; padding:0; color:var(--muted-2);
  font-size:.8rem; cursor:pointer; margin-top:auto; white-space:nowrap;
  display:inline-flex; align-items:center; gap:.35rem; }
.pick .mapjump svg { width:16px; height:16px; flex:none; stroke-width:1.8; }
.pick .mapjump:hover { color:var(--text); }
.pick.best { background:var(--surface-2);
  border-color:color-mix(in srgb, var(--accent) 45%, var(--border)); gap:.5rem; }
.pick.best .rank { color:var(--accent); }
.pick.best .when { font-size:1.35rem; font-weight:680; }
.pick.best .detail { font-size:.9rem; }
.pick.best .actions { display:flex; align-items:center; gap:.8rem; margin-top:.5rem; }
.pick.best .actions .mapjump { margin-left:.3rem; }
.btn { display:inline-block; background:var(--accent); color:#1a0f08; font-weight:650; text-decoration:none;
  padding:.55rem 1.1rem; border-radius:999px; font-size:.9rem; white-space:nowrap; transition:filter .15s; }
.btn:hover { filter:brightness(1.08); }
.btn.ghost { background:transparent; color:var(--text); border:1px solid var(--border); font-weight:500; }
.btn.ghost:hover { border-color:var(--muted-2); }
/* Text-link booking route, for cards too narrow to carry a second pill */
.tlink { color:var(--accent); text-decoration:none; font-size:.8rem; font-weight:600; white-space:nowrap; }
.tlink:hover { text-decoration:underline; }
/* Fandango is the fallback route on the runner-ups: same shape, lower contrast,
   so the fee-free direct link leads without a second accent competing with it. */
.tlink.muted { color:var(--muted); font-weight:500; }
.tlink.muted:hover { color:var(--text); }
.book-set { margin-left:auto; display:inline-flex; align-items:center; gap:.6rem; }
.book-set .book { margin-left:0; }

/* Stats: two key numbers + a muted context line, no boxes */
.stats { margin-top:1.3rem; }
.stats .key { display:flex; gap:1.8rem; flex-wrap:wrap; font-variant-numeric:tabular-nums; }
.stats .key b { font-size:1.35rem; font-weight:680; margin-right:.4rem; }
.stats .key span { color:var(--muted); font-size:.85rem; }
.stats .ctx { color:var(--muted-2); font-size:.8rem; margin-top:.35rem; }
/* Sell-rate line: quiet facts, accent only where seats were lost or added */
.trend { color:var(--muted); font-size:.85rem; margin-top:.6rem; }
.trend b { color:var(--text); font-weight:650; }
.trend b.down { color:var(--accent); }
.trend b.fresh { color:var(--center); }

/* Sticky filters with sliding indicator */
.filters { position:sticky; top:0; z-index:20; background:color-mix(in srgb, var(--bg) 95%, transparent);
  backdrop-filter:blur(10px); border-bottom:1px solid var(--border); margin-top:1.6rem; padding:.7rem 0; }
.filters .row { display:flex; gap:1.4rem; flex-wrap:wrap; align-items:center; }
.fgroup { display:flex; align-items:center; gap:.5rem; }
.fgroup > label { font-size:.7rem; text-transform:uppercase; letter-spacing:.1em; color:var(--muted-2); }
.seg { position:relative; display:inline-flex; background:var(--surface); border:1px solid var(--border);
  border-radius:10px; padding:2px; }
.seg .ind { position:absolute; top:2px; left:0; height:calc(100% - 4px); background:var(--surface-2);
  box-shadow:inset 0 0 0 1px var(--border); border-radius:8px;
  transition:transform .22s cubic-bezier(.3,.9,.3,1), width .22s cubic-bezier(.3,.9,.3,1); }
.seg button { position:relative; background:none; border:0; color:var(--muted); font-size:.82rem;
  padding:.32rem .7rem; border-radius:8px; cursor:pointer; white-space:nowrap; transition:color .15s; }
.seg button[aria-pressed="true"] { color:var(--text); }
.count-note { margin-left:auto; color:var(--muted); font-size:.82rem; font-variant-numeric:tabular-nums; }

/* Seat tooltip */
#seat-tip { position:fixed; z-index:50; pointer-events:none; background:var(--surface-2); color:var(--text);
  border:1px solid var(--border); border-radius:8px; padding:.3rem .55rem; font-size:.8rem; font-weight:600;
  box-shadow:0 6px 20px rgba(0,0,0,.4); opacity:0; transition:opacity .08s; white-space:nowrap; }
#seat-tip.on { opacity:1; }
#seat-tip small { color:var(--muted); font-weight:400; }

/* Day groups: one container per day; the date lives on a raised header strip */
.day { margin-top:1.4rem; }
.day.empty { display:none; }
.daybox { background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
.dayhead { display:flex; align-items:baseline; gap:.6rem; padding:.55rem 1rem;
  background:var(--surface-2); border-bottom:1px solid var(--border); }
.dayhead h2 { font-size:.88rem; font-weight:650; display:flex; align-items:center; gap:.5rem; }
.dayhead h2 .wkd { width:.45rem; height:.45rem; border-radius:50%; background:var(--accent); flex:none; }
.dayhead .withpairs { font-weight:600; font-size:.78rem; color:var(--muted); margin-left:auto; }
.dayhead .n { color:var(--muted-2); font-weight:400; font-size:.78rem; }
.dayhead .n.solo { margin-left:auto; }

/* Showtime rows */
.show + .show { border-top:1px solid var(--border); }
.show.hide { display:none; }
.show-head { display:grid; grid-template-columns:8rem 1fr auto; align-items:center; gap:.8rem;
  padding:.8rem 1rem; cursor:pointer; user-select:none; }
.show-head:hover, .show-head:active { background:var(--surface-2); }
.show.static .show-head { cursor:default; }
.show.static .show-head:hover, .show.static .show-head:active { background:none; }
.time { display:flex; align-items:center; gap:.55rem; font-size:.98rem; font-weight:600; font-variant-numeric:tabular-nums; }
.show.static .time { color:var(--muted); }
.pico { display:inline-flex; color:var(--muted); flex:none; }
.pico svg { width:18px; height:18px; }
.qual { display:flex; align-items:center; gap:.55rem; min-width:0; flex-wrap:wrap; }

/* One tinted pill per row: colour = a bookable group exists, hue = its tier */
.tier { display:inline-flex; align-items:center; font-size:.78rem; font-weight:600; white-space:nowrap;
  color:var(--tc); border:1px solid color-mix(in srgb, var(--tc) 40%, transparent);
  background:color-mix(in srgb, var(--tc) 9%, transparent); border-radius:999px; padding:.15rem .62rem; }
.tier.flexible { --tc:var(--flexible); }
.tier.midBack { --tc:var(--midback); }
.tier.center { --tc:var(--center); }
.tier.none { border:0; background:none; padding:0; color:var(--muted-2); font-weight:400; font-size:.8rem; }
.worktag { display:inline-flex; align-items:center; font-size:.78rem; font-weight:600; white-space:nowrap;
  color:var(--muted); border:1px solid color-mix(in srgb, var(--muted-2) 45%, transparent);
  background:color-mix(in srgb, var(--muted-2) 10%, transparent); border-radius:999px; padding:.15rem .62rem; }

.right { display:flex; align-items:center; gap:.9rem; justify-self:end; }
/* Composition bar: coloured span = open seats worth booking, by tier;
   the dark track is everything else (front, accessible, taken). Colour is
   anchored right so the dark side visibly fills up as the show sells out. */
.bar { width:88px; height:6px; border-radius:3px; background:var(--taken); overflow:hidden; display:flex; justify-content:flex-end; }
.bar > i { display:block; height:100%; }
.bar .c { background:var(--center); }
.bar .m { background:var(--midback); }
.bar .f { background:var(--flexible); }
.pct { color:var(--muted-2); font-size:.72rem; font-variant-numeric:tabular-nums; width:3.4rem; text-align:right; }
.bar.hot + .pct { color:var(--accent); font-weight:600; }
.was { color:var(--muted-2); font-size:.68rem; font-variant-numeric:tabular-nums; white-space:nowrap; }
.was.down { color:var(--accent); }
.newtag { display:inline-flex; align-items:center; font-size:.68rem; font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; color:var(--center); border:1px solid color-mix(in srgb, var(--center) 40%, transparent);
  background:color-mix(in srgb, var(--center) 9%, transparent); border-radius:999px; padding:.1rem .5rem; }
.dayhead .opened { font-size:.66rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--center); border:1px solid color-mix(in srgb, var(--center) 40%, transparent);
  background:color-mix(in srgb, var(--center) 9%, transparent); border-radius:999px; padding:.08rem .5rem; }
.chev { color:var(--muted-2); transition:transform .18s; font-size:.8rem; }
.show.open .chev { transform:rotate(90deg); }

/* Jump-target pulse so the eye lands on the right row */
@keyframes pulse {
  0% { box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent);
       background:color-mix(in srgb, var(--accent) 9%, var(--surface)); }
  100% { box-shadow:none; background:none; }
}
.show.pulse { animation:pulse 1.4s ease-out; }

/* Expanded body — animated open via the 0fr -> 1fr grid trick */
.show-body { display:grid; grid-template-rows:0fr; transition:grid-template-rows .28s cubic-bezier(.3,.9,.3,1); }
.show.open .show-body { grid-template-rows:1fr; }
.show-body > div { overflow:hidden; }
.body-pad { padding:.1rem 1rem 1.1rem; }
.map-wrap { margin-top:.4rem; }
.screen { text-align:center; color:var(--muted-2); font-size:.68rem; letter-spacing:.35em;
  border-top:3px solid var(--accent); border-radius:50% 50% 0 0 / 100% 100% 0 0; width:66%; margin:.2rem auto .8rem; padding-top:.3rem; }
.map-view { position:relative; overflow:hidden; border-radius:10px; background:#100d18; touch-action:pan-y; }
.map-view.zoomed { touch-action:none; cursor:grab; }
.map-view.grabbing { cursor:grabbing; }
.map-view svg { width:100%; height:auto; display:block; transform-origin:0 0; will-change:transform; }
.map-view svg rect { stroke:rgba(0,0,0,.25); stroke-width:.6; }
.map-view svg rect[data-c]:hover { stroke:var(--text); stroke-width:2; }
.zoom-ctl { display:flex; align-items:center; gap:.4rem; margin-top:.55rem; flex-wrap:wrap; }
.zoom-ctl button { min-width:36px; height:34px; background:var(--surface-2); border:1px solid var(--border);
  color:var(--text); font:inherit; font-size:1rem; border-radius:8px; cursor:pointer; padding:0 .6rem; }
.zoom-ctl button:hover { border-color:var(--muted-2); }
.zoom-ctl button:active { background:var(--border); }
.zoom-hint { color:var(--muted-2); font-size:.72rem; margin-left:.3rem; }
.legend { display:flex; flex-wrap:wrap; gap:.85rem; font-size:.76rem; color:var(--muted); margin-top:.7rem; align-items:center; }
.legend i { width:.72rem; height:.72rem; border-radius:3px; display:inline-block; vertical-align:-2px; margin-right:.3rem; }
.map-foot { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:.7rem; color:var(--muted); font-size:.82rem; }
.map-foot .book { margin-left:auto; padding:.45rem .95rem; font-size:.85rem; }

.empty-state { text-align:center; color:var(--muted); padding:3rem 1rem; }

footer { color:var(--muted-2); font-size:.78rem; text-align:center; margin-top:3rem; padding:0 1rem; line-height:1.7; }
footer a { color:var(--muted); }

/* ---- Mobile ---- */
@media (max-width: 680px) {
  .poster-wrap { display:none; }
  .picks { grid-template-columns:1fr 1fr; }
  .pick.best { grid-column:1 / -1; }
}
@media (max-width: 560px) {
  .wrap { padding:0 .8rem; }
  .hero { padding:1.6rem 0 0; }
  .picks { grid-template-columns:1fr; }
  .pick.best .actions { flex-wrap:wrap; }
  .pick.best .actions .btn { width:100%; text-align:center; }
  .stats .key { gap:1.2rem; }
  /* Filters: each control on its own full-width row; buttons wrap and stay tappable.
     The sliding indicator only translates on X, so hide it once buttons can wrap
     and fall back to a static pressed style. Two stacked rows are too tall to pin —
     let the bar scroll away on phones instead of covering a third of the screen. */
  .filters { position:static; }
  .filters .row { gap:.7rem; }
  .fgroup { width:100%; flex-wrap:wrap; }
  .seg { width:100%; flex-wrap:wrap; }
  .seg .ind { display:none; }
  .seg button { flex:1 1 auto; min-height:40px; }
  .seg button[aria-pressed="true"] { background:var(--surface-2); box-shadow:inset 0 0 0 1px var(--border); }
  .count-note { margin-left:0; width:100%; text-align:right; }
  .show-head { grid-template-columns:7.2rem 1fr auto; gap:.6rem; padding:.8rem .85rem; }
  .pct, .was { display:none; }
  .bar { width:64px; }
  .map-foot .book-set { margin-left:0; width:100%; }
  .map-foot .book-set .btn { flex:1; text-align:center; padding:.7rem 1.1rem; }
  .legend { gap:.6rem .9rem; }
  .zoom-ctl button { min-width:46px; height:40px; }
  .zoom-hint { flex-basis:100%; margin-left:0; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior:auto; }
  .seg .ind, .show-body, .chev, .show.pulse { transition:none; animation:none; }
}
`;
}

export function clientScript() {
  // Colours + state labels are injected so the browser renderer matches the server.
  return `
const SEAT_COLORS = ${JSON.stringify(SEAT_COLORS)};
const SEAT_LABELS = ${JSON.stringify(SEAT_STATES.map(s => s.label))};
const OPEN_CODES = new Set([2,3,4,5]); // flexible, mid-back, center, accessible
const SHOWS = window.__SHOWS__ || {};
const state = { quality:'pairs', part:'all' };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function buildSvg(p) {
  const s = p.s;
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for (const t of s){ minX=Math.min(minX,t[0]); minY=Math.min(minY,t[1]); maxX=Math.max(maxX,t[0]+t[2]); maxY=Math.max(maxY,t[1]+t[3]); }
  const W=maxX-minX, H=maxY-minY, pad=W*0.015;
  let r='';
  for (const t of s){
    const [x,y,w,h,code,id]=t;
    const rx=(Math.min(w,h)*0.22).toFixed(1);
    r += '<rect data-id="'+id+'" data-c="'+code+'" x="'+(x-minX)+'" y="'+(y-minY)+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="'+SEAT_COLORS[code]+'"></rect>';
  }
  return '<svg viewBox="'+(-pad)+' '+(-pad)+' '+(W+2*pad)+' '+(H+2*pad)+'" role="img" aria-label="Seat map">'+r+'</svg>';
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

// Self-contained pan/zoom for one seat map: pinch (touch), ctrl/trackpad-wheel,
// drag to pan when zoomed, +/- buttons, double-tap to reset. No dependencies.
class PanZoom {
  constructor(view, svg) {
    this.v = view; this.s = svg; this.scale = 1; this.tx = 0; this.ty = 0;
    this.pts = new Map(); this.startDist = 0; this.startScale = 1; this.lastPan = null; this.down = null;
    const loc = e => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this.loc = loc;
    view.addEventListener('pointerdown', e => this.onDown(e));
    view.addEventListener('pointermove', e => this.onMove(e));
    const up = e => this.onUp(e);
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    // Stop the browser page-zoom on a two-finger pinch so we can zoom the map instead.
    view.addEventListener('touchmove', e => { if (e.touches.length === 2) e.preventDefault(); }, { passive: false });
    view.addEventListener('dblclick', e => { e.preventDefault(); this.reset(); });
    this.apply();
  }
  dims() { return { W: this.v.clientWidth, H: this.v.clientHeight }; }
  onDown(e) {
    this.v.setPointerCapture && this.v.setPointerCapture(e.pointerId);
    this.pts.set(e.pointerId, this.loc(e));
    if (this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      this.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.startScale = this.scale;
    } else {
      this.lastPan = this.loc(e);
      this.down = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, id: e.pointerId };
    }
  }
  onMove(e) {
    if (!this.pts.has(e.pointerId)) return;
    const p = this.loc(e); this.pts.set(e.pointerId, p);
    if (this.pts.size === 2) {
      hideTip();
      const [a, b] = [...this.pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.zoomTo(clampN(this.startScale * (dist / this.startDist), 1, 6), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    } else {
      if (this.down && Math.abs(e.clientX - this.down.x) + Math.abs(e.clientY - this.down.y) > 6) this.down.moved = true;
      if (this.scale > 1.01 && this.lastPan) {
        this.tx += p.x - this.lastPan.x; this.ty += p.y - this.lastPan.y;
        this.v.classList.add('grabbing'); hideTip(); this.apply();
      }
      this.lastPan = p;
    }
  }
  onUp(e) {
    const d = this.down;
    this.pts.delete(e.pointerId);
    this.v.classList.remove('grabbing');
    if (this.pts.size < 2) this.startDist = 0;
    if (this.pts.size === 0) this.lastPan = null;
    if (d && d.id === e.pointerId && !d.moved && (Date.now() - d.t) < 350) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const rect = el && el.closest && el.closest('rect[data-c]');
      if (rect) { showTip(rect, e.clientX, e.clientY); clearTimeout(this._t); this._t = setTimeout(hideTip, 1800); }
    }
    this.down = null;
  }
  onWheel(e) { if (!e.ctrlKey) return; e.preventDefault(); this.zoomTo(clampN(this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 6), this.loc(e)); }
  zoomBtn(f) { const { W, H } = this.dims(); this.zoomTo(clampN(this.scale * f, 1, 6), { x: W / 2, y: H / 2 }); }
  zoomTo(ns, f) { const r = ns / this.scale; this.tx = f.x - (f.x - this.tx) * r; this.ty = f.y - (f.y - this.ty) * r; this.scale = ns; this.apply(); }
  reset() { this.scale = 1; this.tx = 0; this.ty = 0; this.apply(); }
  apply() {
    const { W, H } = this.dims();
    this.tx = clampN(this.tx, W - W * this.scale, 0);
    this.ty = clampN(this.ty, H - H * this.scale, 0);
    this.s.style.transform = 'translate(' + this.tx + 'px,' + this.ty + 'px) scale(' + this.scale + ')';
    this.v.classList.toggle('zoomed', this.scale > 1.01);
  }
}

function renderMap(show) {
  const holder = show.querySelector('[data-map]');
  if (holder && !holder.dataset.rendered) {
    const p = SHOWS[show.dataset.id];
    if (p) {
      holder.innerHTML = buildSvg(p);
      holder.dataset.rendered = '1';
      holder._pz = new PanZoom(holder, holder.querySelector('svg'));
    }
  }
}

function toggle(show, forceOpen) {
  if (show.classList.contains('static')) return;
  if (forceOpen) show.classList.add('open');
  else show.classList.toggle('open');
  if (show.classList.contains('open')) renderMap(show);
}

function matches(show) {
  if (state.part !== 'all' && show.dataset.part !== state.part) return false;
  const pairs = +show.dataset.pairs, rank = +show.dataset.rank;
  switch (state.quality) {
    case 'all': return true;
    case 'pairs': return pairs > 0;
    case 'midBack': return pairs > 0 && rank <= 1;
    case 'center': return pairs > 0 && rank === 0;
  }
  return true;
}

// Animated count-note: confirms a filter change did something.
let countCur = null;
function setCount(visible) {
  const note = document.getElementById('count-note');
  if (!note) return;
  const set = n => note.textContent = n + ' showtime' + (n === 1 ? '' : 's') + ' shown';
  if (countCur === null || REDUCED) { countCur = visible; set(visible); return; }
  const from = countCur, start = performance.now();
  countCur = visible;
  (function tick(now) {
    const t = Math.min(1, (now - start) / 220);
    set(Math.round(from + (visible - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

function apply() {
  let visible = 0;
  document.querySelectorAll('.show').forEach(el => {
    const ok = matches(el);
    el.classList.toggle('hide', !ok);
    if (ok) visible++;
  });
  document.querySelectorAll('.day').forEach(day => {
    day.classList.toggle('empty', !day.querySelector('.show:not(.hide)'));
  });
  setCount(visible);
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = visible ? 'none' : 'block';
}

// Slide the segmented-control indicator under the pressed button.
function moveInd(seg) {
  const ind = seg.querySelector('.ind');
  const active = seg.querySelector('button[aria-pressed="true"]');
  if (!ind || !active) return;
  ind.style.width = active.offsetWidth + 'px';
  ind.style.transform = 'translateX(' + (active.offsetLeft - 2) + 'px)';
}
function moveAllInds() { document.querySelectorAll('.seg').forEach(moveInd); }

// Centre the opened card in the space below the sticky filter bar; if it is
// taller than that space, pin its head to the top instead so the map reads
// downward from the showtime.
function scrollToShow(show) {
  const bar = document.querySelector('.filters');
  // The bar only reserves space while it is sticky (it goes static on mobile).
  const barH = bar && getComputedStyle(bar).position === 'sticky'
    ? bar.getBoundingClientRect().height : 0;
  const avail = window.innerHeight - barH;
  const r = show.getBoundingClientRect();
  const slack = r.height < avail - 32 ? (avail - r.height) / 2 : 16;
  const top = r.top + window.scrollY - barH - slack;
  window.scrollTo({ top: Math.max(0, top), behavior: REDUCED ? 'auto' : 'smooth' });
}

// Jump from a top pick to its seat map, revealing it even if filtered out.
// The scroll must wait for the body to finish expanding: while it is still
// collapsed the document is shorter than the target, so the browser clamps the
// scroll and the card lands wherever the old page bottom was.
function jumpTo(id) {
  const show = document.querySelector('.show[data-id="'+id+'"]');
  if (!show) return;
  show.classList.remove('hide');
  const day = show.closest('.day'); if (day) day.classList.remove('empty');
  const wasOpen = show.classList.contains('open');
  toggle(show, true);
  show.classList.remove('pulse'); void show.offsetWidth; show.classList.add('pulse');
  const body = show.querySelector('.show-body');
  if (wasOpen || REDUCED || !body) {
    requestAnimationFrame(() => scrollToShow(show));
    return;
  }
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    body.removeEventListener('transitionend', onEnd);
    scrollToShow(show);
  };
  // Guard on target: children of the body run transitions of their own.
  const onEnd = (e) => { if (e.target === body) go(); };
  body.addEventListener('transitionend', onEnd);
  setTimeout(go, 400); // fallback if the transition is dropped or never fires
}

// Seat tooltip — shown on mouse hover (desktop) and on tap (touch, via PanZoom).
// Native SVG <title> is slow and we want it for every seat, so we roll our own.
const tip = document.createElement('div');
tip.id = 'seat-tip';
document.body.appendChild(tip);
function positionTip(x, y) {
  const pad = 14, r = tip.getBoundingClientRect();
  let nx = x + pad, ny = y + pad;
  if (nx + r.width > innerWidth) nx = x - r.width - pad;
  if (ny + r.height > innerHeight) ny = y - r.height - pad;
  tip.style.left = nx + 'px'; tip.style.top = ny + 'px';
}
function showTip(rect, x, y) {
  const code = +rect.dataset.c;
  const avail = OPEN_CODES.has(code) ? ' · open' : (code === 0 ? ' · taken' : '');
  tip.innerHTML = '<b>' + rect.dataset.id + '</b> <small>' + SEAT_LABELS[code] + avail + '</small>';
  tip.classList.add('on'); positionTip(x, y);
}
function hideTip() { tip.classList.remove('on'); }

document.addEventListener('pointerover', e => {
  if (e.pointerType && e.pointerType !== 'mouse') return; // touch handled by tap
  const rect = e.target.closest('rect[data-c]');
  if (rect) showTip(rect, e.clientX, e.clientY);
});
document.addEventListener('pointermove', e => {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  if (tip.classList.contains('on')) positionTip(e.clientX, e.clientY);
});
document.addEventListener('pointerout', e => {
  if (e.pointerType === 'mouse' && e.target.closest('rect[data-c]')) hideTip();
});

document.addEventListener('click', e => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) {
    const view = zoom.closest('.map-wrap').querySelector('.map-view');
    const pz = view && view._pz;
    if (pz) { const k = zoom.dataset.zoom; k === 'in' ? pz.zoomBtn(1.4) : k === 'out' ? pz.zoomBtn(1 / 1.4) : pz.reset(); }
    return;
  }
  const seg = e.target.closest('.seg button');
  if (seg) {
    const group = seg.closest('.seg');
    group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === seg));
    moveInd(group);
    state[group.dataset.filter] = seg.dataset.value;
    apply();
    return;
  }
  const jump = e.target.closest('[data-jump]');
  if (jump) { jumpTo(jump.dataset.jump); return; }
  const head = e.target.closest('.show-head');
  if (head && !e.target.closest('a')) toggle(head.closest('.show'));
});

addEventListener('resize', moveAllInds);
addEventListener('load', moveAllInds);
moveAllInds();
apply();
`;
}
