// The launcher's landing page — a three-step wizard, not a form:
//   1. What are we seeing?   (big poster carousel + search)
//   2. Which format?         (carousel gone; just the formats)
//   3. Where & who?          (formats gone; theatre + party + scout)
// Each choice replaces the last screen. A back/breadcrumb rail lets you revise.
// Server-rendered string, sharing the report's dark-cinema + one-orange language.
import { ACCENT } from './report/theme.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// The common Regal/Fandango format menu, always offered so a movie's own
// (often sparse) slate isn't the only choice.
const FORMATS = ['IMAX 70MM', 'IMAX', 'Dolby Cinema', 'RPX', 'ScreenX', '4DX', '3D', 'Standard'];

// info: { hasReport, lastScannedAt, canWatch } · profiles: recent scouts
// slate: [{ title, formats, poster? }] now playing · upcoming: coming soon
export function renderLanding(cfg, info, profiles = [], slate = [], upcoming = []) {
  const fd = cfg.fandango;
  const movie = fd.movieTitle || (fd.movieTitleMatch === 'Odyssey' ? 'The Odyssey' : fd.movieTitleMatch);
  const lastLine = info.lastScannedAt
    ? `Scanned ${esc(new Date(info.lastScannedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}` : '';
  const lastLabel = `${esc(movie)} · ${esc(fd.formatFilter)} · ${esc(cfg.theatreName)}`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Seat Scout</title>
<style>
:root {
  color-scheme: dark;
  --bg:#0a0910; --text:#f1eef7; --muted:#a49eb0; --muted-2:#7c7689; --accent:${ACCENT};
  --glass:rgba(255,255,255,.05); --glass-2:rgba(255,255,255,.08);
  --stroke:rgba(255,255,255,.10); --stroke-2:rgba(255,255,255,.16);
}
* { box-sizing:border-box; margin:0; }
body { background:var(--bg); color:var(--text); font:16px/1.55 system-ui,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased; min-height:100vh; overflow-x:hidden; }
.bg { position:fixed; inset:0 0 auto; height:2px; pointer-events:none; z-index:-1;
  background:color-mix(in srgb, var(--accent) 55%, transparent); opacity:.5; }

.wrap { position:relative; max-width:680px; margin:0 auto; padding:6vh 1.4rem 5rem; }
/* Brand: a cute little cinema-seat mascot (SVG) + wordmark lockup. */
.brand { display:inline-flex; align-items:center; gap:.5rem; }
.brand-mark { width:28px; height:28px; flex:none; color:var(--accent); display:inline-flex;
  filter:drop-shadow(0 3px 7px color-mix(in srgb,var(--accent) 50%, transparent)); }
.brand-mark svg { width:100%; height:100%; }
.brand-name { font-weight:750; font-size:1.05rem; letter-spacing:-.01em; color:var(--text); }

/* ---- Top bar: brand + reopen-report ---- */
.topbar { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; }
.topbar-right { display:flex; align-items:center; gap:.6rem; }
.scanned { font-size:.8rem; color:var(--muted-2); }
/* ---- Rail: back + breadcrumb of choices (empty on the first step) ---- */
.rail { display:flex; align-items:center; gap:.6rem; margin:1.4rem 0 0; min-height:2.1rem; flex-wrap:wrap; }
.rail:empty { display:none; }
#scout-form { margin-top:1.6rem; }
.back { display:inline-flex; align-items:center; justify-content:center; width:2.1rem; height:2.1rem; flex:none;
  border-radius:50%; border:1px solid var(--stroke); background:var(--glass); color:var(--text); cursor:pointer;
  font-size:1.1rem; transition:border-color .15s, background .15s; }
.back:hover { border-color:var(--stroke-2); background:var(--glass-2); }
.crumb { display:inline-flex; align-items:center; gap:.45rem; background:var(--glass); border:1px solid var(--stroke);
  border-radius:999px; padding:.35rem .8rem .35rem .4rem; font-size:.85rem; color:var(--text); cursor:pointer; }
.crumb:hover { border-color:var(--stroke-2); }
.crumb img { width:20px; height:28px; object-fit:cover; border-radius:5px; }
.crumb .dot { width:20px; height:20px; border-radius:50%; background:color-mix(in srgb,var(--accent) 30%, var(--glass-2)); }
.rail .spacer { margin-left:auto; }
.report-link { display:inline-flex; align-items:center; gap:.4rem; color:var(--muted); text-decoration:none;
  border:1px solid var(--stroke); border-radius:999px; padding:.35rem .8rem; background:var(--glass); font-size:.82rem; }
.report-link:hover { color:var(--text); border-color:var(--stroke-2); }

/* ---- Screens ---- */
.screen { display:none; animation:rise .4s cubic-bezier(.2,.7,.2,1) both; }
#scout-form[data-step="movie"] .s-movie,
#scout-form[data-step="format"] .s-format,
#scout-form[data-step="where"] .s-where { display:block; }
@keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
.q { font-size:1.75rem; font-weight:700; letter-spacing:-.015em; text-wrap:balance; margin-bottom:.35rem; }
.q-sub { color:var(--muted); margin-bottom:1.5rem; }
/* Contextual "open the past report for this movie" — shown on step 2 when the
   picked movie matches the last scan's movie. */
.lastreport { margin-top:1.9rem; display:flex; align-items:center; gap:.7rem; flex-wrap:wrap; }
.lastreport[hidden] { display:none; }
@media (prefers-reduced-motion: reduce) { .screen { animation:none; } }

/* ---- Big poster carousel: full-bleed, native scroll, gentle auto-drift (JS) ---- */
.reel { position:relative; width:100vw; margin-left:calc(50% - 50vw); overflow:hidden; cursor:grab;
  touch-action:pan-y;
  -webkit-mask-image:linear-gradient(90deg,#000 90%,transparent);
  mask-image:linear-gradient(90deg,#000 90%,transparent); }
.reel.grabbing { cursor:grabbing; }
.reel.grabbing .card { pointer-events:none; }   /* a drag shouldn't land as a click */
/* full-bleed: posters start at the screen's left edge; JS translates this via transform */
.track { display:flex; gap:1.1rem; width:max-content; user-select:none; padding:.5rem 1.4rem; will-change:transform; }
/* Search mode: a wide static grid that uses the page width (no transform) */
.reel.searching { overflow:visible; -webkit-mask-image:none; mask-image:none; }
.reel.searching .track { width:auto; transform:none; will-change:auto; display:grid;
  grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:1rem;
  padding:.5rem max(1.4rem, calc(50vw - 600px)); }

.card { position:relative; flex:none; height:clamp(300px, 50vh, 520px); aspect-ratio:2 / 3; width:auto;
  border-radius:18px; cursor:pointer; border:1px solid var(--stroke); background:var(--glass-2);
  overflow:hidden; text-align:left; transition:transform .2s, border-color .2s, box-shadow .2s; }
.reel.searching .card { height:auto; width:auto; }   /* grid cell sets width, aspect-ratio the height */
.card:hover { transform:translateY(-6px) scale(1.02); border-color:var(--stroke-2);
  box-shadow:0 18px 40px -14px rgba(0,0,0,.7); }
.card img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
/* Poster art already shows the title — only the artless fallback needs text. */
.card:not(.noart) .meta { display:none; }
.card .meta { position:absolute; inset:auto 0 0 0; padding:1rem .85rem .85rem;
  background:linear-gradient(to top, rgba(6,5,10,.94), rgba(6,5,10,.55) 55%, transparent);
  display:flex; flex-direction:column; gap:.15rem; }
.card.noart { display:flex; flex-direction:column;
  background:linear-gradient(155deg, color-mix(in srgb,var(--accent) 18%, var(--glass-2)) 0%, var(--glass) 60%); }
.card.noart .meta { background:transparent; position:static; margin-top:auto; }
.card .t { font-size:1.05rem; font-weight:650; line-height:1.2; text-shadow:0 1px 8px rgba(0,0,0,.7); }
.card .y { font-size:.8rem; color:var(--muted); }
.card:active { transform:scale(.98); }
.reel-empty { border:1px dashed var(--stroke); border-radius:14px; padding:1.6rem; text-align:center; color:var(--muted); }

/* Heading + search share one line; search stays on top so results never shove it. */
.movie-head { display:flex; align-items:center; justify-content:space-between; gap:1.4rem;
  margin-bottom:1.3rem; flex-wrap:wrap; }
.movie-head .q { margin:0; font-size:1.4rem; }
/* thin and long: fills the row beside the heading, slim height, pill shape */
.movie-head .searchbox { margin:0; flex:1 1 240px; max-width:440px; }
.searchbox { margin:0 0 1.6rem; position:relative; max-width:440px; }
.searchbox input { width:100%; background:var(--glass); color:var(--text); border:1px solid var(--stroke);
  border-radius:999px; padding:.5rem 1rem .5rem 2.3rem; font:inherit; }
.searchbox input:focus { outline:none; border-color:color-mix(in srgb,var(--accent) 55%, var(--stroke)); }
.searchbox svg { position:absolute; left:.95rem; top:50%; transform:translateY(-50%); width:16px; height:16px; color:var(--muted-2); }
/* App chrome isn't text — no selection, so a click can't drop a caret outside an
   input. Inputs stay fully selectable/typable (caret shows there, as expected). */
body { user-select:none; -webkit-user-select:none; }
input, textarea { user-select:text; -webkit-user-select:text; }

/* ---- Format tiles ---- */
.grouplbl { font-size:.7rem; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--muted-2);
  margin:1.4rem 0 .7rem; }
.grouplbl:first-child { margin-top:0; }
.tiles { display:flex; gap:.7rem; flex-wrap:wrap; }
.tiles button { background:var(--glass); border:1px solid var(--stroke); color:var(--text); font:inherit;
  font-size:1.05rem; font-weight:600; padding:1rem 1.6rem; border-radius:14px; cursor:pointer;
  transition:transform .12s, border-color .15s, background .15s; }
.tiles button:hover { border-color:var(--accent); transform:translateY(-2px); }
.tiles button:active { transform:scale(.97); }
.tiles.playing button { border-color:color-mix(in srgb,var(--accent) 45%, var(--stroke));
  background:color-mix(in srgb,var(--accent) 8%, var(--glass)); }

/* ---- Where & who ---- */
.slab { background:var(--glass); border:1px solid var(--stroke); border-radius:18px; overflow:hidden; }
.slab-row { display:flex; align-items:center; gap:1rem; padding:1rem 1.1rem; }
.slab-row + .slab-row { border-top:1px solid var(--stroke); }
.slab-row .k { font-size:.7rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted-2); flex:none; width:5rem; }
.slab-row .v { font-weight:600; }
.stepper { margin-left:auto; display:inline-flex; align-items:center; background:rgba(0,0,0,.25);
  border:1px solid var(--stroke); border-radius:12px; }
.stepper button { background:none; border:0; color:var(--text); font-size:1.2rem; width:42px; height:42px; cursor:pointer; }
.stepper button:hover { color:var(--accent); }
.stepper output { min-width:2.2rem; text-align:center; font-weight:650; font-size:1.05rem; font-variant-numeric:tabular-nums; }
.slab-row .chg { margin-left:auto; color:var(--muted); font-size:.85rem; cursor:pointer;
  text-decoration:underline; text-decoration-color:var(--stroke); text-underline-offset:3px; }
.slab-row .chg:hover { color:var(--text); }
details.theatre summary { list-style:none; cursor:pointer; }
details.theatre summary::-webkit-details-marker { display:none; }
details.theatre[open] .slab-row .chg { display:none; }
.theatre-body { padding:.3rem 1.1rem 1.1rem; display:grid; grid-template-columns:1fr 1fr; gap:.7rem; }
.theatre-body .wide { grid-column:1 / -1; }
.theatre-body label { display:block; }
.theatre-body input { width:100%; background:rgba(0,0,0,.25); color:var(--text); border:1px solid var(--stroke);
  border-radius:10px; padding:.6rem .75rem; font:inherit; }
.theatre-body input:focus { outline:none; border-color:color-mix(in srgb,var(--accent) 50%, var(--stroke)); }
.tlbl { font-size:.68rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted-2); margin-bottom:.35rem; display:block; }
.hint { grid-column:1 / -1; font-size:.76rem; color:var(--muted-2); line-height:1.5; }

/* ---- Theatre finder: location in, nearest theatres out ---- */
.finder-row { display:flex; gap:.6rem; }
.finder-row input { flex:1; }
.finder-row button { background:var(--glass-2); border:1px solid var(--stroke); color:var(--text); font:inherit;
  font-weight:600; font-size:.9rem; padding:.55rem 1.1rem; border-radius:10px; cursor:pointer; flex:none; }
.finder-row button:hover { border-color:var(--accent); }
.t-results { margin-top:.65rem; display:flex; flex-direction:column; gap:.45rem; font-size:.85rem; color:var(--muted); }
.t-results:empty { display:none; }
.t-row { display:flex; flex-direction:column; gap:.15rem; text-align:left; font:inherit; color:var(--text);
  background:rgba(0,0,0,.25); border:1px solid var(--stroke); border-radius:10px; padding:.6rem .75rem; cursor:pointer;
  transition:border-color .15s; }
.t-row:hover { border-color:var(--stroke-2); }
.t-row.sel { border-color:var(--accent); }
.t-top { display:flex; align-items:baseline; gap:.7rem; }
.t-nm { font-weight:600; }
.t-di { margin-left:auto; flex:none; color:var(--muted-2); font-size:.78rem; font-variant-numeric:tabular-nums; }
.t-sub { color:var(--muted-2); font-size:.78rem; }
.t-badge { align-self:flex-start; margin-top:.25rem; font-size:.72rem; font-weight:650; border-radius:999px;
  padding:.12rem .6rem; background:var(--glass-2); border:1px solid var(--stroke); color:var(--muted); }
.t-badge.hot { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 45%, var(--stroke));
  background:color-mix(in srgb,var(--accent) 10%, var(--glass)); }

.cta-row { display:flex; align-items:center; gap:1.2rem; margin-top:1.8rem; flex-wrap:wrap; }
.cta { background:var(--accent); color:#1a0f08; font:inherit; font-weight:700; font-size:1.08rem; border:0;
  border-radius:999px; padding:1rem 2.2rem; cursor:pointer; transition:filter .15s, transform .1s;
  box-shadow:0 12px 34px -12px color-mix(in srgb,var(--accent) 60%, transparent); }
.cta:hover { filter:brightness(1.07); }
.cta:active { transform:scale(.98); }
.ghost { background:none; border:0; color:var(--muted); font:inherit; font-size:.92rem; cursor:pointer; }
.ghost:hover { color:var(--text); }
.footnote { font-size:.78rem; color:var(--muted-2); margin-top:1.4rem; line-height:1.6; max-width:48ch; }

/* ---- Progress ---- */
#progress { display:none; margin-top:1.5rem; }
.running #scout-form { display:none; }
.running #progress { display:block; }
.status { display:flex; align-items:center; gap:.7rem; font-weight:650; font-size:1.1rem; }
.spinner { width:17px; height:17px; border-radius:50%; flex:none;
  border:2px solid var(--stroke); border-top-color:var(--accent); animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.elapsed { color:var(--muted-2); font-size:.85rem; font-variant-numeric:tabular-nums; margin-left:auto; }
.console { margin-top:1rem; background:rgba(0,0,0,.35); border:1px solid var(--stroke); border-radius:12px;
  padding:.9rem 1rem; font:12.5px/1.6 ui-monospace,Consolas,monospace; color:var(--muted);
  white-space:pre-wrap; word-break:break-word; max-height:44vh; overflow-y:auto; }
.done-actions { margin-top:1.2rem; display:none; }
.done .done-actions { display:block; }
.done .spinner { display:none; }
.err { color:#ff9a8a; }
:is(a,button,summary,input):focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:10px; }
@media (prefers-reduced-motion: reduce) { .spinner { animation:none; } }
@media (max-width:520px) { .q { font-size:1.45rem; } .card { width:170px; height:255px; } .theatre-body { grid-template-columns:1fr; } }
</style>
</head><body>
<div class="bg"></div>
<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none">
        <rect x="6" y="17" width="20" height="8" rx="3.5" fill="currentColor"/>
        <rect x="3.5" y="14.5" width="4.5" height="10.5" rx="2.2" fill="currentColor" opacity=".82"/>
        <rect x="24" y="14.5" width="4.5" height="10.5" rx="2.2" fill="currentColor" opacity=".82"/>
        <rect x="8" y="5" width="16" height="14" rx="5.5" fill="currentColor"/>
        <circle cx="13.4" cy="11" r="1.55" fill="#170d07"/>
        <circle cx="18.6" cy="11" r="1.55" fill="#170d07"/>
        <path d="M12.8 13.7 Q16 16.3 19.2 13.7" stroke="#170d07" stroke-width="1.5" stroke-linecap="round"/>
      </svg></span>
      <span class="brand-name">Seat Scout</span>
    </div>
  </div>
  <div class="rail" id="rail"></div>

  <form id="scout-form" data-step="movie">
    <input type="hidden" id="movie" name="movie" value="${esc(movie)}">
    <input type="hidden" id="format" name="format" value="${esc(fd.formatFilter)}">

    <!-- STEP 1 -->
    <section class="screen s-movie">
      <div class="movie-head">
        <div class="q">What do you want to see?</div>
        <div class="searchbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="search" type="text" placeholder="Search…" autocomplete="off" maxlength="100">
        </div>
      </div>
      <div class="reel" id="reel"><div class="track" id="track"></div></div>
    </section>

    <!-- STEP 2 -->
    <section class="screen s-format">
      <div class="q">How do you want to watch it?</div>
      <div class="q-sub" id="fmt-sub">Pick a format.</div>
      <div id="formats"></div>
      ${info.hasReport ? `<div class="lastreport" id="lastreport" hidden>
        <a class="report-link" href="/report">Open your last report for this movie ↗</a>
        ${lastLine ? `<span class="scanned">${lastLine}</span>` : ''}
      </div>` : ''}
    </section>

    <!-- STEP 3 -->
    <section class="screen s-where">
      <div class="q">Where are you seeing it?</div>
      <div class="q-sub">Confirm the theatre and party, then scout.</div>
      <div class="slab">
        <div class="slab-row">
          <span class="k">Party</span>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="Fewer people">−</button>
            <output id="party">${cfg.partySize}</output>
            <button type="button" data-step="1" aria-label="More people">+</button>
          </div>
        </div>
        <details class="theatre">
          <summary class="slab-row"><span class="k">Theatre</span><span class="v" id="t-summary">${esc(cfg.theatreName)}</span><span class="chg">change</span></summary>
          <div class="theatre-body">
            <div class="wide">
              <span class="tlbl">Find near a location</span>
              <div class="finder-row">
                <input type="text" id="t-near" placeholder="ZIP or City, ST" maxlength="60" autocomplete="postal-code">
                <button type="button" id="t-find">Search</button>
              </div>
              <div class="t-results" id="t-results"></div>
            </div>
            <label class="wide"><span class="tlbl">Name</span><input type="text" id="t-name" value="${esc(cfg.theatreName)}" maxlength="80"></label>
            <label><span class="tlbl">Fandango ID</span><input type="text" id="t-id" value="${esc(fd.theaterId)}" maxlength="10"></label>
            <label><span class="tlbl">Chain code</span><input type="text" id="t-chain" value="${esc(fd.chainCode)}" maxlength="8"></label>
            <label class="wide"><span class="tlbl">Fandango slug</span><input type="text" id="t-slug" value="${esc(fd.theaterSlug)}" maxlength="120"></label>
            <label class="wide"><span class="tlbl">Direct booking URL (optional — skips Fandango's fee)</span><input type="text" id="t-direct" value="${esc(cfg.directBooking?.url || '')}" maxlength="300" placeholder="https://www.regmovies.com/theatres/…"></label>
            <div class="hint">On the theatre's Fandango page URL: fandango.com/<b>&lt;slug&gt;</b>/theater-page — the ID is the trailing code (…-aaopk → AAOPK).</div>
          </div>
        </details>
      </div>
      <div class="cta-row">
        <button class="cta" type="submit">Scout seats →</button>
        ${info.canWatch ? '<button class="ghost" type="button" id="quick">Quick re-check</button>' : ''}
      </div>
      <p class="footnote">Scans a real Chrome window across the next several weeks — a minute or two. Click through any "verify you are human" prompt and it resumes.</p>
    </section>
  </form>

  <div id="progress">
    <div class="status"><div class="spinner"></div><span id="status-text">Starting…</span><span class="elapsed" id="elapsed"></span></div>
    <pre class="console" id="console"></pre>
    <div class="done-actions">
      <a class="cta" style="text-decoration:none; display:inline-block" href="/report">Open the report →</a>
      <button class="ghost" type="button" onclick="location.reload()">Back</button>
    </div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const form = $('#scout-form');
let MOVIES = ${JSON.stringify(slate).replace(/</g, '\\u003c')};
const UPCOMING = ${JSON.stringify(upcoming).replace(/</g, '\\u003c')};
const FORMATS = ${JSON.stringify(FORMATS)};
let party = ${cfg.partySize};

const stripYear = (t) => t.replace(/\\s*\\(\\d{4}\\)\\s*$/, '').trim();
const yearOf = (t) => (t.match(/\\((\\d{4})\\)\\s*$/) || [])[1] || '';
const norm = (t) => stripYear(t).toLowerCase();
const eqf = (a, b) => a.toLowerCase() === b.toLowerCase();
let selMovie = norm($('#movie').value);
const LAST_MOVIE = norm($('#movie').value);   // the movie the current report is for
const posterFor = (key) => (MOVIES.find(m => norm(m.title) === key) || {}).poster || null;

// ---- Carousel shared state: a transform-based INFINITE loop. Two identical card
// sets are rendered; we translate by a float position wrapped modulo one set's
// width, so it scrolls forever and never reverses. ----
let loopW = 0, reelPos = 0;
function measureLoop() {
  const reel = $('#reel'); if (reel.classList.contains('searching')) return;
  const kids = $('#track').children, N = MOVIES.length;
  loopW = (N > 0 && kids.length > N) ? kids[N].offsetLeft - kids[0].offsetLeft : 0;
}
const wrapPos = (p) => loopW > 0 ? ((p % loopW) + loopW) % loopW : Math.max(0, p);
function applyReel() {
  if (!$('#reel').classList.contains('searching')) $('#track').style.transform = 'translateX(' + (-reelPos) + 'px)';
}

// ---- Step machine ----
function goStep(s) {
  document.activeElement && document.activeElement.blur();   // no stray focus/caret carries over
  form.dataset.step = s;
  renderRail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderRail() {
  const rail = $('#rail'); const step = form.dataset.step;
  const movie = $('#movie').value, fmt = $('#format').value, poster = posterFor(selMovie);
  const parts = [];
  if (step !== 'movie') parts.push('<button type="button" class="back" id="rail-back" aria-label="Back">‹</button>');
  if (step === 'format' || step === 'where') {
    parts.push('<button type="button" class="crumb" data-goto="movie">' +
      (poster ? '<img alt="" src="' + poster.replace(/"/g, '&quot;') + '">' : '<span class="dot"></span>') +
      '<span></span></button>');
  }
  if (step === 'where') parts.push('<button type="button" class="crumb" data-goto="format"><span></span></button>');
  rail.innerHTML = parts.join('');
  // fill text safely
  const crumbs = rail.querySelectorAll('.crumb');
  if (step !== 'movie' && crumbs[0]) crumbs[0].querySelector('span:last-child').textContent = movie;
  if (step === 'where' && crumbs[1]) crumbs[1].querySelector('span').textContent = fmt;
  rail.querySelector('#rail-back')?.addEventListener('click', () => goStep(step === 'where' ? 'format' : 'movie'));
  rail.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => goStep(b.dataset.goto)));
}

// ---- Movie cards ----
function cardEl(m) {
  const bare = stripYear(m.title), yr = yearOf(m.title), key = norm(m.title);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card' + (m.poster ? '' : ' noart');
  b.dataset.key = key;
  b.setAttribute('aria-label', bare);
  b.innerHTML =
    (m.poster ? '<img loading="lazy" alt="" src="' + m.poster.replace(/"/g, '&quot;') + '">' : '') +
    '<span class="meta"><span class="t"></span>' + (yr ? '<span class="y">' + yr + '</span>' : '') + '</span>';
  b.querySelector('.t').textContent = bare;   // shown only on artless fallback cards
  b.addEventListener('click', () => selectMovie(m));
  return b;
}
function renderReel() {
  const track = $('#track'), reel = $('#reel');
  if (!MOVIES.length) {
    reel.innerHTML = '<div class="reel-empty">No slate cached yet — <button type="button" class="crumb" id="load-slate">load what\\'s playing</button>.</div>';
    $('#load-slate')?.addEventListener('click', loadSlate);
    return;
  }
  track.innerHTML = '';
  // Two identical sets so the transform loop can wrap seamlessly; the clone set
  // is marked so search can hide it (one result per movie).
  for (let pass = 0; pass < 2; pass++) for (const m of MOVIES) {
    const c = cardEl(m);
    if (pass === 1) { c.setAttribute('data-clone', ''); c.setAttribute('aria-hidden', 'true'); c.tabIndex = -1; }
    track.appendChild(c);
  }
  measureLoop();
}

function selectMovie(m) {
  selMovie = norm(m.title);
  $('#movie').value = stripYear(m.title);
  renderFormats(m.formats && m.formats.length ? m.formats : null);
  const lr = $('#lastreport'); if (lr) lr.hidden = selMovie !== LAST_MOVIE;  // report only for its own movie
  goStep('format');
}

// ---- Format tiles: movie's own formats first ("Showing now"), then the rest ----
function renderFormats(list) {
  const cur = $('#format').value;
  const known = (list || []).slice();
  const rest = FORMATS.filter(f => !known.some(k => eqf(k, f)));
  if (cur && !known.some(f => eqf(f, cur)) && !rest.some(f => eqf(f, cur))) rest.unshift(cur);
  const html = [];
  if (known.length) {
    html.push('<div class="grouplbl">Showing now for this movie</div>');
    html.push('<div class="tiles playing">' + known.map(fmtBtn).join('') + '</div>');
    if (rest.length) { html.push('<div class="grouplbl">Or scan another format</div>'); html.push('<div class="tiles">' + rest.map(fmtBtn).join('') + '</div>'); }
  } else {
    html.push('<div class="tiles">' + rest.map(fmtBtn).join('') + '</div>');
  }
  $('#formats').innerHTML = html.join('');
  $('#fmt-sub').textContent = known.length
    ? 'The top row is playing now; any format lets you scan anyway.'
    : 'No live format data for this pick — choose one to scan for.';
}
const fmtBtn = (f) => '<button type="button" data-fmt="' + f.replace(/"/g, '&quot;') + '">' + f + '</button>';
$('#formats').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]'); if (!b) return;
  $('#format').value = b.dataset.fmt;
  goStep('where');
});

// ---- Search: static grid of matches (clones hidden → one per movie) ----
function applySearch(q) {
  const searching = !!q;
  const track = $('#track');
  $('#reel').classList.toggle('searching', searching);
  if (searching) track.style.transform = '';   // let the grid lay out; drift resumes on clear
  track.querySelectorAll('.card').forEach(c => {
    const clone = c.hasAttribute('data-clone');
    const match = !q || c.dataset.key.includes(q);
    c.style.display = searching ? (!clone && match ? '' : 'none') : '';
  });
}
$('#search').addEventListener('input', (e) => applySearch(e.target.value.trim().toLowerCase()));
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim(); if (!q) return;
  const hit = MOVIES.find(m => norm(m.title).includes(q.toLowerCase()));
  selectMovie(hit || { title: q, formats: [] });
  e.target.value = ''; applySearch('');
});

// ---- Refresh slate from Fandango (only reachable when Chrome is up) ----
async function loadSlate() {
  try {
    const r = await fetch('/suggest');
    if (!r.ok) throw new Error((await r.json()).errors?.[0] || 'unavailable');
    const { movies } = await r.json();
    MOVIES = movies || []; renderReel();
  } catch (err) { $('#reel').innerHTML = '<div class="reel-empty">' + String(err.message || err) + '</div>'; }
}

// ---- Party ----
function setParty(n) { party = Math.min(8, Math.max(1, n)); $('#party').textContent = party; }
document.querySelectorAll('.stepper button').forEach(b =>
  b.addEventListener('click', () => setParty(party + Number(b.dataset.step))));

// ---- Theatre finder: ZIP or "City, ST" -> nearest theatres, click to fill.
// Rows are built via DOM APIs (textContent), so venue names can't inject markup. ----
async function findTheatres() {
  const q = $('#t-near').value.trim(); if (!q) return;
  const box = $('#t-results');
  box.textContent = 'Searching…';
  try {
    const p = new URLSearchParams({ near: q, movie: $('#movie').value, format: $('#format').value });
    const r = await fetch('/theatres?' + p);
    const j = await r.json();
    if (!r.ok) throw new Error((j.errors || [])[0] || 'Search failed.');
    renderTheatreResults(j.theatres || []);
  } catch (err) { box.textContent = String(err.message || err); }
}
function renderTheatreResults(list) {
  const box = $('#t-results');
  box.textContent = '';
  if (!list.length) { box.textContent = 'No ticketing theatres found there.'; return; }
  const movie = $('#movie').value, fmt = $('#format').value;
  for (const t of list) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 't-row';
    const top = document.createElement('span'); top.className = 't-top';
    const nm = document.createElement('span'); nm.className = 't-nm'; nm.textContent = t.name;
    const di = document.createElement('span'); di.className = 't-di';
    di.textContent = t.distance == null ? '' : t.distance.toFixed(1) + ' mi';
    top.append(nm, di);
    const sub = document.createElement('span'); sub.className = 't-sub'; sub.textContent = t.address || '';
    row.append(top, sub);
    // Badge is a hint from today's slate, not a filter — a theatre that only
    // plays the movie on other days shows unbadged, so don't hide anything.
    if (t.playsMovie || t.playsFormat) {
      const bd = document.createElement('span');
      bd.className = 't-badge' + (t.playsMovie && t.playsFormat ? ' hot' : '');
      bd.textContent = t.playsMovie ? 'Plays ' + movie + (t.playsFormat ? ' · ' + fmt : '') : fmt;
      row.append(bd);
    }
    row.addEventListener('click', () => pickTheatre(t, row));
    box.append(row);
  }
}
function pickTheatre(t, row) {
  $('#t-name').value = t.name;
  $('#t-id').value = t.theaterId;
  $('#t-chain').value = t.chainCode;
  $('#t-slug').value = t.theaterSlug;
  $('#t-direct').value = '';                // a direct link belongs to the old theatre
  $('#t-summary').textContent = t.name;
  document.querySelectorAll('.t-row.sel').forEach(x => x.classList.remove('sel'));
  row.classList.add('sel');
}
$('#t-find').addEventListener('click', findTheatres);
$('#t-near').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findTheatres(); }   // search, don't submit the form
});

// ---- Boot: always start on the movie step ----
renderReel();
if (UPCOMING.length) { /* reserved: coming-soon reel */ }
renderRail();
if (!MOVIES.length) fetch('/suggest').then(r => r.ok && r.json()).then(d => {
  if (d?.movies?.length) { MOVIES = d.movies; renderReel(); }
}).catch(() => {});

// ---- Carousel feel: endless auto-drift (wraps around, never reverses),
// click/touch-drag panning, and inertial FLING that also wraps. Hover slows the
// drift, never stops it. Position is the shared float reelPos, wrapped modulo one
// set's width and applied as a transform. ----
(function carousel() {
  const reel = $('#reel');
  const base = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.4;  // gentle drift
  const now = () => performance.now();
  let drifting = true, dragging = false, hovering = false, moved = false;
  let startX = 0, startPos = 0, prevX = 0, vel = 0, momentum = 0, lastMoveT = 0, resume;
  const scheduleDrift = () => { clearTimeout(resume); drifting = false; resume = setTimeout(() => { drifting = true; }, 700); };

  reel.addEventListener('pointerenter', () => { hovering = true; });
  reel.addEventListener('pointerleave', () => { hovering = false; });

  // Drag to pan (mouse/pen/touch). Pointer capture is taken only once a real drag
  // STARTS moving — capturing on pointerdown would swallow the click.
  reel.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    dragging = true; moved = false; momentum = 0; vel = 0;
    startX = prevX = e.clientX; startPos = reelPos;
    clearTimeout(resume);
  });
  reel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (!moved) {
      if (Math.abs(dx) <= 4) return;                     // below threshold — still a click
      moved = true; reel.classList.add('grabbing');
      try { reel.setPointerCapture(e.pointerId); } catch {}
    }
    reelPos = wrapPos(startPos - dx);
    applyReel();
    vel = vel * 0.6 + (-(e.clientX - prevX)) * 0.4;      // content moves opposite the finger
    prevX = e.clientX; lastMoveT = now();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false; reel.classList.remove('grabbing');
    try { reel.releasePointerCapture(e.pointerId); } catch {}
    // Fling if the pointer was still moving at release — amplified so a small
    // flick throws it a long way; capped so it can't rocket off.
    momentum = (moved && now() - lastMoveT < 110) ? Math.max(-150, Math.min(150, vel * 2)) : 0;
    if (!momentum) scheduleDrift(); else drifting = false;
  };
  reel.addEventListener('pointerup', end);
  reel.addEventListener('pointercancel', end);
  // A drag that moved shouldn't also fire a card click.
  reel.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  window.addEventListener('resize', measureLoop);

  (function frame() {
    if (!reel.classList.contains('searching')) {
      if (!loopW) measureLoop();
      if (dragging) { /* driven in pointermove */ }
      else if (Math.abs(momentum) >= 0.15) {             // inertial fling — wraps around
        reelPos = wrapPos(reelPos + momentum); momentum *= 0.955; applyReel();
        if (Math.abs(momentum) < 0.15) { momentum = 0; scheduleDrift(); }
      }
      else if (drifting && base) {                       // endless auto-drift
        reelPos = wrapPos(reelPos + base * (hovering ? 0.4 : 1)); applyReel();
      }
    }
    requestAnimationFrame(frame);
  })();
})();

// ---- Scout run + live progress ----
let startedAt = null, timer = null, polling = null;
function showProgress(label) {
  document.body.classList.add('running');
  $('#status-text').textContent = label;
  startedAt = Date.now();
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('#elapsed').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}
async function poll() {
  try {
    const r = await fetch('/status'); const j = await r.json();
    $('#console').textContent = j.log.join('\\n');
    $('#console').scrollTop = $('#console').scrollHeight;
    if (j.state === 'scanning') $('#status-text').textContent = 'Scanning showtimes and seat maps…';
    if (j.state === 'reporting') $('#status-text').textContent = 'Building your report…';
    if (j.state === 'done') {
      clearInterval(polling); clearInterval(timer);
      $('#progress').classList.add('done');
      $('#status-text').textContent = 'Done — opening your report…';
      document.querySelector('.done-actions').style.display = 'block';
      setTimeout(() => location.href = '/report', 900);
    }
    if (j.state === 'error') {
      clearInterval(polling); clearInterval(timer);
      $('#status-text').innerHTML = '<span class="err">Something went wrong</span>';
      document.querySelector('.done-actions').style.display = 'block';
    }
  } catch {}
}
async function scout(mode) {
  const body = {
    mode,
    movie: $('#movie').value,
    format: $('#format').value,
    partySize: party,
    theatre: { name: $('#t-name').value, theaterId: $('#t-id').value, theaterSlug: $('#t-slug').value, chainCode: $('#t-chain').value, directUrl: $('#t-direct').value },
  };
  const r = await fetch('/scout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { alert((await r.json()).errors?.join('\\n') || 'Could not start the scan.'); return; }
  showProgress(mode === 'watch' ? 'Re-checking your picks…' : 'Scanning showtimes and seat maps…');
  polling = setInterval(poll, 1500);
}
form.addEventListener('submit', (e) => { e.preventDefault(); scout('scan'); });
$('#quick')?.addEventListener('click', () => scout('watch'));
</script>
</body></html>`;
}
