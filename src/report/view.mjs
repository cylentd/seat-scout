// Pure view layer: each function takes a slice of the view model and returns an
// HTML string. No data access, no side effects — easy to reason about and extend.
import { SEAT_STATES } from './theme.mjs';
import { PART_LABELS } from './format.mjs';
import { styles, clientScript } from './assets.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Time-of-day glyphs (lucide outlines), inlined so they render in the muted text
// colour on every platform — deliberately not emoji, which ignore the palette.
const svgIcon = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const PART_ICONS = {
  morning:   svgIcon('<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>'),
  afternoon: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>'),
  evening:   svgIcon('<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>'),
  late:      svgIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7.2 7.2 0 0 0 9.8 9.8z"/>'),
};

const partIcon = (show) =>
  `<span class="pico" title="${PART_LABELS[show.part]}" aria-label="${PART_LABELS[show.part]}">${PART_ICONS[show.part] || ''}</span>`;

// Armchair (lucide), same inline treatment as the daypart glyphs: names the
// destination better than a bare down-arrow, and carries the label's meaning
// so the text can stay short.
// (legs omitted — at 15px the extra strokes read as noise, not furniture)
const SEAT_ICON = svgIcon('<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z"/>');

const workTag = (show) =>
  show.workHours ? '<span class="worktag" title="Starts during weekday work hours">work hrs</span>' : '';

// "pair" reads naturally for 2; anything else says "group of N".
const groupNoun = (partySize, plural) =>
  partySize === 2 ? (plural ? 'pairs' : 'pair') : (plural ? `groups of ${partySize}` : `group of ${partySize}`);

// One pill per row: the best available tier. A coloured pill always means "a
// bookable group exists here"; non-bookable states stay as plain muted text.
function tierPill(show, partySize) {
  if (show.status === 'soldout') return '<span class="tier none">Sold out</span>';
  const b = show.badges[0];
  if (b) {
    const plural = b.count === 1 ? groupNoun(partySize, false) : `separate ${groupNoun(partySize, true)}`;
    return `<span class="tier ${b.key}" title="${b.count} ${plural} of ${partySize} adjacent seats in the ${esc(b.label)} zone (non-overlapping)">${esc(b.label)} ×${b.count}</span>`;
  }
  if (!show.avail) return '<span class="tier none">No seat data</span>';
  return `<span class="tier none">${show.avail.openStd ? 'Singles / front only' : 'Sold out'}</span>`;
}

function legend() {
  const items = SEAT_STATES.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  return `<div class="legend">${items}</div>`;
}

// Both booking routes are named by their brand and nothing else — "Regal" beside
// "Fandango" reads as a choice of vendor without needing a verb, and avoids a
// monogram the reader has to decode. Tooltips carry the fee difference.
const fandangoLink = (url, cls) =>
  `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="Book this exact showtime on Fandango — adds a per-ticket convenience fee">Fandango ↗</a>`;

function bookLinks(meta, fandangoUrl, primaryClass, secondaryClass = 'btn ghost') {
  if (!meta.directBooking) return fandangoLink(fandangoUrl, primaryClass);
  return `<a class="${primaryClass}" href="${esc(meta.directBooking.url)}" target="_blank" rel="noopener" title="No convenience fee with the free Regal Crown Club">${esc(meta.directBooking.label)} ↗</a>${fandangoLink(fandangoUrl, secondaryClass)}`;
}

function showCard(show, meta) {
  const partySize = meta.partySize;
  const a = show.avail;
  const usable = a ? a.usable : 0;
  // Urgent once fewer than three bookable groups could still fit.
  const hot = a ? usable < partySize * 3 : false;
  // Composition bar: coloured segments = open seats you'd actually book (by
  // tier, matching the seat-map colours); front/accessible/taken stay in the
  // dark track. The label counts usable seats, not raw fullness.
  const seg = (n, cls) => n ? `<i class="${cls}" style="width:${(100 * n / a.total).toFixed(1)}%"></i>` : '';
  const barTitle = a
    ? `${usable} open outside the front rows (${a.open.center} center, ${a.open.midBack} mid-back, ${a.open.flexible} flexible) · ${a.open.front} front · ${a.accessible} accessible · ${a.pctFull}% of all seats sold`
    : '';
  // Sell-rate context: "was N" vs the trend baseline (accent when seats were
  // lost); brand-new shows get a New tag instead — new IS their history.
  const t = show.trend;
  const was = t && !t.isNew && t.wasUsable != null && t.usableDelta !== 0
    ? `<span class="was${t.usableDelta < 0 ? ' down' : ''}" title="${t.wasUsable} usable ${esc(meta.trendBaseline || 'at the last scan')}">was ${t.wasUsable}</span>`
    : '';
  const newTag = t?.isNew && show.status !== 'soldout'
    ? '<span class="newtag" title="First seen this scan — new dates have the best seat selection">New</span>' : '';
  const right = show.hasMap ? `
      <div class="bar${hot ? ' hot' : ''}" title="${barTitle}">${seg(a.open.center, 'c')}${seg(a.open.midBack, 'm')}${seg(a.open.flexible, 'f')}</div>
      <span class="pct">${usable} left</span>${was}
      <span class="chev">▶</span>` : '';
  const body = show.hasMap ? `
  <div class="show-body"><div><div class="body-pad">
    <div class="map-wrap">
      <div class="screen">SCREEN</div>
      <div class="map-view" data-map></div>
      <div class="zoom-ctl">
        <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" data-zoom="reset">Reset</button>
        <span class="zoom-hint">pinch or +/− to zoom · drag to pan · tap a seat for its number</span>
      </div>
    </div>
    ${legend()}
    <div class="map-foot">
      <span>${usable} usable · ${a.open.front} front · ${a.accessible} accessible · ${a.taken} taken · ${a.pctFull}% full</span>
      <span class="book-set">${bookLinks(meta, show.bookingUrl, 'btn ghost book')}</span>
    </div>
  </div></div></div>` : '';
  return `
<div class="show${show.hasMap ? '' : ' static'}" data-id="${esc(show.id)}" data-part="${show.part}" data-pairs="${show.pairs.total}" data-rank="${show.tierRank}" data-sold="${show.status === 'soldout' ? 1 : 0}">
  <div class="show-head">
    <span class="time">${partIcon(show)}${show.timeLabel}</span>
    <span class="qual">${tierPill(show, partySize)}${workTag(show)}${newTag}</span>
    <span class="right">${right}</span>
  </div>
  ${body}
</div>`;
}

function dayGroup(day, meta) {
  const partySize = meta.partySize;
  const weekend = /^(Sat|Sun)/.test(day.dayLabel);
  const n = day.shows.length;
  const noun = groupNoun(partySize, true);
  const headMeta = day.withPairs
    ? `<span class="withpairs">${day.withPairs} with ${noun}</span><span class="n">· ${n} showtime${n === 1 ? '' : 's'}</span>`
    : `<span class="n solo">${n} showtime${n === 1 ? '' : 's'} · no ${noun}</span>`;
  return `
<section class="day">
  <div class="daybox">
    <div class="dayhead"><h2>${weekend ? '<i class="wkd" title="Weekend"></i>' : ''}${esc(day.dayLabel)}${day.justOpened ? '<span class="opened" title="Every showtime on this date is new since the last scan">just opened</span>' : ''}</h2>${headMeta}</div>
    ${day.shows.map(s => showCard(s, meta)).join('')}
  </div>
</section>`;
}

function pairBreakdown(show) {
  return show.badges.map(b => `${b.count} ${b.label.toLowerCase()}`).join(', ');
}

// The #1 pick is the hero moment (CTA and all); #2/#3 are visibly smaller siblings.
function pickCard(meta, show, i) {
  // The showtime is a heading, not a link: every card now carries named booking
  // links, so linking the time too was a second, unlabelled route to the same page.
  const when = `<div class="when">${show.dayLabel} · ${show.timeLabel}</div>`;
  const detail = `${pairBreakdown(show)} ${groupNoun(meta.partySize, show.pairs.total !== 1)}`;
  const jump = `<button class="mapjump" data-jump="${esc(show.id)}" title="Jump to this showtime's seat map">${SEAT_ICON}Seat map</button>`;
  if (i === 0) return `
      <div class="pick best">
        <div class="rank">#1 · Top pick for ${meta.partySize} together</div>
        ${when}
        <div class="detail">${detail} · ${PART_LABELS[show.part].toLowerCase()}${show.workHours ? ' · work hrs' : ''}</div>
        <div class="actions">
          ${bookLinks(meta, show.bookingUrl, 'btn')}
          ${jump}
        </div>
      </div>`;
  // Runner-ups are too narrow for pills, so the same two routes appear as text links.
  return `
      <div class="pick">
        <div class="rank">#${i + 1}</div>
        ${when}
        <div class="detail">${detail}${show.workHours ? ' · work hrs' : ''}</div>
        <div class="booklinks">${bookLinks(meta, show.bookingUrl, 'tlink', 'tlink muted')}</div>
        ${jump}
      </div>`;
}

// One factual sentence on sell rate, decomposed so demand (sold out of groups),
// the calendar (dates passing), and supply (new showtimes) each speak for
// themselves — an aggregate would invert exactly when new dates open.
function trendLine(model) {
  const t = model.trend;
  if (!t) return '';
  const { partySize } = model.meta;
  const s = t.summary;
  const noun = groupNoun(partySize, true);
  const bits = [];
  if (s.hadPairs) {
    const lost = s.lostPairs
      ? `<b class="down">${s.lostPairs} of ${s.hadPairs}</b> showtimes sold out of ${noun}`
      : `all <b>${s.hadPairs}</b> showtimes with ${noun} still have them`;
    bits.push(s.lostPairs ? `${lost} · <b>${s.retained}</b> remain` : lost);
  }
  if (s.passed) bits.push(`${s.passed} date${s.passed === 1 ? '' : 's'} passed`);
  if (s.newShows) bits.push(`<b class="fresh">+${s.newShows}</b> new showtime${s.newShows === 1 ? '' : 's'} opened${s.newWithPairs ? ` (${s.newWithPairs} with ${noun})` : ''}`);
  if (!bits.length) return '';
  return `<div class="trend">Since ${esc(t.baselineLabel)}: ${bits.join(' · ')}</div>`;
}

function hero(model) {
  const { meta, stats, topPicks } = model;
  const poster = meta.poster
    ? `<div class="poster-wrap"><img src="${meta.poster}" alt="${esc(meta.movie)} poster"></div>` : '';
  const picks = topPicks.length
    ? `<div class="picks">${topPicks.map((s, i) => pickCard(meta, s, i)).join('')}</div>`
    : `<div class="no-picks">No showtime currently has ${meta.partySize} good seats together — check back after the next scan.</div>`;
  return `
<header class="hero">
  <div class="hero-top">
    ${poster}
    <div class="hero-main">
      <h1>${esc(meta.movie)} · ${esc(meta.format)}</h1>
      <div class="sub">${esc(meta.theatre)} — showtimes with ${meta.partySize} adjacent seats outside the front rows</div>
      ${picks}
    </div>
  </div>
  <div class="stats">
    <div class="key">
      <div><b>${stats.withPairs}</b><span>showtimes with ${meta.partySize} seats together</span></div>
      <div><b>${stats.doablePairs}</b><span>on weekends or after 5 PM</span></div>
    </div>
    <div class="ctx">${stats.available} of ${stats.total} showtimes still purchasable · ${stats.soldOut} fully sold out · ranked by doable times first, then seat quality</div>
    ${trendLine(model)}
  </div>
</header>`;
}

function filterBar(partySize) {
  const seg = (filter, opts) => `
    <div class="seg" data-filter="${filter}">
      <div class="ind"></div>
      ${opts.map((o, i) => `<button data-value="${o.v}" aria-pressed="${i === 0}">${o.l}</button>`).join('')}
    </div>`;
  return `
<div class="filters"><div class="wrap"><div class="row">
  <div class="fgroup"><label>Seats</label>${seg('quality', [
    { v: 'pairs', l: partySize === 2 ? 'Any pair' : 'Any group' }, { v: 'midBack', l: 'Mid-back+' }, { v: 'center', l: 'Center' }, { v: 'all', l: 'Show all' },
  ])}</div>
  <div class="fgroup"><label>When</label>${seg('part', [
    { v: 'all', l: 'Any' }, { v: 'morning', l: 'Morning' }, { v: 'afternoon', l: 'Afternoon' }, { v: 'evening', l: 'Evening' }, { v: 'late', l: 'Late' },
  ])}</div>
  <span class="count-note" id="count-note"></span>
</div></div></div>`;
}

function footer(meta) {
  const when = new Date(meta.scannedAt).toLocaleString('en-US');
  return `<footer>
    Scanned ${esc(when)} via ${esc(meta.source)} · one polite, human-paced session.<br>
    Seat tiers are estimated from seat geometry; "flexible" = a ${groupNoun(meta.partySize, false)} outside the front rows but off the center sweet spot.<br>
    Counts are separate, non-overlapping ${groupNoun(meta.partySize, true)} — a run of ${meta.partySize * 2} open seats counts as 2, so counts reflect what ${esc(String(meta.partySize))} people can actually book without stranding singles.<br>
    Rankings put doable times (weekends &amp; after 5 PM) ahead of weekday work-hours shows. Verify the exact seats before buying.${meta.directBooking ? '<br>Booking direct skips Fandango’s per-ticket convenience fee (free with Regal Crown Club); the Fandango link jumps to the exact showtime.' : ''}
  </footer>`;
}

export function renderPage(model) {
  const { meta } = model;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Seat Scout — ${esc(meta.movie)} · ${esc(meta.format)}</title>
<style>${styles()}</style>
</head><body>
<div class="wrap">${hero(model)}</div>
${filterBar(meta.partySize)}
<div class="wrap">
  ${model.days.map(d => dayGroup(d, meta)).join('')}
  <div class="empty-state" id="empty-state" style="display:none">No showtimes match these filters.</div>
</div>
${footer(meta)}
<script>window.__SHOWS__=${JSON.stringify(model.seatPayloads)};</script>
<script>${clientScript()}</script>
</body></html>`;
}
