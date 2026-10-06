import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEAT_STATES, SEAT_COLORS, TIERS, TIER_ORDER, seatCode } from '../src/report/theme.mjs';

test('SEAT_STATES codes match their array index (payload contract)', () => {
  // seatCode values are used as direct indexes into SEAT_COLORS in the browser.
  SEAT_STATES.forEach((s, i) => assert.equal(s.code, i, `state ${s.key}`));
  assert.equal(SEAT_COLORS.length, SEAT_STATES.length);
});

test('seatCode maps analysed seats to render codes', () => {
  assert.equal(seatCode({ open: false, std: true, tier: 'center' }), 0);   // taken wins
  assert.equal(seatCode({ open: true, std: false }), 5);                   // accessible open
  assert.equal(seatCode({ open: true, std: true, tier: 'front' }), 1);
  assert.equal(seatCode({ open: true, std: true, tier: 'flexible' }), 2);
  assert.equal(seatCode({ open: true, std: true, tier: 'midBack' }), 3);
  assert.equal(seatCode({ open: true, std: true, tier: 'center' }), 4);
});

test('TIER_ORDER is best-to-worst and ranks agree', () => {
  assert.deepEqual(TIER_ORDER, ['center', 'midBack', 'flexible']);
  assert.ok(TIERS.center.rank < TIERS.midBack.rank);
  assert.ok(TIERS.midBack.rank < TIERS.flexible.rank);
});

// ---- mutation-driven additions ----------------------------------------------
// Oracle: README "Colours live only in theme.mjs ... the legend, badges, and maps
// can't drift" and classify.mjs's tier order (center 0, midBack 1, flexible 2).
test('a tier rank is its position in TIER_ORDER, matching the classifier (0, 1, 2)', () => {
  TIER_ORDER.forEach((key, i) => assert.equal(TIERS[key].rank, i, key));
  assert.deepEqual(TIER_ORDER.map(k => TIERS[k].rank), [0, 1, 2]);
});

test('every tier is keyed by its own name', () => {
  assert.deepEqual(Object.keys(TIERS), TIER_ORDER);
  for (const [name, tier] of Object.entries(TIERS)) assert.equal(tier.key, name);
});

test('a tier shows the same colour and label in the legend as on the seat map', () => {
  for (const key of TIER_ORDER) {
    const state = SEAT_STATES.find(s => s.key === key);
    assert.equal(TIERS[key].color, state.color, key);
    assert.equal(TIERS[key].label, state.label, key);
  }
});

test('the seat code of an open standard seat lands on the state named after its tier', () => {
  for (const tier of ['front', 'flexible', 'midBack', 'center']) {
    const code = seatCode({ open: true, std: true, tier });
    assert.equal(SEAT_STATES[code].key, tier, tier);
  }
  assert.equal(SEAT_STATES[seatCode({ open: false, std: true, tier: 'center' })].key, 'taken');
  assert.equal(SEAT_STATES[seatCode({ open: true, std: false, tier: 'center' })].key, 'accessible');
});

test('seat colours are the state colours in code order', () => {
  assert.deepEqual(SEAT_COLORS, SEAT_STATES.map(s => s.color));
  assert.deepEqual(SEAT_STATES.map(s => s.key), ['taken', 'front', 'flexible', 'midBack', 'center', 'accessible']);
});
