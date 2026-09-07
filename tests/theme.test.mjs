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
