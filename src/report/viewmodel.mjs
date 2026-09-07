// Transforms scan data + tier analysis into a presentation-ready model.
// This is the ONLY place that knows both the domain shape (classify.mjs output)
// and what the view needs — components downstream stay dumb and pure.
import { analyzeShow, rankShows, practicality } from '../classify.mjs';
import { computeTrend } from '../scan-core.mjs';
import { TIERS, TIER_ORDER, seatCode } from './theme.mjs';
import { fmtShowtime, partOfDay, pct } from './format.mjs';

// Direct link to THIS showtime's seat-selection/purchase page (same URL the
// site's own showtime buttons use). Falls back to the theater page when we
// can't construct it (e.g. missing hash).
function bookingUrl(cfg, show) {
  const f = cfg.fandango;
  if (show.hash && f.movieId) {
    const q = new URLSearchParams({
      sdate: show.ticketingDate, from: 'mov_det_showtimes', source: 'desktop',
      mid: String(f.movieId), tid: f.theaterId, dfam: 'webbrowser', showtimehashcode: show.hash,
    });
    return `https://tickets.fandango.com/transaction/ticketing/mobile/jump.aspx?${q}`;
  }
  const slug = f.theaterSlug || `theater-${f.theaterId.toLowerCase()}`;
  return `https://www.fandango.com/${slug}/theater-page`;
}

function seatPayload(analyzed) {
  // Compact per-seat tuples: [x, y, w, h, code, id]. id is kept for every seat so
  // the browser can show its number on hover (not just for open seats).
  const s = analyzed.seats.map(seat => [
    Math.round(seat.x), Math.round(seat.y), Math.round(seat.w), Math.round(seat.h),
    seatCode(seat), seat.id,
  ]);
  return { a: analyzed.seatMap.auditoriumId, s };
}

function badgesFor(analyzed) {
  return TIER_ORDER
    .filter(k => analyzed.duos[k] > 0)
    .map(k => ({ ...TIERS[k], count: analyzed.duos[k] }));
}

function availabilityFor(analyzed) {
  const c = analyzed.counts;
  const openStd = c.open.center + c.open.midBack + c.open.flexible + c.open.front;
  return {
    openStd,
    // "usable" = open seats outside the front rows — the number that actually
    // matters when deciding; % full alone hides that the remainder can be all
    // front-row and accessible seats.
    usable: c.open.center + c.open.midBack + c.open.flexible,
    open: { ...c.open },
    accessible: c.accessibleOpen,
    taken: c.sold,
    total: c.total,
    pctFull: pct(c.sold, c.total),
  };
}

function availableShowVM(cfg, analyzed) {
  const t = fmtShowtime(analyzed.ticketingDate);
  const pairs = { ...analyzed.duos, total: analyzed.duos.center + analyzed.duos.midBack + analyzed.duos.flexible };
  return {
    id: String(analyzed.id),
    status: 'available',
    hasMap: true,
    ticketingDate: analyzed.ticketingDate,
    dateISO: t.dateISO,
    dayLabel: t.dayLabel,
    timeLabel: t.timeLabel,
    part: partOfDay(t.hour),
    workHours: practicality(analyzed.ticketingDate) === 1,
    tierKey: analyzed.bestTier,
    tierRank: analyzed.bestTier ? TIERS[analyzed.bestTier].rank : 99,
    badges: badgesFor(analyzed),
    pairs,
    avail: availabilityFor(analyzed),
    bookingUrl: bookingUrl(cfg, analyzed),
  };
}

function unavailableShowVM(cfg, show) {
  const t = fmtShowtime(show.ticketingDate);
  return {
    id: String(show.id),
    status: show.type === 'soldout' ? 'soldout' : 'unavailable',
    hasMap: false,
    ticketingDate: show.ticketingDate,
    dateISO: t.dateISO,
    dayLabel: t.dayLabel,
    timeLabel: t.timeLabel,
    part: partOfDay(t.hour),
    workHours: practicality(show.ticketingDate) === 1,
    tierKey: null,
    tierRank: 99,
    badges: [],
    pairs: { center: 0, midBack: 0, flexible: 0, total: 0 },
    avail: null,
    bookingUrl: bookingUrl(cfg, show),
  };
}

export function buildReportModel(cfg, scan, history = null) {
  const rawShows = scan.results.flatMap(r => r.shows).filter(s => !s.expired);

  const analyzed = rawShows.filter(s => s.seatMap).map(s => analyzeShow(cfg, s));
  const ranked = rankShows(analyzed);

  const shows = [
    ...analyzed.map(a => availableShowVM(cfg, a)),
    ...rawShows.filter(s => !s.seatMap).map(s => unavailableShowVM(cfg, s)),
    // ticketingDate is "YYYY-MM-DD+HH:MM" with a zero-padded 24h clock, so a
    // lexical sort is chronological. (timeLabel is NOT: "10:50 PM" < "2:50 PM".)
  ].sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.ticketingDate.localeCompare(b.ticketingDate));

  // Group by day, preserving chronological order.
  const days = [];
  const byDate = new Map();
  for (const s of shows) {
    if (!byDate.has(s.dateISO)) {
      const entry = { dateISO: s.dateISO, dayLabel: s.dayLabel, shows: [], withPairs: 0 };
      byDate.set(s.dateISO, entry);
      days.push(entry);
    }
    const entry = byDate.get(s.dateISO);
    entry.shows.push(s);
    if (s.pairs.total > 0) entry.withPairs++;
  }

  // Sell-rate trend: per-show deltas vs the history baseline, plus new-show
  // detection — computed show-by-show so new dates opening can't masquerade as
  // recovery (see computeTrend).
  const trend = computeTrend(history, shows.map(s => ({
    id: s.id, pairs: s.pairs.total, usable: s.avail ? s.avail.usable : 0,
  })));
  if (trend) {
    const newSet = new Set(trend.newIds);
    for (const s of shows) {
      const t = trend.perShow[s.id];
      s.trend = {
        isNew: newSet.has(s.id),
        wasUsable: t ? t.wasUsable : null,
        usableDelta: t ? t.usableDelta : null,
      };
    }
    for (const day of days) {
      day.justOpened = day.shows.length > 0 && day.shows.every(s => s.trend.isNew);
    }
  }
  const baselineLabel = trend
    ? new Date(trend.baselineAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  const withPairs = shows.filter(s => s.pairs.total > 0);
  // Ranked best-first: doable times, then seat quality (see classify.rankShows).
  // The hero shows #1; the podium shows the top 3; filters cover the rest.
  const rankedVMs = ranked.filter(a => a.bestTier).map(a => availableShowVM(cfg, a));
  const topPicks = rankedVMs.slice(0, 3);

  const seatPayloads = {};
  for (const a of analyzed) seatPayloads[String(a.id)] = seatPayload(a);

  return {
    meta: {
      movie: cfg.fandango.movieTitle
        || (cfg.fandango.movieTitleMatch === 'Odyssey' ? 'The Odyssey' : cfg.fandango.movieTitleMatch),
      format: cfg.fandango.formatFilter,
      theatre: cfg.theatreName,
      partySize: cfg.partySize,
      scannedAt: scan.scannedAt,
      source: scan.source || 'fandango',
      directBooking: cfg.directBooking || null,
      trendBaseline: baselineLabel,
    },
    stats: {
      total: shows.length,
      available: shows.filter(s => s.status === 'available').length,
      soldOut: shows.filter(s => s.status === 'soldout').length,
      withPairs: withPairs.length,
      doablePairs: withPairs.filter(s => !s.workHours).length,
      bestPick: topPicks[0] || null,
    },
    tiers: TIER_ORDER.map(k => ({ ...TIERS[k], showCount: withPairs.filter(s => s.tierKey === k).length })),
    trend: trend ? { baselineAt: trend.baselineAt, baselineLabel, summary: trend.summary } : null,
    topPicks,
    days,
    seatPayloads,
  };
}
