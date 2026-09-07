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
