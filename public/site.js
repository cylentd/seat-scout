// Seat Scout — public site. Reads signals.json (counts only, never seat maps) and
// renders two views from one page: the landing (movies → theatres, nearest-first
// when the visitor shares a location) and a theatre view (ticket-stub top picks,
// filters, day-grouped showtimes with booking links). No build step, no deps.
(() => {
  'use strict';

  const TZ = 'America/Los_Angeles';
  const TIER = {
    center:   { cls: 'gold',   label: 'Center',   rank: 0 },
    midBack:  { cls: 'silver', label: 'Mid-back', rank: 1 },
    flexible: { cls: 'bronze', label: 'Edge',     rank: 2 },
  };
  const CHAIN = { REGL: 'Regal', AMC: 'AMC', CNMK: 'Cinemark' };
  const chainName = (c) => c ? (CHAIN[c] || c) : null;
  const ICON = {
    morning:   '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    afternoon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>',
    evening:   '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    late:      '<path d="M21 12.8A9 9 0 1 1 11.2 3a7.2 7.2 0 0 0 9.8 9.8z"/>',
    pin:       '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    star:      '<path d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7L12 17.4 5.8 21l1.6-7L2 9.3l7.1-.7L12 2z"/>',
    arrow:     '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    back:      '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    ext:       '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  };
  const svg = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICON[name]}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);

  // ----- state -----
  const state = {
    data: null,
    loc: null,           // { lat, lng } once the visitor opts in
    locErr: null,
    sort: 'best',        // 'best' | 'nearest'
    metro: 'all',        // 'all' | 'bay' | 'la'
    when: 'any',         // theatre view: 'any' | 'off' (evenings + weekends)
    seats: 'any',        // theatre view: 'any' | 'mid' | 'center'
    party: 'any',        // 'any' (one seat is enough) | 'pair' (two together)
  };
  try { const p = localStorage.getItem('seatscout-party'); if (p === 'pair') state.party = 'pair'; } catch { /* ignore */ }
  try {
    const saved = JSON.parse(sessionStorage.getItem('seatscout-loc') || 'null');
    if (saved && typeof saved.lat === 'number') { state.loc = saved; state.sort = 'nearest'; }
  } catch { /* storage unavailable */ }

  // ----- time helpers (all theatre-local, Pacific) -----
  const nowParts = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { dateISO: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  };
  const minutesOf = (timeLabel) => {
    const m = /^(\d+):(\d+)\s*(AM|PM)$/i.exec(timeLabel || '');
    if (!m) return 0;
    let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
    return h * 60 + Number(m[2]);
  };
  const splitTime = (timeLabel) => { const m = /^(\d+:\d+)\s*(AM|PM)$/i.exec(timeLabel || ''); return m ? [m[1], m[2].toUpperCase()] : [timeLabel, '']; };
  const isPast = (show, now) => show.dateISO < now.dateISO || (show.dateISO === now.dateISO && minutesOf(show.timeLabel) < now.minutes);
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const isWeekend = (iso) => { const d = dow(iso); return d === 0 || d === 6; };
  const shortDate = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
  const ago = (isoStamp) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(isoStamp).getTime()) / 60000));
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  const stampPT = (isoStamp) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(isoStamp));

  // ----- geometry -----
  const milesBetween = (a, b) => {
    const R = 3958.8, toR = (d) => d * Math.PI / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const fmtMiles = (mi) => mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;

  // ----- seat quality, neutral about party size -----
  // party 'any': the best tier with at least one open seat (solo-friendly).
  // party 'pair': the best tier with an adjacent pair (the scanner's `tier`).
  const ORDER = ['center', 'midBack', 'flexible'];
  const bestOpenTier = (s) => s.open ? ORDER.find(k => s.open[k] > 0) || null : null;
  const seatTier = (s) => state.party === 'pair' ? s.tier : bestOpenTier(s);
  const seatCount = (s) => { const k = seatTier(s); return k ? (state.party === 'pair' ? s.pairs[k] : s.open[k]) : 0; };
  const hasSeat = (s) => s.status === 'available' && !!seatTier(s);
  const tierRank = (s) => { const k = seatTier(s); return k && TIER[k] ? TIER[k].rank : 9; };
  // Best bets: off-hours first, best tier, then a sane time of day (an evening
  // beats a 7 AM even on a Saturday), then the most seats, then soonest.
  const PART_PREF = { evening: 0, afternoon: 1, late: 2, morning: 3 };
  const partRank = (s) => PART_PREF[s.part] ?? 4;
  const rankShows = (shows) => [...shows].sort((a, b) =>
    (a.workHours - b.workHours) || (tierRank(a) - tierRank(b)) || (partRank(a) - partRank(b)) || (seatCount(b) - seatCount(a)) ||
    a.dateISO.localeCompare(b.dateISO) || (minutesOf(a.timeLabel) - minutesOf(b.timeLabel)));

  const theatreScore = (shows) => {
    const live = shows.filter(hasSeat);
    return live.filter(s => !s.workHours && seatTier(s) === 'center').length * 1000 + live.length;
  };

  const dayState = (shows) => {
    if (!shows.length) return 'dark';
    const live = shows.filter(s => s.status === 'available');
    if (!live.length) return 'sold';
    let best = 9;
    for (const s of live) best = Math.min(best, tierRank(s));
    return best === 0 ? 'gold' : best === 1 ? 'silver' : best === 2 ? 'bronze' : 'none';
  };
  const STATE_WORD = { gold: 'Center', silver: 'Mid-back', bronze: 'Edge', none: 'Front rows only', sold: 'Sold out', dark: 'No show' };

  const pill = (show) => {
    if (show.status === 'soldout') return `<span class="pill sold">Sold out</span>`;
    if (show.status !== 'available') return `<span class="pill none">Unavailable</span>`;
    const k = seatTier(show), t = k && TIER[k];
    if (!t) return `<span class="pill none">${state.party === 'pair' ? 'No two together' : 'Front rows only'}</span>`;
    const n = seatCount(show);
    return `<span class="pill ${t.cls}">${t.label} · ${n} ${state.party === 'pair' ? (n === 1 ? 'pair' : 'pairs') : 'open'}</span>`;
  };

  // ----- data prep -----
  function prepare(data) {
    const now = nowParts();
    for (const m of data.movies) {
      for (const t of m.theatres) {
        t.shows = (t.shows || []).filter(s => !isPast(s, now));
        t.live = t.shows.filter(s => s.status === 'available');
        t.byDate = new Map();
        for (const s of t.shows) { if (!t.byDate.has(s.dateISO)) t.byDate.set(s.dateISO, []); t.byDate.get(s.dateISO).push(s); }
      }
      const dates = m.theatres.flatMap(t => t.shows.map(s => s.dateISO));
      m.lastDate = dates.length ? dates.reduce((a, b) => a > b ? a : b) : now.dateISO;
    }
    data.now = now;
    return data;
  }
  // Party-size dependent derivations, recomputed on every render.
  function derive(data) {
    for (const m of data.movies) for (const t of m.theatres) {
      t.score = theatreScore(t.shows);
      t.best = rankShows(t.live.filter(hasSeat))[0] || null;
    }
  }

  // ----- landing -----
  function renderLanding(data) {
    const now = data.now;
    const theatresAll = data.movies.flatMap(m => m.theatres);
    const showCount = theatresAll.reduce((n, t) => n + t.live.length, 0);
    const openSeats = theatresAll.reduce((n, t) => n + t.live.reduce((k, s) => k + (s.open ? s.open.center + s.open.midBack + s.open.flexible : 0), 0), 0);
    const centerShows = theatresAll.reduce((n, t) => n + t.live.filter(s => s.open && s.open.center > 0).length, 0);
    const pairShows = theatresAll.reduce((n, t) => n + t.live.filter(s => s.pairs.total > 0).length, 0);
    const soldCount = theatresAll.reduce((n, t) => n + t.shows.filter(s => s.status === 'soldout').length, 0);
    const houses = theatresAll.filter(t => t.onSale).length;
    const titles = data.movies.map(m => m.title.toUpperCase()).join(' · ');

    const tick = [
      `Now counting: ${titles}`,
      `${showCount} showtimes ahead`,
      `${openSeats.toLocaleString()} good seats open`,
      `${centerShows} shows with center seats`,
      `${pairShows} shows seat two together`,
      soldCount ? `${soldCount} sold out` : 'Nothing sold out yet',
      `${houses} houses, SF to Irvine`,
      `Counts from ${stampPT(data.generatedAt)} PT`,
    ].map(s => `<span>${esc(s)}</span>`).join('');

    const marquee = `
      <section class="marquee" aria-label="Seat Scout">
        <h1><span class="line">Good seats.</span><span class="line">Still open.</span><span class="line">One or two.</span></h1>
        <div class="sub">
          <p>Every IMAX 70mm house from San Francisco to Irvine, checked twice a day for <strong>open seats in the rows worth sitting in</strong>, solo or side by side. Skip the seat-map scavenger hunt. Pick a show, book it where you always do.</p>
          <div class="cta">
            <a class="btn gold" href="#theatres">See what's open ${svg('arrow')}</a>
          </div>
        </div>
        <div class="ticker" aria-hidden="true"><div class="track">${tick}${tick}</div></div>
      </section>`;

    const locBtn = state.loc && !state.loc.approx
      ? `<button type="button" data-sort="nearest" aria-pressed="${state.sort === 'nearest'}">${svg('pin')} Nearest</button>`
      : state.loc
        ? `<button type="button" data-sort="nearest" aria-pressed="${state.sort === 'nearest'}" title="Roughly ${esc(state.loc.city || 'your area')}, from your network. Click again for a precise fix.">${svg('pin')} Near ${esc(state.loc.city || 'you')}</button>`
        : `<button type="button" data-sort="nearest" aria-pressed="false">${svg('pin')} Nearest to me</button>`;
    const controls = `
      <div class="controls" id="theatres" role="toolbar" aria-label="Sort and filter theatres">
        ${partyControl()}
        <div class="ctl-group"><span class="ctl-label">Sort</span>
          <div class="seg">
            <button type="button" data-sort="best" aria-pressed="${state.sort === 'best'}">${svg('star')} Best seats</button>
            ${locBtn}
          </div>
        </div>
        <div class="ctl-group"><span class="ctl-label">Area</span>
          <div class="seg">
            <button type="button" data-metro="all" aria-pressed="${state.metro === 'all'}">All</button>
            <button type="button" data-metro="bay" aria-pressed="${state.metro === 'bay'}">Bay Area</button>
            <button type="button" data-metro="la" aria-pressed="${state.metro === 'la'}">Los Angeles</button>
          </div>
        </div>
        <span class="legend" title="Where the best open pair sits"><span class="g"><i></i>Center</span><span class="s"><i></i>Mid-back</span><span class="b"><i></i>Edge</span></span>
        ${state.locErr ? `<span class="ctl-note err">${esc(state.locErr)}</span>` : ''}
      </div>`;

    let cardIndex = 0;
    const movies = data.movies.map(m => {
      let ths = m.theatres.filter(t => state.metro === 'all' || t.metro === state.metro);
      for (const t of ths) t.miles = (state.loc && typeof t.lat === 'number') ? milesBetween(state.loc, t) : null;
      ths = ths.sort((a, b) => state.sort === 'nearest' && state.loc
        ? ((a.miles ?? 1e9) - (b.miles ?? 1e9)) || (b.score - a.score)
        : (b.score - a.score) || ((a.miles ?? 1e9) - (b.miles ?? 1e9)));

      // Shared date axis so every strip lines up frame for frame.
      const days = [];
      for (let d = now.dateISO; d <= m.lastDate && days.length < 31; d = addDays(d, 1)) days.push(d);

      const cards = ths.map(t => theatreCard(t, days, cardIndex++)).join('');
      const onSale = m.theatres.some(t => t.onSale);
      return `
        <section class="movie">
          <div class="movie-head">
            <span class="eyebrow">Now showing</span>
            <h2>${esc(m.title)}</h2>
            ${m.formats.map(f => `<span class="badge">${esc(f)}</span>`).join('')}
            <span class="span">${ths.length} theatre${ths.length === 1 ? '' : 's'}${onSale ? ` · through ${esc(shortDate(m.lastDate))}` : ' · not on sale yet'}</span>
          </div>
          <div class="theatres">${cards || `<p class="notice">Nothing in this area plays ${esc(m.title)} in ${esc(m.formats.join(' / '))}. Widen the map.</p>`}</div>
        </section>`;
    }).join('');

    return marquee + controls + movies;
  }

  const partyControl = () => `
        <div class="ctl-group"><span class="ctl-label">Going</span>
          <div class="seg">
            <button type="button" data-party="any" aria-pressed="${state.party === 'any'}">Solo</button>
            <button type="button" data-party="pair" aria-pressed="${state.party === 'pair'}">Two together</button>
          </div>
        </div>`;

  function theatreCard(t, days, i) {
    const meta = [
      t.chain ? esc(chainName(t.chain)) : null,
      t.city ? esc(t.city) : null,
      t.miles != null ? `<span class="dist">${fmtMiles(t.miles)}</span>` : null,
      t.scannedAt ? `<span title="${esc(stampPT(t.scannedAt))} PT">checked ${esc(ago(t.scannedAt))}</span>` : null,
    ].filter(Boolean).map((x, k) => (k ? '<span class="dot"></span>' : '') + `<span>${x}</span>`).join('');

    let body;
    if (!t.onSale) {
      body = `<div class="waiting"><span class="pill wait">Not on sale yet</span> We're camped outside the box office. This lights up the moment tickets open.</div>`;
    } else {
      const frames = days.map((d, f) => {
        const shows = t.byDate.get(d) || [];
        const st = dayState(shows);
        const title = st === 'dark' ? `${shortDate(d)} — no show` : `${shortDate(d)} — ${shows.length} show${shows.length === 1 ? '' : 's'}, best: ${STATE_WORD[st]}`;
        return `<span class="frame ${st}${isWeekend(d) ? ' we' : ''}" style="--f:${f}" title="${esc(title)}"></span>`;
      }).join('');
      const centerShows = t.live.filter(s => seatTier(s) === 'center').length;
      const withSeat = t.live.filter(hasSeat).length;
      const sold = t.shows.filter(s => s.status === 'soldout').length;
      const best = t.best
        ? `<span class="best">${pill(t.best)}<span class="when">${esc(t.best.dayLabel)} · ${esc(t.best.timeLabel)}</span></span>`
        : `<span class="best"><span class="pill none">${state.party === 'pair' ? 'No two together' : 'Front rows only'}</span><span>${state.party === 'pair' ? 'Nothing left side by side. Try solo.' : 'Only the neck-craning rows are left.'}</span></span>`;
      body = `
        <div class="film-wrap" aria-label="Best open seats by date">
          <div class="film"><div class="frames">${frames}</div></div>
          <div class="film-axis"><span>${esc(shortDate(days[0]))}</span><span>${esc(shortDate(days[days.length - 1]))}</span></div>
        </div>
        <div class="sig">
          ${best}
          <span class="counts"><span><b>${centerShows}</b> center</span><span><b>${withSeat}</b> of <b>${t.live.length}</b> shows</span>${sold ? `<span><b>${sold}</b> sold out</span>` : ''}</span>
        </div>`;
    }

    return `
      <a class="th" href="#/t/${esc(t.id)}" style="--i:${i}" aria-label="${esc(t.name)}">
        <div class="th-head">
          <h3 class="th-name">${esc(t.name)}</h3>
          <div class="th-meta">${meta}</div>
        </div>
        <span class="arrow">${svg('arrow')}</span>
        ${body}
      </a>`;
  }

  // ----- theatre view -----
  function renderTheatre(data, id) {
    let movie = null, t = null;
    for (const m of data.movies) { const hit = m.theatres.find(x => x.id === id); if (hit) { movie = m; t = hit; break; } }
    if (!t) return `<a class="back" href="#/">${svg('back')} All theatres</a><p class="notice">That theatre isn't on the marquee.</p>`;
    const now = data.now;

    const meta = [
      t.chain ? esc(chainName(t.chain)) : null,
      t.city ? esc(t.city) : null,
      t.scannedAt ? `checked ${esc(ago(t.scannedAt))} <span style="color:var(--dim)">(${esc(stampPT(t.scannedAt))} PT)</span>` : null,
    ].filter(Boolean).map((x, k) => (k ? '<span class="dot"></span>' : '') + `<span>${x}</span>`).join('');
    const links = [
      t.directBookingUrl ? `<a class="btn" href="${esc(t.directBookingUrl)}" target="_blank" rel="noopener">${esc(chainName(t.chain) || 'Theatre site')} ${svg('ext')}</a>` : '',
      t.fandangoUrl ? `<a class="btn" href="${esc(t.fandangoUrl)}" target="_blank" rel="noopener">Fandango ${svg('ext')}</a>` : '',
    ].join('');

    const head = `
      <a class="back" href="#/">${svg('back')} All theatres</a>
      <section class="th-hero">
        <div>
          <span class="eyebrow">${esc(movie.title)} · ${esc(t.format)}</span>
          <h1>${esc(t.name)}</h1>
          <div class="th-meta">${meta}</div>
        </div>
        <div class="links">${links}</div>
      </section>`;

    if (!t.onSale) {
      return head + `<p class="notice">Tickets for ${esc(movie.title)} aren't on sale here yet. We check twice a day; this page fills in the moment they open.</p>`;
    }

    const passWhen = (s) => state.when === 'any' || !s.workHours;
    const passSeats = (s) => { const k = seatTier(s); return state.seats === 'any' ? true : state.seats === 'mid' ? (k === 'center' || k === 'midBack') : k === 'center'; };
    const visible = t.shows.filter(s => passWhen(s) && (s.status !== 'available' ? state.seats === 'any' : passSeats(s)));

    const picks = rankShows(t.live.filter(s => hasSeat(s) && passWhen(s) && passSeats(s))).slice(0, 3);
    const picksHtml = picks.length ? `
      <section class="picks" aria-label="Top picks">
        <span class="eyebrow">Best bets</span>
        ${picks.map((s, i) => {
          const [hm, ap] = splitTime(s.timeLabel);
          return `
          <a class="stub" href="${esc(s.bookingUrl)}" target="_blank" rel="noopener" style="--i:${i}">
            <span class="rail">${state.party === 'pair' ? 'Admit two' : 'Admit one'}</span>
            <span class="body">
              <span class="rank">No. ${i + 1}</span>
              <span class="time">${esc(hm)}<small>${esc(ap)}</small></span>
              <span class="day">${esc(s.dayLabel)}${isWeekend(s.dateISO) ? ' · weekend' : s.workHours ? ' · work hours' : ' · evening'}</span>
              <span class="row2">${pill(s)}<span><b>${s.usable}</b> open${s.pairs.total ? ` · <b>${s.pairs.total}</b> together` : ''}</span></span>
              <span class="btn go">Book it ${svg('ext')}</span>
            </span>
          </a>`;
        }).join('')}
      </section>` : '';

    const filters = `
      <div class="filters" role="toolbar" aria-label="Filter showtimes">
        ${partyControl()}
        <div class="ctl-group"><span class="ctl-label">When</span>
          <div class="seg">
            <button type="button" data-when="any" aria-pressed="${state.when === 'any'}">Any time</button>
            <button type="button" data-when="off" aria-pressed="${state.when === 'off'}">Nights &amp; weekends</button>
          </div>
        </div>
        <div class="ctl-group"><span class="ctl-label">Seats</span>
          <div class="seg">
            <button type="button" data-seats="any" aria-pressed="${state.seats === 'any'}">Any</button>
            <button type="button" data-seats="mid" aria-pressed="${state.seats === 'mid'}">Mid-back or better</button>
            <button type="button" data-seats="center" aria-pressed="${state.seats === 'center'}">Center only</button>
          </div>
        </div>
        <span class="ctl-note"><b class="num">${visible.length}</b> of ${t.shows.length} shows</span>
      </div>`;

    const byDate = new Map();
    for (const s of visible) { if (!byDate.has(s.dateISO)) byDate.set(s.dateISO, []); byDate.get(s.dateISO).push(s); }
    const days = [...byDate.keys()].sort().map(d => {
      const shows = byDate.get(d).sort((a, b) => minutesOf(a.timeLabel) - minutesOf(b.timeLabel));
      const withCenter = shows.filter(s => s.status === 'available' && seatTier(s) === 'center').length;
      const withPair = shows.filter(hasSeat).length;
      return `
        <section class="day">
          <div class="day-head">
            <h3>${esc(shows[0].dayLabel)}</h3>
            ${isWeekend(d) ? '<span class="we-tag">Weekend</span>' : ''}
            <span class="sum"><b>${withPair}</b> of <b>${shows.length}</b> have good seats · <b>${withCenter}</b> center</span>
            ${d === now.dateISO ? '<span class="today">Tonight</span>' : d === addDays(now.dateISO, 1) ? '<span class="today">Tomorrow</span>' : ''}
          </div>
          ${shows.map(showRow).join('')}
        </section>`;
    }).join('');

    return head + picksHtml + filters + (days || `<p class="notice">Nothing matches. The room is full or the filters are tight. Loosen one.</p>`);
  }

  function showRow(s) {
    const dead = s.status !== 'available';
    const src = state.party === 'pair' ? s.pairs : (s.open || {});
    const mix = !dead && seatTier(s)
      ? `<span class="mix" title="${state.party === 'pair' ? 'Pairs' : 'Open seats'}: center · mid-back · edge"><span class="g"><i></i>${src.center}</span><span class="s"><i></i>${src.midBack}</span><span class="b"><i></i>${src.flexible}</span></span>` : '';
    const fill = dead ? `<span class="fill"></span>` : `
      <span class="fill">
        <span class="bar" aria-hidden="true"><i style="width:${Math.max(2, Math.min(100, s.pctFull ?? 0))}%"></i></span>
        <span class="left">${s.pctFull != null ? `${s.pctFull}% full` : ''}${state.party !== 'pair' && s.pairs.total ? ` · <b>${s.pairs.total}</b> together` : ''}</span>
      </span>`;
    const book = dead ? '' : `<span class="book"><span class="btn">Book ${svg('ext')}</span></span>`;
    const tag = s.workHours ? '<span class="tag">work hrs</span>' : '';
    const inner = `
      <span class="t">${svg(s.part || 'evening')}${esc(s.timeLabel)}</span>
      <span class="tiers">${pill(s)}${tag}${mix}</span>
      ${fill}
      ${book}`;
    return dead
      ? `<div class="show dead">${inner}</div>`
      : `<a class="show" href="${esc(s.bookingUrl)}" target="_blank" rel="noopener" aria-label="Book ${esc(s.dayLabel)} ${esc(s.timeLabel)}">${inner}</a>`;
  }

  // ----- routing + events -----
  const app = $('#app');
  function render() {
    if (!state.data) return;
    derive(state.data);
    const m = /^#\/t\/([A-Za-z0-9_-]+)/.exec(location.hash);
    app.innerHTML = m ? renderTheatre(state.data, m[1]) : renderLanding(state.data);
    if (m) window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', render);

  app.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort],button[data-metro],button[data-when],button[data-seats],button[data-party]');
    if (!b) return;
    e.preventDefault();
    // No location yet → ask. Approximate (IP) location and already sorted nearest → upgrade to precise.
    if (b.dataset.sort === 'nearest' && (!state.loc || (state.loc.approx && state.sort === 'nearest'))) return locate();
    if (b.dataset.party) { state.party = b.dataset.party; try { localStorage.setItem('seatscout-party', state.party); } catch { /* ignore */ } }
    if (b.dataset.sort) state.sort = b.dataset.sort;
    if (b.dataset.metro) state.metro = b.dataset.metro;
    if (b.dataset.when) state.when = b.dataset.when;
    if (b.dataset.seats) state.seats = b.dataset.seats;
    render();
  });

  function locate() {
    state.locErr = null;
    if (!navigator.geolocation) { state.locErr = 'This browser has no location service.'; return render(); }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.sort = 'nearest';
        try { sessionStorage.setItem('seatscout-loc', JSON.stringify(state.loc)); } catch { /* ignore */ }
        render();
      },
      (err) => {
        state.locErr = state.loc ? null : err.code === 1 ? 'No location, no problem — theatres stay in best-seats order.' : 'Could not read your location.';
        render();
      },
      { maximumAge: 600000, timeout: 8000 },
    );
  }

  // Approximate location from the edge (IP-based, city-level, no prompt). Only
  // used when the visitor has not already shared a precise location. Fails
  // silently anywhere the route does not exist (local preview).
  const ipLocate = () => state.loc ? Promise.resolve() : fetch('/api/geo', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(g => {
      if (g && typeof g.lat === 'number' && typeof g.lng === 'number') {
        state.loc = { lat: g.lat, lng: g.lng, city: g.city || '', approx: true };
        state.sort = 'nearest';
      }
    })
    .catch(() => { /* no geo, best-seats order */ });

  // ----- boot -----
  Promise.all([
    fetch('signals.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    ipLocate(),
  ])
    .then(([data]) => {
      state.data = prepare(data);
      $('#fresh').innerHTML = `Counts from <b>${esc(stampPT(data.generatedAt))}</b> PT`;
      render();
    })
    .catch(err => {
      app.innerHTML = `<p class="notice">The projector jammed (${esc(err.message)}). Try again in a minute.</p>`;
    });
})();
