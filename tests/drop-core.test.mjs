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

// ---- mutation-driven additions ----------------------------------------------
// Oracle: README "Drop watch": run extended (supply) vs seats returned, aheadDays
// past the last showtime + recheckDays from today (about 14 requests per theatre).
const time = (id, t, type = 'available') => ({ id, time: t, type });

test('calendarDates cuts timestamps to the date, sorts, and merges both fields of the object shape', () => {
  const payload = {
    showtimeDates: ['2026-08-14T00:00:00', '2026-08-12T09:30:00'],
    calendar: [{ full: '2026-08-13T00:00:00', hasShowtime: true }, { full: '2026-08-12T00:00:00', hasShowtime: true }],
  };
  assert.deepEqual(calendarDates(payload), ['2026-08-12', '2026-08-13', '2026-08-14']);
});

test('calendarDates ignores calendar days with no showtime, no date, or no entry', () => {
  const payload = { calendar: [null, { hasShowtime: true }, { full: '2026-08-15', hasShowtime: false }, { full: '2026-08-16' }, { full: '2026-08-17', hasShowtime: true }] };
  assert.deepEqual(calendarDates(payload), ['2026-08-17']);
});

test('calendarDates on the object shape ignores hoCodes, an empty hoCodes list means all films', () => {
  assert.deepEqual(calendarDates({ showtimeDates: ['2026-08-12'] }, ['HO1']), ['2026-08-12']);
  const arr = [{ hoCode: 'HO1', days: ['2026-08-01'] }, { hoCode: 'HO2', days: ['2026-08-02'] }];
  assert.deepEqual(calendarDates(arr, []), ['2026-08-01', '2026-08-02']);
  assert.deepEqual(calendarDates(arr, ['HO9']), []);
});

test('calendarDates on the array shape cuts timestamps, merges duplicates and tolerates entries with no days', () => {
  const arr = [{ hoCode: 'HO1', days: ['2026-08-02T00:00:00', '2026-08-01T00:00:00'] }, { hoCode: 'HO2' }, { hoCode: 'HO3', days: ['2026-08-02T10:00:00'] }];
  assert.deepEqual(calendarDates(arr), ['2026-08-01', '2026-08-02']);
});

test('showKey prefers ticketingDate, then showtimeHashCode, then hash, then id, as text', () => {
  assert.equal(showKey({ ticketingDate: 'T', showtimeHashCode: 'S', hash: 'H', id: 1 }), 'T');
  assert.equal(showKey({ showtimeHashCode: 'S', hash: 'H', id: 1 }), 'S');
  assert.equal(showKey({ hash: 'H', id: 1 }), 'H');
  assert.equal(showKey({ id: 549331797 }), '549331797');
  assert.equal(showKey({ id: 0 }), '0');          // zero is an identity, not "missing"
  assert.equal(showKey({}), null);
});

test('snapshotFromDates stores id, time and type for each date', () => {
  const s = snapshotFromDates([
    { date: '2026-08-11', shows: [{ ticketingDate: 'k1', timeLabel: '7:00p', time: 'ignored', type: 'soldout' }, { ticketingDate: 'k2', time: '9:00p' }, { ticketingDate: 'k3' }] },
    { date: '2026-08-12', shows: undefined },
  ]);
  assert.deepEqual(s, { dates: {
    '2026-08-11': [
      { id: 'k1', time: '7:00p', type: 'soldout' },
      { id: 'k2', time: '9:00p', type: 'available' },   // no type means available
      { id: 'k3', time: null, type: 'available' },
    ],
    '2026-08-12': [],
  } });
});

test('runEndOf takes the latest played date whatever order dates were stored in, and null for none', () => {
  assert.equal(runEndOf(snap({ '2026-08-20': [time('a', 't')], '2026-08-11': [time('b', 't')], '2026-08-25': [] })), '2026-08-20');
  assert.equal(runEndOf(snap({ '2026-08-20': null, '2026-08-11': [time('b', 't')] })), '2026-08-11');
  assert.equal(runEndOf(snap({ '2026-08-20': [] })), null);
  assert.equal(runEndOf(null), null);
  assert.equal(runEndOf({}), null);
});

test('diffDrops reports every kind of change, each with its date, id and time', () => {
  const prev = snap({
    '2026-08-10': [time('a', '1:00p', 'available'), time('b', '4:00p', 'soldout')],
    '2026-08-11': [time('c', '7:00p', 'available')],
  });
  const cur = snap({
    '2026-08-12': [time('x', '7:30p'), time('y', null)],     // never seen: the run reaches further
    '2026-08-10': [time('a', '1:00p', 'soldout'), time('b', '4:00p', 'available'), time('n', '9:00p')],
    '2026-08-11': [],                                         // empty: not checked, not "vanished"
  });
  assert.deepEqual(diffDrops(prev, cur), {
    newDates: [{ date: '2026-08-12', count: 2, times: ['7:30p'] }],   // the null time is left out of the list
    newShows: [{ date: '2026-08-10', id: 'n', time: '9:00p' }],
    freed: [{ date: '2026-08-10', id: 'b', time: '4:00p' }],
    lost: [{ date: '2026-08-10', id: 'a', time: '1:00p' }],
    prevRunEnd: '2026-08-11', runEnd: '2026-08-12', extended: true,
    supply: 2, returns: 1,
  });
});

test('diffDrops: new dates are reported in date order, not in the order they were probed', () => {
  const prev = snap({ '2026-08-10': [time('a', 't')] });
  const cur = snap({ '2026-08-20': [time('x', 't')], '2026-08-12': [time('y', 't')], '2026-08-15': [time('z', 't')] });
  assert.deepEqual(diffDrops(prev, cur).newDates.map(d => d.date), ['2026-08-12', '2026-08-15', '2026-08-20']);
});

test('diffDrops: a date that was probed empty and now has showtimes is a new date, not extra screenings', () => {
  const prev = snap({ '2026-08-10': [time('a', 't')], '2026-08-11': [] });
  const cur = snap({ '2026-08-11': [time('b', 't')] });
  const d = diffDrops(prev, cur);
  assert.deepEqual(d.newDates.map(x => x.date), ['2026-08-11']);
  assert.equal(d.newShows.length, 0);
  assert.equal(d.extended, true);
});

test('diffDrops: an unchanged status is no news, and the run end only counts as extended when it moves later', () => {
  const same = snap({ '2026-08-12': [time('a', 't', 'soldout'), time('b', 't', 'available')] });
  const d = diffDrops(same, same);
  assert.deepEqual([d.supply, d.returns, d.lost.length, d.freed.length], [0, 0, 0, 0]);
  assert.equal(d.extended, false);          // equal end: not extended
  assert.equal(d.runEnd, '2026-08-12');
});

test('diffDrops: a first run has no previous end, so nothing counts as extended', () => {
  const d = diffDrops(null, snap({ '2026-08-12': [time('a', 't')] }));
  assert.equal(d.prevRunEnd, null);
  assert.equal(d.extended, false);
  assert.equal(d.newDates.length, 1);
});

test('diffDrops: a missing current snapshot reports nothing and keeps the old run end', () => {
  const prev = snap({ '2026-08-12': [time('a', 't')] });
  for (const cur of [null, undefined]) {
    const d = diffDrops(prev, cur);
    assert.equal(d.supply + d.returns + d.lost.length, 0);
    assert.equal(d.runEnd, '2026-08-12');
  }
});

test('mergeSnapshot copes with a missing side and does not edit either input', () => {
  const prev = snap({ '2026-08-11': [time('a', 't')] });
  const cur = snap({ '2026-08-12': [time('b', 't')] });
  assert.deepEqual(Object.keys(mergeSnapshot(prev, cur).dates), ['2026-08-11', '2026-08-12']);
  assert.deepEqual(mergeSnapshot(null, cur), cur);
  assert.deepEqual(mergeSnapshot(prev, undefined), prev);
  assert.deepEqual(mergeSnapshot(undefined, undefined), { dates: {} });
  assert.deepEqual(Object.keys(prev.dates), ['2026-08-11']);
  assert.deepEqual(Object.keys(cur.dates), ['2026-08-12']);
});

test('probePlan defaults to 10 days past the run end plus 4 from today (14 requests, README)', () => {
  const plan = probePlan({ today: '2026-07-20', runEnd: '2026-08-12' });
  assert.deepEqual(plan, [
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
    '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17',
    '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22',
  ]);
});

test('probePlan with no known run end starts looking at today', () => {
  assert.deepEqual(probePlan({ today: '2026-07-20', runEnd: null, aheadDays: 3, recheckDays: 0 }), ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('probePlan: a run ending today looks from tomorrow, one that ended yesterday from today', () => {
  assert.deepEqual(probePlan({ today: '2026-07-20', runEnd: '2026-07-20', aheadDays: 2, recheckDays: 1 }), ['2026-07-20', '2026-07-21', '2026-07-22']);
  assert.deepEqual(probePlan({ today: '2026-07-20', runEnd: '2026-07-19', aheadDays: 2, recheckDays: 0 }), ['2026-07-20', '2026-07-21']);
});

test('probePlan with a stale run end probes exactly the days from today, once each', () => {
  assert.deepEqual(probePlan({ today: '2026-07-20', runEnd: '2026-06-01', aheadDays: 3, recheckDays: 2 }), ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('probePlan lists a day once when the run end is close and the windows overlap', () => {
  assert.deepEqual(probePlan({ today: '2026-07-20', runEnd: '2026-07-21', aheadDays: 2, recheckDays: 4 }),
    ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']);
});

test('probePlan: a calendar narrows both windows, and an empty calendar narrows nothing', () => {
  const args = { today: '2026-07-20', runEnd: '2026-08-12', aheadDays: 3, recheckDays: 2 };
  assert.deepEqual(probePlan({ ...args, calendar: ['2026-07-21', '2026-08-13', '2026-09-30', '2026-07-01'] }), ['2026-07-21', '2026-08-13']);
  assert.equal(probePlan({ ...args, calendar: [] }).length, 5);
});
