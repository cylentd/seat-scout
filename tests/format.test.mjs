import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicketingDate, fmtShowtime, partOfDay, pct } from '../src/report/format.mjs';

test('parseTicketingDate splits a Fandango wall time by hand', () => {
  assert.deepEqual(parseTicketingDate('2026-07-25+19:30'),
    { y: 2026, m: 7, d: 25, hh: 19, mm: 30, dateISO: '2026-07-25' });
});

test('fmtShowtime formats day and 12-hour time', () => {
  const t = fmtShowtime('2026-08-01+19:05');
  assert.equal(t.dateISO, '2026-08-01');
  assert.equal(t.dow, 'Sat');
  assert.equal(t.dayLabel, 'Sat Aug 1');
  assert.equal(t.timeLabel, '7:05 PM');
  assert.equal(t.hour, 19);
});

test('fmtShowtime handles midnight and noon', () => {
  assert.equal(fmtShowtime('2026-08-03+00:05').timeLabel, '12:05 AM');
  assert.equal(fmtShowtime('2026-08-03+12:00').timeLabel, '12:00 PM');
  assert.equal(fmtShowtime('2026-08-03+23:59').timeLabel, '11:59 PM');
});

test('fmtShowtime pads minutes', () => {
  assert.equal(fmtShowtime('2026-08-03+14:05').timeLabel, '2:05 PM');
});

test('partOfDay bucket boundaries', () => {
  assert.equal(partOfDay(0), 'morning');
  assert.equal(partOfDay(11), 'morning');
  assert.equal(partOfDay(12), 'afternoon');
  assert.equal(partOfDay(16), 'afternoon');
  assert.equal(partOfDay(17), 'evening');
  assert.equal(partOfDay(20), 'evening');
  assert.equal(partOfDay(21), 'late');
  assert.equal(partOfDay(23), 'late');
});

test('pct rounds and survives zero total', () => {
  assert.equal(pct(1, 3), 33);
  assert.equal(pct(2, 3), 67);
  assert.equal(pct(0, 0), 0);
  assert.equal(pct(5, 0), 0);
});
