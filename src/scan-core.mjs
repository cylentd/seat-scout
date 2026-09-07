// Pure scanner logic — no network, no browser, no filesystem. Extracted from
// scan.mjs so the pipeline can be unit-tested without touching Fandango.
import { analyzeShow } from './classify.mjs';

export function isoPlusDays(base, n) {
  const d = new Date(base + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Pull the showtimes matching the configured movie + format out of a
// theaterMovieShowtimes payload. `fd` = the config's fandango block.
export function matchingShowtimes(showtimesJson, fd) {
  const movies = showtimesJson.viewModel?.movies || showtimesJson.movies || [];
  const out = [];
  for (const movie of movies) {
    if (!new RegExp(fd.movieTitleMatch, 'i').test(movie.title || '')) continue;
    for (const variant of movie.variants || []) {
      for (const group of variant.amenityGroups || []) {
        for (const st of group.showtimes || []) {
          const formats = (st.filmFormat || []).map(f => f.filterName);
          if (!formats.includes(fd.formatFilter)) continue;
          out.push({
            movieTitle: movie.title,
            id: st.id,
            hash: st.showtimeHashCode,
            timeLabel: st.date,
            ticketingDate: st.ticketingDate, // "2026-07-25+07:00"
            type: st.type,                   // "available" | "soldout"
            expired: !!st.expired,
            formats,
          });
        }
      }
    }
  }
  return out;
}

export function compactSeatMap(sm) {
  return {
    auditoriumId: sm.auditoriumId,
    totalAvailable: sm.totalAvailableSeatCount,
    totalSeats: sm.totalSeatCount,
    seats: (sm.seats || []).map(s => ({
      id: s.id, x: s.x, y: s.y, w: s.width, h: s.height,
      col: s.column, status: s.status, type: s.type, right: s.rightNeighbor || null,
    })),
  };
}

export function dateIsClean(res) {
  return res && !res.errors?.length &&
    res.shows.every(s => s.error == null && (s.type !== 'available' || s.expired || s.seatMap));
}

// Freshness tiers: near dates change fastest and matter most, so their cache
// expires immediately; far-out dates barely move and can ride for days.
export const TTL_TIERS = [
  { maxDaysOut: 3, hours: 0 },
  { maxDaysOut: 14, hours: 24 },
  { maxDaysOut: Infinity, hours: 72 },
];
export const ttlMs = (daysOut) => TTL_TIERS.find(t => daysOut <= t.maxDaysOut).hours * 3600_000;
export const daysBetween = (fromISO, toISO) =>
  Math.round((new Date(toISO + 'T12:00:00Z') - new Date(fromISO + 'T12:00:00Z')) / 86400_000);

// A cached scan is only reusable if it was scanned for the same target —
// otherwise the "cache" is data about a different movie, theatre, or format.
// (partySize deliberately excluded: seat maps are raw data; grouping happens
// at report time, so a party-size change needs no re-scan.)
export function sameTarget(prevCfg, cfg) {
  const a = prevCfg?.fandango, b = cfg.fandango;
  if (!a || !b) return false;
  return ['theaterId', 'chainCode', 'movieTitleMatch', 'formatFilter'].every(k => a[k] === b[k]);
}

// Stable filename-safe key for a scan target, so each movie/theatre/format
// combination caches to its own file. Slug for readability + a short hash so
// sanitisation collisions can't cross-contaminate caches.
export function targetKey(cfg) {
  const fd = cfg.fandango;
  const raw = [fd.theaterId, fd.chainCode, fd.formatFilter, fd.movieTitleMatch].join('|');
  let h = 5381;
  for (const ch of raw) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug}-${h.toString(16)}`;
}

// Every movie playing in a theaterMovieShowtimes payload, with its formats —
// feeds the landing page's "playing now" suggestions.
// Poster art from a Fandango movie object. Real shape: `poster` / `darkPoster`,
// each `{ size: { '100'..'500', full }, uri }` of ImageRenderer CDN URLs. The URL
// carries its render width as a path segment (/ImageRenderer/<w>/…) against a
// high-res source, so we request a crisp retina width from the same image rather
// than the small default bucket. Prefer the dark variant (our UI is dark).
// Returned only when found, so the bare { title, formats } shape is unchanged.
const POSTER_W = 640;
function posterOf(m) {
  for (const p of [m.darkPoster, m.poster]) {
    const s = p && p.size;
    if (s) {
      const url = s.full || s['500'] || s['400'] || s['300'];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        return url.replace(/(\/ImageRenderer\/)\d+(\/)/, `$1${POSTER_W}$2`);
      }
    }
  }
  // Legacy/best-effort flat fields, just in case.
  for (const v of [m.posterImage, m.image, m.imageUrl, m.thumbnailUrl, m.media?.posterImage, m.media?.image]) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

export function listMovies(showtimesJson) {
  const movies = showtimesJson.viewModel?.movies || showtimesJson.movies || [];
  return movies
    .filter(m => m.title)
    .map(m => {
      const formats = new Set();
      for (const v of m.variants || []) {
        for (const g of v.amenityGroups || []) {
          for (const st of g.showtimes || []) {
            for (const f of st.filmFormat || []) if (f.filterName) formats.add(f.filterName);
          }
        }
      }
      const poster = posterOf(m);
      const base = { title: m.title, formats: [...formats] };
      return poster ? { ...base, poster } : base;
    });
}

// Pair/usable totals for one stored show — same classifier the report uses.
export function pairTotals(cfg, show) {
  const a = analyzeShow(cfg, show);
  return {
    pairs: a.duos.center + a.duos.midBack + a.duos.flexible,
    usable: a.counts.open.center + a.counts.open.midBack + a.counts.open.flexible,
  };
}

// ---- Sell-rate history ------------------------------------------------------

// One compact observation per run: { at, kind, shows: { id: { p, u } } } where
// p = bookable groups, u = usable seats. Only shows actually OBSERVED this run
// are recorded — full scans observe fetched dates, watch runs observe the shows
// they refreshed — so a trend never compares a stale copy against itself.
export function observeResults(cfg, results, { dates = null, ids = null } = {}) {
  const shows = {};
  for (const r of results) {
    if (dates && !dates.has(r.date)) continue;
    for (const s of r.shows) {
      if (s.expired) continue;
      if (ids && !ids.has(String(s.id))) continue;
      if (s.seatMap) {
        const t = pairTotals(cfg, s);
        shows[String(s.id)] = { p: t.pairs, u: t.usable };
      } else if (s.type === 'soldout') {
        shows[String(s.id)] = { p: 0, u: 0 };
      }
      // available-but-unfetched (errors) stays unobserved on purpose
    }
  }
  return shows;
}

export const appendHistory = (history, entry, cap = 40) =>
  [...(history || []), entry].slice(-cap);

// Consecutive most-recent observations of one show with zero bookable pairs.
// Entries that didn't observe the show are skipped (watch runs observe subsets);
// the streak breaks at the first observation that had pairs. Feeds the scanner's
// "skip chronically pair-less seat maps" rule — a show that has had no bookable
// pair for N straight observations isn't worth a seat-map request every scan.
export function pairlessStreak(history, id) {
  let streak = 0;
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const obs = history[i]?.shows?.[String(id)];
    if (!obs) continue;
    if (obs.p > 0) break;
    streak++;
  }
  return streak;
}

// Trend between a baseline observation and the current report, decomposed so
// demand (existing shows selling out) is never conflated with supply (new dates
// opening) or the calendar (past dates rolling off the window).
// `current`: [{ id, pairs, usable }] for every non-expired show in the report.
export function computeTrend(history, current, minGapHours = 12) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const newest = history[history.length - 1];
  const newestMs = new Date(newest.at).getTime();

  // Baseline: the newest entry at least minGap older than the newest entry, so
  // back-to-back scans don't hide the real story; fall back to the oldest.
  let baseline = history[0];
  for (const e of history) {
    if (newestMs - new Date(e.at).getTime() >= minGapHours * 3600_000) baseline = e;
  }
  if (baseline === newest) return null;
  const baselineMs = new Date(baseline.at).getTime();

  // Each show's most recent observation at or before the baseline — watch runs
  // observe subsets, so a show's baseline may come from an earlier entry.
  const seenAtBaseline = new Map();
  for (const e of history) {
    if (new Date(e.at).getTime() > baselineMs) break;
    for (const [id, v] of Object.entries(e.shows || {})) seenAtBaseline.set(id, v);
  }
  // Anything never observed before the newest entry is genuinely new inventory.
  const seenBefore = new Set();
  for (const e of history.slice(0, -1)) {
    for (const id of Object.keys(e.shows || {})) seenBefore.add(id);
  }

  const currentById = new Map(current.map(s => [String(s.id), s]));
  const perShow = {};
  let hadPairs = 0, lostPairs = 0, retained = 0, passed = 0;
  for (const [id, base] of seenAtBaseline) {
    const cur = currentById.get(id);
    if (base.p > 0) {
      hadPairs++;
      if (!cur) passed++;             // rolled off the window — not a sell-out
      else if (cur.pairs > 0) retained++;
      else lostPairs++;
    }
    if (cur) {
      perShow[id] = {
        wasPairs: base.p, wasUsable: base.u,
        pairsDelta: cur.pairs - base.p, usableDelta: cur.usable - base.u,
      };
    }
  }
  const newIds = current.map(s => String(s.id)).filter(id => !seenBefore.has(id));
  const newWithPairs = newIds.filter(id => currentById.get(id).pairs > 0).length;
  return {
    baselineAt: baseline.at,
    perShow,
    newIds,
    summary: { hadPairs, lostPairs, retained, passed, newShows: newIds.length, newWithPairs },
  };
}

// theaterCalendar payload -> sorted unique YYYY-MM-DD dates.
//
// Fandango serves two shapes and we have to read both:
//   * object  { showtimeDates: [...], calendar: [{ full, hasShowtime }] }
//     — what BOTH Regal and AMC actually return as of 2026-07. Theatre-wide:
//       every date the venue has any showtime, not per-film.
//   * array   [{ days, hoCode }]  — per-film, seen on older responses.
// The array branch is the only one hoCodes can filter; on the object shape the
// data simply isn't per-film, so callers must treat the result as a SUPERSET of
// any one movie's run and confirm with theaterMovieShowtimes.
export function calendarDates(json, hoCodes = null) {
  const dates = new Set();
  if (Array.isArray(json)) {
    for (const e of json) {
      if (hoCodes?.length && !hoCodes.includes(e.hoCode)) continue;
      for (const d of e.days || []) dates.add(String(d).slice(0, 10));
    }
  } else if (json && typeof json === 'object') {
    for (const d of json.showtimeDates || []) dates.add(String(d).slice(0, 10));
    for (const e of json.calendar || []) {
      if (e && e.hasShowtime && e.full) dates.add(String(e.full).slice(0, 10));
    }
  }
  return [...dates].sort();
}

// True when the payload carries no per-film breakdown, so a caller knows the
// dates are theatre-wide and can't stand in for "this movie plays that day".
export const calendarIsTheatreWide = (json) => !Array.isArray(json);

// ---- Drop detection ---------------------------------------------------------
//
// A "drop" is new inventory appearing between two check-ins. Two kinds matter
// and they are NOT interchangeable:
//
//   SUPPLY — the theatre extended the run (dates that had no showtimes now do,
//            or a date gained an extra screening). Best seat selection of the
//            whole run; worth interrupting someone for.
//   RETURN — a showtime that was sold out is purchasable again (a hold expired
//            or someone refunded). Usually one or two seats, and it evaporates
//            fast, so it's urgent but much lower value than a run extension.
//
// Conflating them produces an alert you learn to ignore, so they stay separate
// all the way through to the notification.

// Stable cross-chain identity for one showtime.
//
// Chains do NOT agree on this. Regal showtimes carry a numeric `id`; AMC
// showtimes have no id field whatsoever (their keys are date, showtimeHashCode,
// ticketingDate, type, …). Keying on `id` therefore produced the literal string
// "undefined" for every AMC show, collapsing them into one bucket and making
// the diff meaningless.
//
// `ticketingDate` ("2026-07-22+06:00") is present on both chains, encodes the
// date and start time, and — unlike a hash — cannot churn while still meaning
// the same screening. That makes it the identity: a screening IS a start time
// for a given movie/format/theatre. Hash and id are fallbacks only.
//
// Caveat: two same-format screenings starting at the identical minute in
// different auditoriums would merge into one. That is vanishingly rare for a
// single-format filter, and merging is the safe failure — it under-reports
// rather than inventing a drop.
export function showKey(s) {
  const k = s.ticketingDate ?? s.showtimeHashCode ?? s.hash ?? s.id;
  return k == null ? null : String(k);
}

// A snapshot is the minimum needed to diff runs: { dates: { ISO: [show] } }
// where show = { id, time, type }. Built from theaterMovieShowtimes responses.
// Shows with no derivable identity are dropped rather than stored under a
// placeholder — an unidentifiable show would otherwise alias with every other
// unidentifiable show and manufacture drops.
export function snapshotFromDates(dateResults) {
  const dates = {};
  for (const { date, shows } of dateResults) {
    dates[date] = (shows || [])
      .filter(s => !s.expired)
      .map(s => ({ id: showKey(s), time: s.timeLabel ?? s.time ?? null, type: s.type || 'available' }))
      .filter(s => s.id !== null);
  }
  return { dates };
}

// Last date the movie actually plays. Dates present but empty are the tail the
// scanner probed past the end of the run, so they must not count.
export function runEndOf(snapshot) {
  const played = Object.entries(snapshot?.dates || {})
    .filter(([, shows]) => shows && shows.length)
    .map(([d]) => d)
    .sort();
  return played.at(-1) || null;
}

// Diff two snapshots. `cur` is normally partial — a watcher only re-probes a
// window — so any date absent from `cur` is treated as "not checked", never as
// "the showtimes disappeared". Silence must not manufacture an alert.
export function diffDrops(prev, cur) {
  const prevDates = prev?.dates || {};
  const curDates = cur?.dates || {};
  const newDates = [], newShows = [], freed = [], lost = [];

  for (const [date, shows] of Object.entries(curDates).sort()) {
    if (!shows.length) continue;
    const before = prevDates[date];
    // Never seen this date with showtimes before -> the run reaches further.
    if (!before || !before.length) {
      newDates.push({ date, count: shows.length, times: shows.map(s => s.time).filter(Boolean) });
      continue;
    }
    const byId = new Map(before.map(s => [s.id, s]));
    for (const s of shows) {
      const was = byId.get(s.id);
      if (!was) { newShows.push({ date, id: s.id, time: s.time }); continue; }
      if (was.type === 'soldout' && s.type === 'available') freed.push({ date, id: s.id, time: s.time });
      else if (was.type === 'available' && s.type === 'soldout') lost.push({ date, id: s.id, time: s.time });
    }
  }

  const prevEnd = runEndOf(prev);
  const curEnd = runEndOf({ dates: { ...prevDates, ...curDates } });
  return {
    newDates, newShows, freed, lost,
    prevRunEnd: prevEnd,
    runEnd: curEnd,
    extended: !!(curEnd && prevEnd && curEnd > prevEnd),
    supply: newDates.length + newShows.length,
    returns: freed.length,
  };
}

// Merge a partial check into the stored snapshot: probed dates overwrite,
// unprobed dates carry forward untouched.
export const mergeSnapshot = (prev, cur) => ({ dates: { ...(prev?.dates || {}), ...(cur?.dates || {}) } });

// Which dates to spend requests on this run, cheapest-value-first:
//   1. `aheadDays` beyond the known run end — where an extension shows up.
//   2. the next `recheckDays` from today — where returned seats show up.
// Both are intersected with the theatre-wide calendar when we have one, since a
// date the venue has no showtimes at all on cannot possibly have ours.
export function probePlan({ today, runEnd, aheadDays = 10, recheckDays = 4, calendar = null }) {
  const cal = calendar?.length ? new Set(calendar) : null;
  const wanted = [];
  const from = runEnd && runEnd >= today ? runEnd : isoPlusDays(today, -1);
  for (let i = 1; i <= aheadDays; i++) wanted.push(isoPlusDays(from, i));
  for (let i = 0; i < recheckDays; i++) wanted.push(isoPlusDays(today, i));
  return [...new Set(wanted)]
    .filter(d => d >= today)
    .filter(d => !cal || cal.has(d))
    .sort();
}
