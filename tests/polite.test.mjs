import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolitenessBudget } from '../src/polite.mjs';

// Tiny intervals so the tests run in milliseconds; the logic under test is the
// burst/rest rhythm and the config shapes, not wall-clock accuracy.

test('burst budget: quick within a burst, long rest between bursts', async () => {
  const b = new PolitenessBudget({ burstSize: 3, burstIntervalMs: 5, burstRestMs: 120, jitter: 0, maxPerMinute: 1000 });
  const gaps = [];
  let prev = Date.now();
  for (let i = 0; i < 5; i++) {
    await b.beforeRequest();
    const now = Date.now();
    gaps.push(now - prev);
    prev = now;
  }
  // Requests 2–3 ride the burst; request 4 pays the rest; 5 starts a new burst.
  assert.ok(gaps[1] < 60, `intra-burst gap was ${gaps[1]}ms`);
  assert.ok(gaps[2] < 60, `intra-burst gap was ${gaps[2]}ms`);
  assert.ok(gaps[3] >= 100, `rest gap was only ${gaps[3]}ms`);
  assert.ok(gaps[4] < 60, `post-rest gap was ${gaps[4]}ms`);
});

test('a natural pause counts as the rest and refills the burst', async () => {
  const b = new PolitenessBudget({ burstSize: 2, burstIntervalMs: 5, burstRestMs: 40, jitter: 0, maxPerMinute: 1000 });
  await b.beforeRequest();
  await b.beforeRequest();                      // burst spent
  await new Promise(r => setTimeout(r, 60));    // caller was busy longer than the rest
  const t = Date.now();
  await b.beforeRequest();                      // should NOT pay the rest again
  assert.ok(Date.now() - t < 30, 'rest was double-charged after a natural pause');
});

test('legacy minIntervalMs config still paces uniformly', () => {
  const b = new PolitenessBudget({ minIntervalMs: 2000 });
  assert.equal(b.burstSize, 1);                 // every request is rest-paced
  assert.equal(b.burstRestMs, 2000);
});

test('explicit burst config wins over legacy fields', () => {
  const b = new PolitenessBudget({ burstSize: 5, burstRestMs: 9000, minIntervalMs: 2000 });
  assert.equal(b.burstSize, 5);
  assert.equal(b.burstRestMs, 9000);
});
