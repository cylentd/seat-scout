// The politeness budget is what keeps the home IP in Fandango's good graces: burst
// pacing, a rolling per-minute ceiling, Retry-After backpressure and an off-peak
// window (README "Politeness budget"). Every wait runs on node:test's fake clock
// (setTimeout + Date), so each expected time is exact and the suite never sleeps.
// Expected values are worked by hand from the config in each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolitenessBudget } from '../src/polite.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Local wall-clock instants on a day with no DST change, so getHours() is exact.
const at = (h, m = 0, s = 0) => new Date(2026, 9, 6, h, m, s).getTime();
const NOON = at(12);

const fakeClock = (t, now = NOON) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });

// Lets every pending promise reaction run; setImmediate is not faked.
const flush = () => new Promise(res => setImmediate(res));

// Drive one call on the fake clock: fire each pending timer in turn until the call
// settles. Returns the fake ms it waited, or Infinity if still waiting past capMs.
async function waitOf(t, call, capMs = 2 * DAY) {
  const start = Date.now();
  let done = false;
  let failure = null;
  call().then(() => { done = true; }, err => { failure = err; });
  for (let i = 0; i < 10000; i++) {
    await flush();
    if (failure) throw failure;
    if (done) return Date.now() - start;
    if (Date.now() - start >= capMs) return Infinity;
    t.mock.timers.runAll();
  }
  return Infinity;
}

// Send times (ms after the first call) for a run of requests. idles[i] is how long
// the caller was busy before asking for request i (0 = asks again at once).
async function sendTimes(t, budget, idles) {
  const t0 = Date.now();
  const times = [];
  for (const idle of idles) {
    if (idle) t.mock.timers.tick(idle);
    await waitOf(t, () => budget.beforeRequest());
    times.push(Date.now() - t0);
  }
  return times;
}

const back2back = n => Array(n).fill(0);
const quiet = { maxPerMinute: 1000, jitter: 0 };

// ---------------------------------------------------------------- config

test('defaults: 20/min ceiling (README); bursts, rest, jitter, off-peak pinned from code', () => {
  const b = new PolitenessBudget();
  assert.equal(b.maxPerMinute, 20);            // README: "20/min rolling ceiling"
  assert.equal(b.burstSize, 5);                // pinned from code
  assert.equal(b.burstIntervalMs, 400);        // pinned from code
  assert.equal(b.burstRestMs, 9000);           // pinned from code
  assert.equal(b.jitter, 0.4);                 // pinned from code ("±40%" comment)
  assert.equal(b.offPeakOnly, false);          // pinned from code
  assert.equal(b.offPeakStartHour, 22);        // pinned from code
  assert.equal(b.offPeakEndHour, 7);           // pinned from code
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

// ---------------------------------------------------------------- burst pacing

test('burst pacing: quick within a burst, one rest between bursts', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, burstSize: 3, burstIntervalMs: 100, burstRestMs: 1000 });
  // 1st goes at once; 2nd, 3rd 100ms apart; burst of 3 spent, so the 4th rests
  // 1000ms (200 + 1000); 5th, 6th ride the new burst; 7th rests again (1400 + 1000).
  assert.deepEqual(await sendTimes(t, b, back2back(7)), [0, 100, 200, 1200, 1300, 1400, 2400]);
});

test('burst pacing: the caller\'s own busy time counts toward the spacing', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, burstSize: 5, burstIntervalMs: 100, burstRestMs: 1000 });
  // Caller busy 30ms before the 2nd request: it waits only the remaining 70ms.
  assert.deepEqual(await sendTimes(t, b, [0, 30]), [0, 100]);
});

test('burst pacing: a natural pause longer than the rest refills the burst', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, burstSize: 2, burstIntervalMs: 100, burstRestMs: 1000 });
  // Burst of 2 spent at 100; caller busy 1500ms, so the 3rd (asked at 1600) goes at
  // once and is the first of a fresh burst: the 4th rides it (1700), the 5th rests.
  assert.deepEqual(await sendTimes(t, b, [0, 0, 1500, 0, 0]), [0, 100, 1600, 1700, 2700]);
});

test('burst pacing: a pause of exactly burstRestMs counts as the rest', async t => {
  fakeClock(t);
  t.mock.method(Math, 'random', () => 0.75);
  const b = new PolitenessBudget({ maxPerMinute: 1000, jitter: 0.5, burstSize: 2, burstIntervalMs: 100, burstRestMs: 1000 });
  // jitter 0.5, random 0.75: every wait is x - 0.5x + 0.75 * 2 * 0.5x = 1.25x.
  // 2nd at 125 spends the burst. Caller busy exactly 1000ms: the rest is served, so
  // the 3rd (asked at 1125) starts a fresh burst and goes at once. Were it charged
  // the jittered rest (1250) it would wait another 250ms.
  assert.deepEqual(await sendTimes(t, b, [0, 0, 1000]), [0, 125, 1125]);
});

test('burst pacing: a pause 1ms short of burstRestMs still pays the rest', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, burstSize: 2, burstIntervalMs: 100, burstRestMs: 1000 });
  // Burst spent at 100; caller busy 999ms, so the 3rd (asked at 1099) owes 1ms more.
  assert.deepEqual(await sendTimes(t, b, [0, 0, 999]), [0, 100, 1100]);
});

test('concurrency: two overlapping calls are spaced like sequential calls', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, burstSize: 5, burstIntervalMs: 100, burstRestMs: 1000 });
  const t0 = Date.now();
  const times = [];
  const sent = () => times.push(Date.now() - t0);
  await b.beforeRequest().then(sent);          // 1st goes at once
  // 2nd and 3rd start together while the 2nd still owes its 100ms spacing; the
  // 3rd must queue behind it and wait its own 100ms, as if called after it.
  const both = Promise.all([b.beforeRequest().then(sent), b.beforeRequest().then(sent)]);
  await waitOf(t, () => both);
  assert.deepEqual(times, [0, 100, 200]);
});

for (const [r, rest] of [[0, 600], [0.25, 800], [0.5, 1000], [1, 1400]]) {
  test(`jitter: rest spreads ±40% around burstRestMs (random ${r} -> ${rest}ms)`, async t => {
    fakeClock(t);
    t.mock.method(Math, 'random', () => r);
    const b = new PolitenessBudget({ maxPerMinute: 1000, jitter: 0.4, burstSize: 1, burstRestMs: 1000 });
    // rest = 1000 - 400 + r * 2 * 400 = 600 + 800r
    assert.deepEqual(await sendTimes(t, b, [0, 0]), [0, rest]);
  });
}

// ---------------------------------------------------------------- per-minute ceiling

test('ceiling: never more than maxPerMinute in any rolling 60s', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, maxPerMinute: 2, burstSize: 1000, burstIntervalMs: 0 });
  // 1st, 2nd at 0 fill the minute. 3rd waits until the first is 60s old (60000).
  // 4th at 60000: both t=0 requests are exactly 60s old and have aged out, so only
  // the 3rd is in the window and it goes. 5th waits for the 3rd to age out (120000).
  assert.deepEqual(await sendTimes(t, b, back2back(5)), [0, 0, 60000, 60000, 120000]);
});

test('ceiling: the wait runs until the oldest request in the window is 60s old', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, maxPerMinute: 2, burstSize: 1000, burstIntervalMs: 10000 });
  // Requests at 0 and 10000 fill the minute; the 3rd waits for the one at 0 to age
  // out (60000), by which time the 10s spacing is long served.
  assert.deepEqual(await sendTimes(t, b, back2back(3)), [0, 10000, 60000]);
});

test('ceiling: a request 1ms short of the window still waits that 1ms', async t => {
  fakeClock(t);
  const b = new PolitenessBudget({ ...quiet, maxPerMinute: 1, burstSize: 1000, burstIntervalMs: 0 });
  // Caller busy 59999ms; the first request is still in the window, 1ms to go.
  assert.deepEqual(await sendTimes(t, b, [0, 59999]), [0, 60000]);
});

// Property: under the shipped defaults the rhythm alone would break 20/min; the
// ceiling is what holds it. Random 0: 240ms spacing, 5400ms rest, so a 5-request
// burst every 6360ms, ~47/min. Random 1: 560ms spacing, 12600ms rest, so bursts
// start every 14840ms and the 5th burst (59360) lands inside the first minute: 21.
// Either way the busiest rolling 60s (a send 60s old has aged out) holds exactly 20.
for (const r of [0, 1]) {
  test(`ceiling property: shipped defaults never send more than 20 in any rolling 60s (random ${r})`, async t => {
    fakeClock(t);
    t.mock.method(Math, 'random', () => r);
    const times = await sendTimes(t, new PolitenessBudget(), back2back(100));
    const inWindowEnding = i => times.slice(0, i + 1).filter(s => times[i] - s < MIN).length;
    const busiest = Math.max(...times.map((_, i) => inWindowEnding(i)));
    assert.equal(busiest, 20);
  });
}

// ---------------------------------------------------------------- off-peak window

const offPeakWait = async (t, now, window = {}) => {
  fakeClock(t, now);
  t.mock.method(console, 'log', () => {});
  const b = new PolitenessBudget({ ...quiet, offPeakOnly: true, ...window });
  return waitOf(t, () => b.beforeRequest());
};

test('off-peak off (default): a noon request goes at once', async t => {
  fakeClock(t, NOON);
  const b = new PolitenessBudget(quiet);
  assert.equal(await waitOf(t, () => b.beforeRequest()), 0);
});

// Default window 22:00 (inclusive) to 07:00 (exclusive), wrapping midnight. Outside
// it the budget re-checks every 5 minutes, so the wait ends on the first 5-minute
// poll that lands inside.
for (const [label, now, wait] of [
  ['22:00 opens the window', at(22), 0],
  ['23:30 is inside', at(23, 30), 0],
  ['00:30 is inside (wraps midnight)', at(0, 30), 0],
  ['06:59 is inside', at(6, 59), 0],
  ['07:00 closes it: waits 15h to 22:00', at(7), 15 * HOUR],
  ['21:57:30 waits one 5-min poll to 22:02:30', at(21, 57, 30), 5 * MIN],
]) {
  test(`off-peak 22–7: ${label}`, async t => {
    assert.equal(await offPeakWait(t, now), wait);
  });
}

// A window that does not wrap midnight: 01:00 (inclusive) to 05:00 (exclusive).
for (const [label, now, wait] of [
  ['01:00 opens the window', at(1), 0],
  ['04:59 is inside', at(4, 59), 0],
  ['05:00 closes it: waits 20h to 01:00', at(5), 20 * HOUR],
  ['12:00 waits 13h to 01:00', at(12), 13 * HOUR],
]) {
  test(`off-peak 1–5: ${label}`, async t => {
    assert.equal(await offPeakWait(t, now, { offPeakStartHour: 1, offPeakEndHour: 5 }), wait);
  });
}

test('off-peak: announces the wait once, not on every 5-minute poll', async t => {
  const wait = await offPeakWait(t, NOON);
  assert.equal(wait, 10 * HOUR);                 // 120 polls from 12:00 to 22:00
  assert.equal(console.log.mock.callCount(), 1);
  assert.match(console.log.mock.calls[0].arguments[0], /outside off-peak window \(22:00–7:00\)/);
});

// ---------------------------------------------------------------- backpressure

for (const status of [200, 404, 430, 500, 502, 504]) {
  test(`backoff: ${status} is not backpressure, proceed at once (0) even with Retry-After`, () => {
    assert.equal(new PolitenessBudget().backoffFor(status, '30'), 0);
  });
}

test('backoff: Retry-After in seconds is honored exactly on 429 and 503', () => {
  const b = new PolitenessBudget();
  assert.equal(b.backoffFor(429, '120'), 120000);
  assert.equal(b.backoffFor(503, '120'), 120000);
});

test('backoff: Retry-After 0 means retry now', () => {
  assert.equal(new PolitenessBudget().backoffFor(429, '0'), 0);
});

test('backoff: Retry-After HTTP-date waits until that instant', t => {
  fakeClock(t, NOON);                            // NOON is on a whole second
  const header = new Date(NOON + 90000).toUTCString();
  assert.equal(new PolitenessBudget().backoffFor(503, header), 90000);
});

test('backoff: an HTTP-date already past means retry now', t => {
  fakeClock(t, NOON);
  const header = new Date(NOON - 90000).toUTCString();
  assert.equal(new PolitenessBudget().backoffFor(429, header), 0);
});

test('backoff: no Retry-After doubles from 2s per attempt, capped at 60s', () => {
  const b = new PolitenessBudget();
  // 1000 * 2^attempt: 2s, 4s, 8s, 16s, 32s, then 64s capped to 60s.
  const waits = [1, 2, 3, 4, 5, 6].map(a => b.backoffFor(429, undefined, a));
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 60000]);
});

test('backoff: attempt defaults to the first (2s), pinned from code', () => {
  assert.equal(new PolitenessBudget().backoffFor(503), 2000);
});

// The real caller passes headers.get('retry-after'): null when the header is absent.
for (const [label, header] of [['absent (null)', null], ['empty', ''], ['unreadable', 'soon']]) {
  test(`backoff: Retry-After ${label} falls back to exponential backoff (attempt 3 -> 8s)`, () => {
    assert.equal(new PolitenessBudget().backoffFor(429, header, 3), 8000);
  });
}

test('backoff: a negative Retry-After clamps to retry now (0), pinned from code', () => {
  assert.equal(new PolitenessBudget().backoffFor(503, '-5'), 0);
});
