// The classifier is the heart of the tool: if tier geometry or pair counting
// drifts, every report number is wrong. Row layout: 21 seats, cx = (n-1)/20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShow, practicality, rankShows } from '../src/classify.mjs';
import { cfg, auditorium, makeShow } from './helpers.mjs';

const analyze = (openByRow, accessibleByRow) =>
  analyzeShow(cfg, makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium(openByRow, accessibleByRow) }));

const tierOf = (a, id) => a.seats.find(s => s.id === id).tier;

test('front rows are excluded regardless of x position', () => {
  const a = analyze({ A: [11], B: [11], C: [11] });
  assert.equal(tierOf(a, 'A11'), 'front');
  assert.equal(tierOf(a, 'B11'), 'front');
  assert.equal(tierOf(a, 'C11'), 'front');
  assert.equal(a.counts.open.front, 3);
});

test('center window is row- and x-bounded, inclusive edges', () => {
  const a = analyze({ E: [6, 7, 15, 16], D: [11] });
  assert.equal(tierOf(a, 'E7'), 'center');    // cx 0.30 — inclusive lower edge
  assert.equal(tierOf(a, 'E15'), 'center');   // cx 0.70 — inclusive upper edge
  assert.equal(tierOf(a, 'E6'), 'midBack');   // cx 0.25 — outside window
  assert.equal(tierOf(a, 'E16'), 'midBack');  // cx 0.75
  assert.equal(tierOf(a, 'D11'), 'midBack');  // dead center but row D isn't a center row
});

test('flexible catches seats outside the mid-back window', () => {
  const a = analyze({ I: [1, 21], H: [2] });
  assert.equal(tierOf(a, 'I1'), 'flexible');  // cx 0.00 < 0.12
  assert.equal(tierOf(a, 'I21'), 'flexible'); // cx 1.00 > 0.88
  assert.equal(tierOf(a, 'H2'), 'flexible');  // cx 0.05
});

test('counts split open std / accessible open / sold', () => {
  const a = analyze({ E: [3, 8, 9] }, { E: [3] }); // E3 = open wheelchair
  assert.equal(a.counts.open.center, 2);
  assert.equal(a.counts.accessibleOpen, 1);
  assert.equal(a.counts.sold, 9 * 21 - 3);
  assert.equal(a.counts.total, 9 * 21);

  const b = analyze({ E: [8, 9] }, { E: [3] }); // reserved wheelchair counts as sold
  assert.equal(b.counts.accessibleOpen, 0);
  assert.equal(b.counts.sold, 9 * 21 - 2);
});

test('pairs: runs yield floor(len/2) non-overlapping pairs', () => {
  assert.equal(analyze({ E: [8, 9] }).duos.center, 1);
  assert.equal(analyze({ E: [8, 9, 10] }).duos.center, 1);        // third seat stranded
  assert.equal(analyze({ E: [8, 9, 10, 11] }).duos.center, 2);
  assert.equal(analyze({ E: [8, 9, 10, 11, 12] }).duos.center, 2);
});

test('pairs: non-adjacent open seats never pair', () => {
  const a = analyze({ E: [8, 10, 12] });
  assert.deepEqual(a.duos, { center: 0, midBack: 0, flexible: 0 });
});

test('pairs: an open accessible seat breaks a run (pairs must be standard)', () => {
  const a = analyze({ E: [8, 9, 10] }, { E: [9] });
  assert.deepEqual(a.duos, { center: 0, midBack: 0, flexible: 0 });
  assert.equal(a.counts.open.center, 2);
  assert.equal(a.counts.accessibleOpen, 1);
});

test('a pair takes the worse tier of its two seats', () => {
  // E6 (midBack, cx .25) + E7 (center, cx .30) — greedy pairing from run start.
  const a = analyze({ E: [6, 7] });
  assert.deepEqual(a.duos, { center: 0, midBack: 1, flexible: 0 });
});

test('pairs touching the front rows do not count at all', () => {
  const a = analyze({ B: [10, 11] });
  assert.deepEqual(a.duos, { center: 0, midBack: 0, flexible: 0 });
  assert.equal(a.counts.open.front, 2);
});

test('bestTier picks the best tier with at least one pair', () => {
  assert.equal(analyze({ E: [8, 9] }).bestTier, 'center');
  assert.equal(analyze({ D: [8, 9] }).bestTier, 'midBack');
  assert.equal(analyze({ I: [1, 2] }).bestTier, 'flexible');
  assert.equal(analyze({ E: [8] }).bestTier, null);
});

test('party size generalises: groups of N, non-overlapping, worst tier', () => {
  const cfg3 = { ...cfg, partySize: 3 };
  const analyze3 = (open) => analyzeShow(cfg3, makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium(open) }));
  assert.equal(analyze3({ E: [8, 9] }).duos.center, 0);              // 2 seats can't seat 3
  assert.equal(analyze3({ E: [8, 9, 10] }).duos.center, 1);
  assert.equal(analyze3({ E: [8, 9, 10, 11, 12] }).duos.center, 1);  // 5 seats -> 1 group, 2 stranded
  assert.equal(analyze3({ E: [8, 9, 10, 11, 12, 13] }).duos.center, 2);
  // Worst seat in the trio decides the tier: E6 (cx .25) is midBack.
  assert.deepEqual(analyze3({ E: [6, 7, 8] }).duos, { center: 0, midBack: 1, flexible: 0 });
});

test('party size 1: every usable open seat is a group', () => {
  const cfg1 = { ...cfg, partySize: 1 };
  const a = analyzeShow(cfg1, makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [8, 10], A: [1] }) }));
  assert.deepEqual(a.duos, { center: 2, midBack: 0, flexible: 0 }); // front seat still excluded
});

test('practicality: weekends and weekday evenings are doable', () => {
  assert.equal(practicality('2026-08-01+10:00'), 0); // Saturday morning
  assert.equal(practicality('2026-08-02+13:00'), 0); // Sunday afternoon
  assert.equal(practicality('2026-08-03+17:00'), 0); // Monday 5 PM — boundary
  assert.equal(practicality('2026-08-03+16:59'), 1); // Monday work hours
  assert.equal(practicality('2026-08-03+09:00'), 1);
});

test('rankShows: doable first, then tier, then pair count, then soonest', () => {
  const mk = (ticketingDate, bestTier, duos) => ({ ticketingDate, bestTier, duos });
  const weekdayCenter = mk('2026-08-03+13:00', 'center', { center: 2, midBack: 0, flexible: 0 });
  const weekendFlex1 = mk('2026-08-01+19:00', 'flexible', { center: 0, midBack: 0, flexible: 1 });
  const weekendFlex3 = mk('2026-08-02+19:00', 'flexible', { center: 0, midBack: 0, flexible: 3 });
  const weekendMid = mk('2026-08-08+19:00', 'midBack', { center: 0, midBack: 1, flexible: 0 });
  const ranked = rankShows([weekdayCenter, weekendFlex1, weekendFlex3, weekendMid]);
  // All weekend shows beat the weekday-work-hours center show; midBack beats
  // flexible; more pairs beats fewer; earlier date breaks the final tie.
  assert.deepEqual(ranked, [weekendMid, weekendFlex3, weekendFlex1, weekdayCenter]);
});

test('rankShows date tiebreak prefers the sooner show', () => {
  const mk = (t) => ({ ticketingDate: t, bestTier: 'flexible', duos: { center: 0, midBack: 0, flexible: 1 } });
  const a = mk('2026-08-01+19:00'), b = mk('2026-08-02+19:00');
  assert.deepEqual(rankShows([b, a]), [a, b]);
});

test('adjacency falls back to geometry when rightNeighbor is null', () => {
  // Some houses (AMC, some Regal) return rightNeighbor null; adjacency must then
  // come from geometry: same row, next seat within ~1.6 seat-widths of pitch.
  const mk = (id, x) => ({ id, x, y: 50, w: 13, h: 13, col: 0, status: 'A', type: 'standard', right: null });
  const pairs = (a) => a.duos.center + a.duos.midBack + a.duos.flexible;

  // Two adjacent seats (pitch ~1 width), no right link -> one pair from geometry.
  const adj = analyzeShow(cfg, { seatMap: { seats: [mk('F10', 100), mk('F11', 113)] } });
  assert.equal(pairs(adj), 1);

  // A wide aisle gap (pitch >> width) is not adjacency -> no pair.
  const gap = analyzeShow(cfg, { seatMap: { seats: [mk('F10', 100), mk('F11', 260)] } });
  assert.equal(pairs(gap), 0);
});
