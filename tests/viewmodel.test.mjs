import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportModel } from '../src/report/viewmodel.mjs';
import { cfg, makeScan, makeShow, auditorium } from './helpers.mjs';

const model = () => buildReportModel(cfg, makeScan());

test('expired shows are dropped everywhere', () => {
  const m = model();
  assert.equal(m.stats.total, 4);
  assert.ok(!m.days.flatMap(d => d.shows).some(s => s.id === '5'));
});

test('stats: availability, pairs, and doable pairs', () => {
  const { stats } = model();
  assert.equal(stats.available, 3);
  assert.equal(stats.soldOut, 1);
  assert.equal(stats.withPairs, 2);   // shows 1 and 4
  assert.equal(stats.doablePairs, 1); // show 4 is Monday work hours
  assert.equal(stats.bestPick.id, '1');
});

test('top picks are ranked: weekend center show first', () => {
  const m = model();
  assert.deepEqual(m.topPicks.map(p => p.id), ['1', '4']);
  assert.equal(m.topPicks[0].tierKey, 'center');
});

test('days group chronologically with per-day pair counts', () => {
  const m = model();
  assert.deepEqual(m.days.map(d => d.dateISO), ['2026-08-01', '2026-08-03']);
  assert.equal(m.days[0].dayLabel, 'Sat Aug 1');
  assert.equal(m.days[0].withPairs, 1);
  assert.equal(m.days[1].withPairs, 1);
});

test('shows within a day sort chronologically, not lexically by label', () => {
  // Regression: "10:50 PM" < "2:50 PM" lexically; sorting must use ticketingDate.
  const scan = {
    scannedAt: '2026-07-19T12:00:00.000Z',
    results: [{
      date: '2026-08-05',
      shows: [
        makeShow({ id: 10, ticketingDate: '2026-08-05+22:50', seats: auditorium({ E: [8, 9] }) }),
        makeShow({ id: 11, ticketingDate: '2026-08-05+14:50', seats: auditorium({ E: [8, 9] }) }),
      ],
      errors: [],
    }],
  };
  const m = buildReportModel(cfg, scan);
  assert.deepEqual(m.days[0].shows.map(s => s.timeLabel), ['2:50 PM', '10:50 PM']);
});

test('availability separates usable seats from front/accessible', () => {
  const scan = {
    scannedAt: '2026-07-19T12:00:00.000Z',
    results: [{
      date: '2026-08-01',
      shows: [makeShow({
        id: 1, ticketingDate: '2026-08-01+19:00',
        seats: auditorium({ E: [8, 9], I: [1], A: [5, 6] }, { D: [1] }),
      })],
      errors: [],
    }],
  };
  const a = buildReportModel(cfg, scan).days[0].shows[0].avail;
  assert.equal(a.usable, 3);              // E8, E9 (center) + I1 (flexible)
  assert.equal(a.open.front, 2);          // A5, A6 excluded from usable
  assert.equal(a.openStd, 5);             // usable + front
  assert.equal(a.accessible, 0);          // D1 wheelchair is reserved => sold
  assert.equal(a.total, 9 * 21);
  assert.equal(a.pctFull, Math.round(100 * (9 * 21 - 5) / (9 * 21)));
});

test('workHours flag follows practicality', () => {
  const byId = Object.fromEntries(model().days.flatMap(d => d.shows).map(s => [s.id, s]));
  assert.equal(byId['1'].workHours, false); // Saturday evening
  assert.equal(byId['4'].workHours, true);  // Monday 1 PM
});

test('sold-out shows keep their slot with soldout status and no map', () => {
  const show3 = model().days[0].shows.find(s => s.id === '3');
  assert.equal(show3.status, 'soldout');
  assert.equal(show3.hasMap, false);
  assert.equal(show3.pairs.total, 0);
  assert.equal(show3.avail, null);
});

test('booking URL uses the showtime hash, falling back to the theatre page', () => {
  const m = model();
  const show1 = m.days[0].shows.find(s => s.id === '1');
  assert.match(show1.bookingUrl, /^https:\/\/tickets\.fandango\.com\//);
  assert.match(show1.bookingUrl, /showtimehashcode=hash1/);
  assert.match(show1.bookingUrl, /mid=123/);

  const scan = makeScan();
  scan.results[0].shows[0].hash = null;
  const noHash = buildReportModel(cfg, scan).days[0].shows.find(s => s.id === '1');
  assert.equal(noHash.bookingUrl, 'https://www.fandango.com/test-theatre-test1/theater-page');
});

test('seat payloads are compact 6-tuples keyed by show id', () => {
  const m = model();
  assert.deepEqual(Object.keys(m.seatPayloads).sort(), ['1', '2', '4']);
  for (const p of Object.values(m.seatPayloads)) {
    assert.equal(p.a, 21);
    assert.equal(p.s.length, 9 * 21);
    for (const t of p.s) {
      assert.equal(t.length, 6);
      const [x, y, w, h, code, id] = t;
      assert.equal(typeof x, 'number');
      assert.ok(code >= 0 && code <= 5);
      assert.match(id, /^[A-I]\d+$/);
    }
  }
});

test('trend attaches per-show deltas, new flags, and just-opened days', () => {
  // Baseline knows shows 1–3; show 4 (all of Mon Aug 3) is new inventory.
  const history = [
    { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 1, u: 2 }, 2: { p: 1, u: 4 }, 3: { p: 1, u: 2 } } },
    { at: '2026-07-19T12:00:00Z', kind: 'watch', shows: { 1: { p: 2, u: 4 } } },
  ];
  const m = buildReportModel(cfg, makeScan(), history);
  assert.equal(m.trend.baselineAt, '2026-07-18T00:00:00Z');
  // shows 2 and 3 had pairs at baseline and have none now; show 1 retained.
  assert.deepEqual(m.trend.summary, { hadPairs: 3, lostPairs: 2, retained: 1, passed: 0, newShows: 1, newWithPairs: 1 });
  const byId = Object.fromEntries(m.days.flatMap(d => d.shows).map(s => [s.id, s]));
  assert.equal(byId['1'].trend.isNew, false);
  assert.equal(byId['1'].trend.wasUsable, 2);
  assert.equal(byId['1'].trend.usableDelta, 2);   // 2 -> 4 usable
  assert.equal(byId['4'].trend.isNew, true);
  assert.equal(m.days[0].justOpened, false);
  assert.equal(m.days[1].justOpened, true);       // Mon Aug 3: only show 4 (expired 5 dropped)
  assert.equal(m.meta.trendBaseline, m.trend.baselineLabel);
});

test('no history means no trend and untouched shows', () => {
  const m = buildReportModel(cfg, makeScan());
  assert.equal(m.trend, null);
  assert.ok(m.days.flatMap(d => d.shows).every(s => !('trend' in s)));
});

test('meta carries config values and the scan timestamp', () => {
  const m = model();
  assert.equal(m.meta.movie, 'The Odyssey'); // Odyssey special-case
  assert.equal(m.meta.format, 'IMAX 70MM');
  assert.equal(m.meta.theatre, 'Test Theatre');
  assert.equal(m.meta.partySize, 2);
  assert.equal(m.meta.scannedAt, '2026-07-19T12:00:00.000Z');
});

// --- local fixtures -------------------------------------------------------
// Row depths on the 9-row house: E .50 (centre band), H .875 and I 1.0 (past the
// centre band's 0.80 limit), A 0 (front). Seat n sits at cx = (n-1)/20.
//  - E8..E11 (cx .35-.50) centre · H8,H9 (cx .35,.40) mid-back · I1,I2 (cx 0,.05) flexible
const oneDay = (shows) => ({
  scannedAt: '2026-07-19T12:00:00.000Z',
  results: [{ date: '2026-08-01', shows, errors: [] }],
});
const sat = (id, time, seats, extra = {}) =>
  makeShow({ id, ticketingDate: `2026-08-01+${time}`, seats, ...extra });

// Five Saturday shows, all doable times: three centre, one mid-back, one flexible,
// plus a seat map with only a lone mid-back single (no pair).
const tierHouse = () => oneDay([
  sat(21, '14:00', auditorium({ E: [8, 9] })),
  sat(22, '15:00', auditorium({ H: [8, 9] })),
  sat(23, '16:00', auditorium({ I: [1, 2] })),
  sat(24, '17:00', auditorium({ E: [8, 9] })),
  sat(25, '18:00', auditorium({ E: [8, 9, 10, 11], H: [8, 9], I: [1, 2], A: [5, 6] })),
  sat(26, '19:00', auditorium({ F: [5] })),
]);
const byId = (m) => Object.fromEntries(m.days.flatMap(d => d.shows).map(s => [s.id, s]));

test('pair totals add centre, mid-back and flexible groups', () => {
  // Show 25: E8-E11 = 2 centre pairs, H8-H9 = 1 mid-back, I1-I2 = 1 flexible.
  const s = byId(buildReportModel(cfg, tierHouse()))['25'];
  assert.deepEqual(s.pairs, { center: 2, midBack: 1, flexible: 1, total: 4 });
  assert.deepEqual(s.open, { center: 4, midBack: 2, flexible: 2 });
});

test('availability adds every open standard seat, mid-back included', () => {
  // Show 25: 4 centre + 2 mid-back + 2 flexible = 8 usable; A5, A6 front => 10 open.
  const a = byId(buildReportModel(cfg, tierHouse()))['25'].avail;
  assert.equal(a.usable, 8);
  assert.equal(a.openStd, 10);
  assert.deepEqual(a.open, { center: 4, midBack: 2, flexible: 2, front: 2 });
});

test('badges list tiers best first, only those with pairs, with their counts', () => {
  const s = byId(buildReportModel(cfg, tierHouse()))['25'];
  assert.deepEqual(s.badges.map(b => [b.key, b.label, b.count]),
    [['center', 'Center', 2], ['midBack', 'Mid-back', 1], ['flexible', 'Flexible', 1]]);
  const onlyMid = byId(buildReportModel(cfg, tierHouse()))['22'];
  assert.deepEqual(onlyMid.badges.map(b => b.key), ['midBack']);
});

test('tier rank follows the best tier; a map with no pair ranks last (99)', () => {
  const shows = byId(buildReportModel(cfg, tierHouse()));
  assert.equal(shows['21'].tierRank, 0);
  assert.equal(shows['22'].tierRank, 1);
  assert.equal(shows['23'].tierRank, 2);
  assert.equal(shows['26'].tierKey, null);   // F5 alone: no pair
  assert.equal(shows['26'].tierRank, 99);
});

test('top picks keep the three best of four-plus pair shows', () => {
  const m = buildReportModel(cfg, tierHouse());
  // Rank is doable-time first (all Saturday), then tier: the three centre shows win.
  assert.equal(m.topPicks.length, 3);
  assert.deepEqual(m.topPicks.map(p => p.id).sort(), ['21', '24', '25']);
  assert.equal(m.stats.bestPick.tierKey, 'center');
});

test('tier summary counts each show once, under its best tier', () => {
  const tiers = buildReportModel(cfg, tierHouse()).tiers;
  assert.deepEqual(tiers.map(t => [t.key, t.showCount]),
    [['center', 3], ['midBack', 1], ['flexible', 1]]);
});

test('sold-out and unavailable shows carry empty pair, seat and badge data', () => {
  const scan = oneDay([
    makeShow({ id: 31, ticketingDate: '2026-08-03+13:00', type: 'unavailable' }), // Mon work hours
    makeShow({ id: 32, ticketingDate: '2026-08-03+18:00', type: 'soldout' }),     // Mon after 5 PM
    makeShow({ id: 33, ticketingDate: '2026-08-01+13:00', type: 'soldout' }),     // Saturday
  ]);
  const m = buildReportModel(cfg, scan);
  const s = byId(m);
  assert.equal(s['31'].status, 'unavailable');
  assert.equal(s['32'].status, 'soldout');
  for (const id of ['31', '32', '33']) {
    assert.equal(s[id].hasMap, false);
    assert.equal(s[id].tierKey, null);
    assert.equal(s[id].tierRank, 99);
    assert.deepEqual(s[id].badges, []);
    assert.deepEqual(s[id].pairs, { center: 0, midBack: 0, flexible: 0, total: 0 });
    assert.deepEqual(s[id].open, { center: 0, midBack: 0, flexible: 0 });
    assert.equal(s[id].avail, null);
  }
  assert.deepEqual([s['31'].workHours, s['32'].workHours, s['33'].workHours], [true, false, false]);
  // Only status 'available' counts as available; only 'soldout' as sold out.
  assert.equal(m.stats.available, 0);
  assert.equal(m.stats.soldOut, 2);
  assert.equal(m.stats.total, 3);
});

test('a map with no open seat is available-status but has zero everything', () => {
  const s = byId(buildReportModel(cfg, oneDay([sat(40, '19:00', auditorium())])))['40'];
  assert.equal(s.status, 'available');
  assert.equal(s.hasMap, true);
  assert.equal(s.avail.usable, 0);
  assert.equal(s.avail.pctFull, 100);
});

test('booking URL carries the showtime, movie, theatre and hash', () => {
  const show = byId(buildReportModel(cfg, makeScan()))['1'];
  const u = new URL(show.bookingUrl);
  assert.equal(u.origin + u.pathname, 'https://tickets.fandango.com/transaction/ticketing/mobile/jump.aspx');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    sdate: '2026-08-01+19:05', from: 'mov_det_showtimes', source: 'desktop',
    mid: '123', tid: 'TEST1', dfam: 'webbrowser', showtimehashcode: 'hash1',
  });
});

test('booking URL falls back to the theatre page when the movie id is missing', () => {
  const noMovie = { ...cfg, fandango: { ...cfg.fandango, movieId: undefined } };
  const show = byId(buildReportModel(noMovie, makeScan()))['1'];
  assert.equal(show.bookingUrl, 'https://www.fandango.com/test-theatre-test1/theater-page');
});

test('theatre-page fallback builds a slug from the lower-cased theatre id', () => {
  const noSlug = { ...cfg, fandango: { ...cfg.fandango, theaterSlug: undefined } };
  const scan = makeScan();
  scan.results[0].shows[2].hash = null;       // sold-out show 3, no hash
  const show = byId(buildReportModel(noSlug, scan))['3'];
  assert.equal(show.bookingUrl, 'https://www.fandango.com/theater-test1/theater-page');
});

test('trend: unchanged shows get delta 0; sold-out shows count as 0 usable', () => {
  const history = [
    { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 1, u: 2 }, 2: { p: 1, u: 4 }, 3: { p: 1, u: 2 } } },
    { at: '2026-07-19T12:00:00Z', kind: 'watch', shows: { 1: { p: 2, u: 4 } } },
  ];
  const s = byId(buildReportModel(cfg, makeScan(), history));
  assert.deepEqual(s['3'].trend, { isNew: false, wasUsable: 2, usableDelta: -2 }); // sold out: 0 now
  assert.deepEqual(s['2'].trend, { isNew: false, wasUsable: 4, usableDelta: -3 }); // 4 -> 1
  assert.deepEqual(s['4'].trend, { isNew: true, wasUsable: null, usableDelta: null });
});

test('a day is just-opened only when every show on it is new', () => {
  // Baseline saw show 4 but not the other Aug 3 show (id 50): the day mixes old and new.
  const scan = makeScan();
  scan.results[1].shows.push(makeShow({ id: 50, ticketingDate: '2026-08-03+20:00', type: 'soldout' }));
  const history = [
    { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 2, u: 4 }, 2: { p: 0, u: 1 }, 3: { p: 0, u: 0 }, 4: { p: 1, u: 6 } } },
    { at: '2026-07-19T12:00:00Z', kind: 'scan', shows: { 1: { p: 2, u: 4 } } },
  ];
  const m = buildReportModel(cfg, scan, history);
  assert.equal(m.days[1].shows.length, 2);
  assert.equal(m.days[1].justOpened, false);
  assert.equal(m.days[0].justOpened, false);
});

test('meta source is the scan source, defaulting to fandango', () => {
  const scan = makeScan();
  scan.source = 'manual';
  assert.equal(buildReportModel(cfg, scan).meta.source, 'manual');
  delete scan.source;
  assert.equal(buildReportModel(cfg, scan).meta.source, 'fandango');
});

test('meta movie: an explicit title wins, otherwise the match text', () => {
  const titled = { ...cfg, fandango: { ...cfg.fandango, movieTitle: 'Custom Cut' } };
  assert.equal(buildReportModel(titled, makeScan()).meta.movie, 'Custom Cut');
  const other = { ...cfg, fandango: { ...cfg.fandango, movieTitleMatch: 'Dune' } };
  assert.equal(buildReportModel(other, makeScan()).meta.movie, 'Dune');
});

test('meta direct booking passes through, null when unset', () => {
  const direct = { label: 'Regal', url: 'https://www.regmovies.com/x' };
  assert.deepEqual(buildReportModel({ ...cfg, directBooking: direct }, makeScan()).meta.directBooking, direct);
  assert.equal(model().meta.directBooking, null);
});
