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

// ---- mutation-driven additions ----------------------------------------------
// Hand-built seat maps. `seat` is an open standard seat with no right link.
const seat = (id, x, y, extra = {}) =>
  ({ id, x, y, w: 8, h: 8, col: 0, status: 'A', type: 'standard', right: null, ...extra });
const withTiers = (over) => ({ ...cfg, tiers: { ...cfg.tiers, ...over } });
const tierIn = (config, seats, id) =>
  analyzeShow(config, { seatMap: { seats } }).seats.find(s => s.id === id).tier;
const pairCount = (a) => a.duos.center + a.duos.midBack + a.duos.flexible;

// 9-row house, every row has seats at the given x values (rows A..I, y = 10 per row).
const grid = (xs) => [...'ABCDEFGHI'].flatMap((row, ri) => xs.map((x, i) => seat(`${row}${i + 1}`, x, ri * 10)));

test('row depth follows mean y, not the order seats are listed in', () => {
  // Depth 0 = the row nearest the screen (lowest mean y). B has one seat at y 5,
  // A has four at y 5.5, so B is the front row even though A is listed first.
  const a = [10, 20, 30, 40].map((x, i) => seat(`A${i + 1}`, x, 5.5));
  assert.equal(tierIn(cfg, [...a, seat('B1', 25, 5)], 'B1'), 'front');
  assert.notEqual(tierIn(cfg, [...a, seat('B1', 25, 5)], 'A1'), 'front');
  // Reverse case: Y has four seats at y 4.9, X one seat at y 5, so Y is the front row.
  const y = [10, 20, 30, 40].map((x, i) => seat(`Y${i + 1}`, x, 4.9));
  assert.equal(tierIn(cfg, [seat('X1', 25, 5), ...y], 'Y1'), 'front');
  assert.notEqual(tierIn(cfg, [seat('X1', 25, 5), ...y], 'X1'), 'front');
});

test('two rows span the full depth scale: the front row is front, the back row is not', () => {
  const seats = [seat('A1', 0, 0), seat('A2', 100, 0), seat('B1', 0, 10), seat('B2', 100, 10)];
  assert.equal(tierIn(cfg, seats, 'A1'), 'front');   // depth 0
  assert.notEqual(tierIn(cfg, seats, 'B1'), 'front'); // depth 1
});

test('a one-row house sits at mid depth (0.5), so its middle seats are center', () => {
  // Pinned from code, no README rule: depth 0.5 clears frontFrac .30 and lies
  // inside the center row window .44-.80.
  const seats = [seat('A1', 0, 0), seat('A2', 100, 0), seat('A3', 200, 0)];
  assert.equal(tierIn(cfg, seats, 'A2'), 'center');
});

test('x position is measured from the leftmost seat, not from x = 0', () => {
  const shifted = auditorium({ E: [6, 7, 15, 16], I: [1, 21] }).map(s => ({ ...s, x: s.x + 1000 }));
  const a = analyzeShow(cfg, { seatMap: { seats: shifted } });
  const t = (id) => a.seats.find(s => s.id === id).tier;
  assert.equal(t('E7'), 'center');    // cx 0.30
  assert.equal(t('E15'), 'center');   // cx 0.70
  assert.equal(t('E6'), 'midBack');   // cx 0.25
  assert.equal(t('E16'), 'midBack');  // cx 0.75
  assert.equal(t('I1'), 'flexible');  // cx 0.00
  assert.equal(t('I21'), 'flexible'); // cx 1.00
});

test('a house only one pixel wide still normalises x to 0..1', () => {
  // x = 0 and x = 1: the right-hand seat is at cx 1.00, past the mid-back window (.88).
  const seats = grid([0, 1]);
  assert.equal(tierIn(cfg, seats, 'D2'), 'flexible');
  assert.equal(tierIn(cfg, seats, 'D1'), 'flexible');
});

test('front boundary: a row exactly at frontFrac is not front', () => {
  // 9 rows: depth of row C = 2/8 = 0.25 exactly.
  const house = auditorium({ C: [11] });
  const at = (config) => analyzeShow(config, makeShow({ id: 1, ticketingDate: 'x', seats: house })).seats.find(s => s.id === 'C11').tier;
  assert.equal(at(withTiers({ frontFrac: 0.25 })), 'flexible'); // 0.25 < 0.25 is false; below midBack.rowMin .30
  assert.equal(at(withTiers({ frontFrac: 0.26 })), 'front');
});

test('center row window is inclusive at both ends', () => {
  const house = auditorium({ E: [11], G: [11] }); // E depth 4/8 = .50, G depth 6/8 = .75
  const tier = (config, id) => analyzeShow(config, makeShow({ id: 1, ticketingDate: 'x', seats: house })).seats.find(s => s.id === id).tier;
  assert.equal(tier(withTiers({ center: { ...cfg.tiers.center, rowMin: 0.5 } }), 'E11'), 'center');
  assert.equal(tier(withTiers({ center: { ...cfg.tiers.center, rowMin: 0.51 } }), 'E11'), 'midBack');
  assert.equal(tier(withTiers({ center: { ...cfg.tiers.center, rowMax: 0.75 } }), 'G11'), 'center');
  assert.equal(tier(withTiers({ center: { ...cfg.tiers.center, rowMax: 0.74 } }), 'G11'), 'midBack');
});

test('mid-back window is inclusive at its row and x edges', () => {
  // Row D: depth 3/8 = .375, never a center row. D6 sits at cx .25, D16 at cx .75.
  const house = auditorium({ D: [6, 11, 16] });
  const tier = (config, id) => analyzeShow(config, makeShow({ id: 1, ticketingDate: 'x', seats: house })).seats.find(s => s.id === id).tier;
  const mb = (over) => withTiers({ midBack: { ...cfg.tiers.midBack, ...over } });
  assert.equal(tier(mb({ rowMin: 0.375 }), 'D11'), 'midBack');
  assert.equal(tier(mb({ rowMin: 0.376 }), 'D11'), 'flexible');
  assert.equal(tier(mb({ xMin: 0.25 }), 'D6'), 'midBack');
  assert.equal(tier(mb({ xMin: 0.26 }), 'D6'), 'flexible');
  assert.equal(tier(mb({ xMax: 0.75 }), 'D16'), 'midBack');
  assert.equal(tier(mb({ xMax: 0.74 }), 'D16'), 'flexible');
});

test('a seat id with no row letter is treated as a back-row seat, never front', () => {
  // Pinned from code, no README rule: unknown row -> depth 1.
  const odd = { id: 'xx', x: 100, y: 0, w: 8, h: 8, col: 0, status: 'A', type: 'standard', right: null };
  const seats = [...auditorium(), odd];
  assert.equal(tierIn(cfg, seats, 'xx'), 'midBack');                                   // depth 1, centre x
  assert.equal(tierIn(withTiers({ center: { ...cfg.tiers.center, rowMax: 1 } }), seats, 'xx'), 'center');
});

test('counts start at zero for every tier', () => {
  const a = analyze({});
  assert.deepEqual(a.counts.open, { center: 0, midBack: 0, flexible: 0, front: 0 });
  assert.equal(a.counts.accessibleOpen, 0);
  assert.equal(a.counts.sold, 189);
});

test('open seats are counted into their own tier', () => {
  const a = analyze({ E: [8], D: [8], I: [1], A: [8] });
  assert.deepEqual(a.counts.open, { center: 1, midBack: 1, flexible: 1, front: 1 });
});

test('a show with no seat map analyses to nothing, not an error', () => {
  const a = analyzeShow(cfg, { id: 9, type: 'soldout' });
  assert.equal(a.id, 9);
  assert.deepEqual(a.seats, []);
  assert.equal(a.counts.total, 0);
  assert.deepEqual(a.duos, { center: 0, midBack: 0, flexible: 0 });
  assert.equal(a.bestTier, null);
});

test('each decorated seat carries tier, open and std flags and keeps its own fields', () => {
  const a = analyze({ E: [8] }, { E: [3] });
  const e8 = a.seats.find(s => s.id === 'E8');
  assert.equal(e8.open, true);
  assert.equal(e8.std, true);
  assert.equal(e8.tier, 'center');
  assert.equal(e8.x, 70);
  const e3 = a.seats.find(s => s.id === 'E3');
  assert.equal(e3.open, false);   // reserved wheelchair seat
  assert.equal(e3.std, false);
});

test('without a partySize the classifier counts pairs', () => {
  for (const partySize of [undefined, 0]) {
    const show = makeShow({ id: 1, ticketingDate: 'x', seats: auditorium({ E: [8, 9, 10] }) });
    assert.equal(analyzeShow({ ...cfg, partySize }, show).duos.center, 1, `partySize ${partySize}`);
  }
});

test('bestTier falls to the next tier only when the better ones have no group', () => {
  assert.equal(analyze({ E: [8, 9], D: [8, 9], I: [1, 2] }).bestTier, 'center');
  assert.equal(analyze({ D: [8, 9], I: [1, 2] }).bestTier, 'midBack');
  assert.equal(analyze({ I: [1, 2], E: [8] }).bestTier, 'flexible');
});

test('pairs: a group in a later tier counts once per run, in its own tier', () => {
  const a = analyze({ E: [8, 9], D: [8, 9], I: [1, 2] });
  assert.deepEqual(a.duos, { center: 1, midBack: 1, flexible: 1 });
});

test('pairs: a sold seat before an open run does not hide the run', () => {
  const a = analyze({ E: [9, 10] }); // E8 is reserved and its right neighbour E9 is open
  assert.equal(a.duos.center, 1);
});

test('pairs: an accessible seat splits a run but the seats after it still pair', () => {
  const a = analyze({ E: [8, 9, 10, 11] }, { E: [9] }); // E8 | E9 wheelchair | E10 E11
  assert.deepEqual(a.duos, { center: 1, midBack: 0, flexible: 0 });
});

test('pairs: seats listed out of order are still linked by their right neighbour', () => {
  const full = auditorium({ E: [8, 9, 10, 11] });
  const shuffled = [...full].reverse();
  assert.equal(analyzeShow(cfg, { seatMap: { seats: shuffled } }).duos.center, 2);
});

test('adjacency: an API rightNeighbor wins over geometry', () => {
  // 100 px apart is no geometric neighbour, but the API says F2 sits right of F1.
  const linked = [seat('F1', 0, 50, { right: 'F2' }), seat('F2', 100, 50)];
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats: linked } })), 1);
});

test('adjacency: a rightNeighbor naming a seat that does not exist falls back to geometry', () => {
  const seats = [seat('F10', 100, 50, { right: 'ZZ99', w: 13 }), seat('F11', 110, 50, { w: 13 })];
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats } })), 1);
});

test('adjacency: geometry orders seats by x, whatever order they are listed in', () => {
  const seats = [seat('F11', 110, 50), seat('F10', 100, 50)];
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats } })), 1);
});

test('adjacency: the geometric limit is 1.6 seat widths of pitch, inclusive', () => {
  const at = (pitch) => pairCount(analyzeShow(cfg, { seatMap: { seats: [seat('F10', 100, 50, { w: 10 }), seat('F11', 100 + pitch, 50, { w: 10 })] } }));
  assert.equal(at(16), 1);  // exactly 1.6 x 10
  assert.equal(at(17), 0);
  assert.equal(at(0), 0);   // two seats on the same x are not neighbours
});

test('adjacency: a seat with no width is measured against a width of 1', () => {
  const at = (pitch) => pairCount(analyzeShow(cfg, { seatMap: { seats: [seat('F10', 100, 50, { w: 0 }), seat('F11', 100 + pitch, 50, { w: 0 })] } }));
  assert.equal(at(1), 1);
  assert.equal(at(2), 0);
});

test('adjacency: a curved row (y varies by seat) still links along the row letter', () => {
  const seats = [0, 10, 20, 30].map((x, i) => seat(`F${i + 1}`, x, 50 + (i % 2) * 3));
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats } })), 2);
});

test('adjacency: seats without a row letter group by rounded y line', () => {
  const lone = [seat('a1', 100, 50), seat('a2', 110, 70), seat('a3', 120, 50)];
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats: lone } })), 0); // a1 and a3 are 20px apart on y 50
  const sameLine = [seat('a1', 100, 49.6), seat('a2', 110, 50.4)];            // both round to y 50
  assert.equal(pairCount(analyzeShow(cfg, { seatMap: { seats: sameLine } })), 1);
});

test('practicality: Friday is a weekday, late nights and weekend nights are doable', () => {
  assert.equal(practicality('2026-08-07+10:00'), 1); // Friday morning
  assert.equal(practicality('2026-08-07+17:00'), 0); // Friday 5 PM
  assert.equal(practicality('2026-08-07+16:59'), 1);
  assert.equal(practicality('2026-08-03+00:30'), 1); // Monday just after midnight
  assert.equal(practicality('2026-08-03+23:00'), 0);
  assert.equal(practicality('2026-08-01+23:00'), 0); // Saturday night
  assert.equal(practicality('2026-08-02+00:30'), 0); // Sunday just after midnight
});

test('rankShows: a show with no group ranks after any show that has one', () => {
  const none = { ticketingDate: '2026-08-01+19:00', bestTier: null, duos: { center: 0, midBack: 0, flexible: 0 } };
  const flex = { ticketingDate: '2026-08-02+19:00', bestTier: 'flexible', duos: { center: 0, midBack: 0, flexible: 1 } };
  assert.deepEqual(rankShows([none, flex]), [flex, none]);
});

test('rankShows: pair count adds up every tier, not just the best one', () => {
  // Same best tier; a has 1 center + 2 flexible = 3 groups, b has 2 center = 2.
  const a = { ticketingDate: '2026-08-02+19:00', bestTier: 'center', duos: { center: 1, midBack: 0, flexible: 2 } };
  const b = { ticketingDate: '2026-08-01+19:00', bestTier: 'center', duos: { center: 2, midBack: 0, flexible: 0 } };
  assert.deepEqual(rankShows([b, a]), [a, b]);
  const c = { ticketingDate: '2026-08-02+19:00', bestTier: 'center', duos: { center: 1, midBack: 2, flexible: 0 } };
  assert.deepEqual(rankShows([b, c]), [c, b]); // midBack groups count too
});

test('rankShows: center beats mid-back regardless of pair count', () => {
  const center1 = { ticketingDate: '2026-08-02+19:00', bestTier: 'center', duos: { center: 1, midBack: 0, flexible: 0 } };
  const mid5 = { ticketingDate: '2026-08-01+19:00', bestTier: 'midBack', duos: { center: 0, midBack: 5, flexible: 0 } };
  assert.deepEqual(rankShows([mid5, center1]), [center1, mid5]);
});

test('rankShows returns a new array and leaves its input order alone', () => {
  const a = { ticketingDate: '2026-08-02+19:00', bestTier: 'flexible', duos: { center: 0, midBack: 0, flexible: 1 } };
  const b = { ticketingDate: '2026-08-01+19:00', bestTier: 'flexible', duos: { center: 0, midBack: 0, flexible: 1 } };
  const input = [a, b];
  const out = rankShows(input);
  assert.deepEqual(input, [a, b]);
  assert.notEqual(out, input);
});
