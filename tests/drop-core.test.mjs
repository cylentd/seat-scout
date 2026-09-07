import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDates, calendarIsTheatreWide, snapshotFromDates, runEndOf,
  diffDrops, mergeSnapshot, probePlan, showKey,
} from '../src/scan-core.mjs';

// AMC showtimes carry no `id` — only ticketingDate/showtimeHashCode. Regal
// carries a numeric id. Both must key stably or the diff invents drops.
const amcShow = (tdate, type = 'available') => ({
  ticketingDate: tdate, showtimeHashCode: 'v2-' + tdate, type,
});
const regalShow = (id, tdate, type = 'available') => ({
  id, ticketingDate: tdate, hash: 'h' + id, type,
});

const snap = obj => ({ dates: obj });
const show = (id, time, type = 'available') => ({ id, timeLabel: time, type });

test('calendarDates reads the theatre-wide object shape Fandango actually serves', () => {
  const payload = {
    showtimeDates: ['2026-08-12', '2026-08-13'],
    calendar: [
      { full: '2026-08-13', hasShowtime: true },
      { full: '2026-08-14', hasShowtime: true },
      { full: '2026-08-15', hasShowtime: false },
    ],
  };
  assert.deepEqual(calendarDates(payload), ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.equal(calendarIsTheatreWide(payload), true);
});

test('calendarDates still reads the legacy per-film array shape and filters by hoCode', () => {
  const payload = [
    { hoCode: 'HO1', days: ['2026-08-01', '2026-08-02'] },
    { hoCode: 'HO2', days: ['2026-09-09'] },
  ];
  assert.deepEqual(calendarDates(payload), ['2026-08-01', '2026-08-02', '2026-09-09']);
  assert.deepEqual(calendarDates(payload, ['HO1']), ['2026-08-01', '2026-08-02']);
  assert.equal(calendarIsTheatreWide(payload), false);
});

test('calendarDates tolerates junk instead of throwing mid-scan', () => {
  for (const junk of [null, undefined, 42, 'nope', {}]) assert.deepEqual(calendarDates(junk), []);
});

test('runEndOf ignores the empty tail the scanner probes past the end of a run', () => {
  const s = snapshotFromDates([
    { date: '2026-08-11', shows: [show('1', '7:00p')] },
    { date: '2026-08-12', shows: [show('2', '7:00p')] },
    { date: '2026-08-13', shows: [] },
    { date: '2026-08-14', shows: [] },
  ]);
  assert.equal(runEndOf(s), '2026-08-12');
});

test('snapshotFromDates drops expired showtimes', () => {
  const s = snapshotFromDates([
    { date: '2026-08-11', shows: [show('1', '7:00p'), { ...show('2', '9:00p'), expired: true }] },
  ]);
  assert.deepEqual(s.dates['2026-08-11'].map(x => x.id), ['1']);
});

test('a run extension is reported as supply, not as returned seats', () => {
  const prev = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p')] }]);
  const cur = snapshotFromDates([{ date: '2026-08-19', shows: [show('9', '7:30p'), show('10', '11:00a')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.supply, 1);
  assert.equal(d.returns, 0);
  assert.equal(d.extended, true);
  assert.equal(d.prevRunEnd, '2026-08-12');
  assert.equal(d.runEnd, '2026-08-19');
  assert.deepEqual(d.newDates[0], { date: '2026-08-19', count: 2, times: ['7:30p', '11:00a'] });
});

test('a sold-out showtime coming back is a return, not supply', () => {
  const prev = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p', 'soldout')] }]);
  const cur = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p', 'available')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.returns, 1);
  assert.equal(d.supply, 0);
  assert.equal(d.extended, false);
  assert.deepEqual(d.freed[0], { date: '2026-08-12', id: '1', time: '7:00p' });
});

test('an extra screening added to a known date counts as supply, not a new date', () => {
  const prev = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p')] }]);
  const cur = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p'), show('2', '10:30p')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.newDates.length, 0);
  assert.equal(d.newShows.length, 1);
  assert.equal(d.supply, 1);
});

test('selling out is tracked but never counted as a drop', () => {
  const prev = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p', 'available')] }]);
  const cur = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p', 'soldout')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.lost.length, 1);
  assert.equal(d.supply + d.returns, 0);
});

test('dates absent from a partial check are not read as showtimes vanishing', () => {
  const prev = snapshotFromDates([
    { date: '2026-08-11', shows: [show('1', '7:00p')] },
    { date: '2026-08-12', shows: [show('2', '7:00p')] },
  ]);
  // A watcher that only probed the 12th must not claim anything about the 11th.
  const cur = snapshotFromDates([{ date: '2026-08-12', shows: [show('2', '7:00p')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.supply + d.returns + d.lost.length, 0);
  assert.equal(d.runEnd, '2026-08-12');
});

test('a failed probe (date omitted) cannot shrink the recorded run', () => {
  const prev = snapshotFromDates([{ date: '2026-08-12', shows: [show('1', '7:00p')] }]);
  const merged = mergeSnapshot(prev, snapshotFromDates([]));
  assert.equal(runEndOf(merged), '2026-08-12');
});

test('mergeSnapshot overwrites probed dates and carries unprobed ones forward', () => {
  const prev = snapshotFromDates([
    { date: '2026-08-11', shows: [show('1', '7:00p')] },
    { date: '2026-08-12', shows: [show('2', '7:00p')] },
  ]);
  const cur = snapshotFromDates([{ date: '2026-08-12', shows: [] }]);
  const m = mergeSnapshot(prev, cur);
  assert.equal(m.dates['2026-08-11'].length, 1);
  assert.equal(m.dates['2026-08-12'].length, 0);
});

test('probePlan looks past the run end and re-checks the next few days', () => {
  const plan = probePlan({ today: '2026-07-20', runEnd: '2026-08-12', aheadDays: 3, recheckDays: 2 });
  assert.deepEqual(plan, ['2026-07-20', '2026-07-21', '2026-08-13', '2026-08-14', '2026-08-15']);
});

test('probePlan skips dates the theatre has no showtimes on at all', () => {
  const plan = probePlan({
    today: '2026-07-20', runEnd: '2026-08-12', aheadDays: 3, recheckDays: 0,
    calendar: ['2026-08-13', '2026-08-15'],
  });
  assert.deepEqual(plan, ['2026-08-13', '2026-08-15']);
});

test('showKey identifies AMC showtimes, which carry no id field', () => {
  // Regression: String(s.id) yielded "undefined" for every AMC show, so they
  // all aliased together and each run reported the whole day as new.
  const a = amcShow('2026-07-22+06:00');
  const b = amcShow('2026-07-22+10:00');
  assert.equal(showKey(a), '2026-07-22+06:00');
  assert.notEqual(showKey(a), showKey(b));
  assert.ok(!String(showKey(a)).includes('undefined'));
});

test('showKey is stable for Regal showtimes too', () => {
  assert.equal(showKey(regalShow(549331797, '2026-08-12+19:00')), '2026-08-12+19:00');
});

test('an unchanged AMC day produces no drops across runs', () => {
  const day = [amcShow('2026-07-22+06:00'), amcShow('2026-07-22+10:00'), amcShow('2026-07-22+14:00')];
  const prev = snapshotFromDates([{ date: '2026-07-22', shows: day }]);
  const cur = snapshotFromDates([{ date: '2026-07-22', shows: day }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.supply, 0, 'unchanged AMC day must not report supply');
  assert.equal(d.returns, 0);
});

test('a genuinely added AMC screening is still detected', () => {
  const prev = snapshotFromDates([{ date: '2026-07-22', shows: [amcShow('2026-07-22+06:00')] }]);
  const cur = snapshotFromDates([{ date: '2026-07-22', shows: [amcShow('2026-07-22+06:00'), amcShow('2026-07-22+22:00')] }]);
  const d = diffDrops(prev, cur);
  assert.equal(d.newShows.length, 1);
  assert.equal(d.newShows[0].id, '2026-07-22+22:00');
});

test('shows with no derivable identity are dropped, not stored as "undefined"', () => {
  const s = snapshotFromDates([{ date: '2026-07-22', shows: [{ type: 'available' }, amcShow('2026-07-22+06:00')] }]);
  assert.equal(s.dates['2026-07-22'].length, 1);
  assert.ok(s.dates['2026-07-22'].every(x => x.id && x.id !== 'undefined'));
});

test('probePlan never probes the past, even with a stale run end', () => {
  const plan = probePlan({ today: '2026-07-20', runEnd: '2026-06-01', aheadDays: 3, recheckDays: 2 });
  assert.ok(plan.every(d => d >= '2026-07-20'), plan.join(','));
});
