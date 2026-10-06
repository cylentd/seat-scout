// apiGet is where the politeness budget's backoff is actually honoured: on 429/503
// it waits exactly what Retry-After asks (README "Politeness budget") before the
// next attempt. Responses come from a fake in-page fetch and every wait runs on the
// fake clock, so nothing here touches Chrome or Fandango. cfg is null on purpose:
// should the fake ever be bypassed, the real fetch fails on cfg before it can spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet } from '../src/fandango-api.mjs';
import { PolitenessBudget } from '../src/polite.mjs';

const NOON = new Date(2026, 9, 6, 12).getTime();

// A budget that adds no pacing of its own, so the only wait is the backoff.
const freeBudget = () => new PolitenessBudget({ maxPerMinute: 1000, jitter: 0, burstSize: 1000, burstIntervalMs: 0 });

// Fake in-page fetch: serves the given results in order and records each URL.
function pages(...results) {
  const fetchPage = (cfg, url) => { fetchPage.urls.push(url); return results.shift(); };
  fetchPage.urls = [];
  return fetchPage;
}

const flush = () => new Promise(res => setImmediate(res));

// Run apiGet on the fake clock, firing each pending timer until it settles.
async function run(t, path, fetchPage) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOON });
  const logs = [];
  const out = { logs, value: undefined, error: undefined, waited: undefined };
  let done = false;
  apiGet(null, freeBudget(), path, { log: m => logs.push(m), fetchPage })
    .then(v => { out.value = v; }, e => { out.error = e; })
    .finally(() => { done = true; });
  for (let i = 0; i < 1000 && !done; i++) {
    await flush();
    if (!done) t.mock.timers.runAll();
  }
  out.waited = Date.now() - NOON;
  return out;
}

test('apiGet: 429 with Retry-After 120 waits exactly 120s, then retries and returns the data', async t => {
  const fetchPage = pages({ httpStatus: 429, retryAfter: '120' }, { httpStatus: 200, data: { ok: 1 } });
  const out = await run(t, '/napi/x', fetchPage);
  assert.deepEqual(out.value, { ok: 1 });
  assert.equal(out.waited, 120000);
  assert.deepEqual(fetchPage.urls, ['https://www.fandango.com/napi/x', 'https://www.fandango.com/napi/x']);
  assert.deepEqual(out.logs, ['[429 Retry-After 120] honoring backpressure — waiting 120s']);
});

test('apiGet: 503 with no Retry-After header (null) backs off 2s on the first attempt', async t => {
  const fetchPage = pages({ httpStatus: 503, retryAfter: null }, { httpStatus: 200, data: [] });
  const out = await run(t, '/napi/x', fetchPage);
  assert.deepEqual(out.value, []);
  assert.equal(out.waited, 2000);
  assert.deepEqual(out.logs, ['[503] honoring backpressure — waiting 2s']);
});

test('apiGet: repeated header-less 429s back off 2s then 4s (attempts 1, 2)', async t => {
  const fetchPage = pages({ httpStatus: 429, retryAfter: null }, { httpStatus: 429, retryAfter: null },
    { httpStatus: 200, data: 'ok' });
  const out = await run(t, '/napi/x', fetchPage);
  assert.equal(out.value, 'ok');
  assert.equal(out.waited, 6000);
  assert.equal(fetchPage.urls.length, 3);
});

// The rest is pinned from code (README is silent): backpressure is honoured for 6
// attempts; anything else (a hard block such as 403) gets one 90s back-off, then
// apiGet parks, re-checking every 2 minutes for parkMinutes (15) before giving up.
const blocked = { httpStatus: 403, retryAfter: null };

test('apiGet: backpressure is honoured 6 times, then a 7th 429 parks (pinned from code)', async t => {
  const tooMany = { httpStatus: 429, retryAfter: '1' };
  const fetchPage = pages(...Array(7).fill(tooMany), { httpStatus: 200, data: 'back' });
  const out = await run(t, '/napi/x', fetchPage);
  // 6 x 1s honoured, then the 7th parks and the first 2-minute re-check succeeds.
  assert.equal(out.value, 'back');
  assert.equal(out.waited, 6 * 1000 + 120000);
  assert.deepEqual(out.logs.slice(6), ['Blocked — parking. If Chrome shows a verification prompt, click it.', 'Access restored']);
});

test('apiGet: a hard block backs off 90s once, then parks and recovers (pinned from code)', async t => {
  const fetchPage = pages(blocked, blocked, { httpStatus: 200, data: 'back' });
  const out = await run(t, '/napi/x', fetchPage);
  assert.equal(out.value, 'back');
  assert.equal(out.waited, 90000 + 120000);
  assert.equal(out.logs[0], '[HTTP 403] backing off 90s…');
});

test('apiGet: a block that outlasts the 15-minute park fails (pinned from code)', async t => {
  const fetchPage = pages(...Array(20).fill(blocked));
  const out = await run(t, '/napi/x', fetchPage);
  // 90s back-off, then re-checks at 2, 4 … 16 min: the 8th is the first past 15.
  assert.equal(out.error.message, 'HTTP 403 for https://www.fandango.com/napi/x');
  assert.equal(out.waited, 90000 + 8 * 120000);
  assert.equal(fetchPage.urls.length, 2 + 8);
});

test('apiGet: an absolute URL is fetched as given', async t => {
  const fetchPage = pages({ httpStatus: 200, data: 1 });
  await run(t, 'https://www.fandango.com/napi/seatMap/abc', fetchPage);
  assert.deepEqual(fetchPage.urls, ['https://www.fandango.com/napi/seatMap/abc']);
});

for (const status of [404, 410]) {
  test(`apiGet: ${status} is permanent, fails at once without waiting or retrying`, async t => {
    const fetchPage = pages({ httpStatus: status, retryAfter: null });
    const out = await run(t, '/napi/gone', fetchPage);
    assert.equal(out.error.message, `HTTP ${status} for https://www.fandango.com/napi/gone`);
    assert.equal(out.waited, 0);
    assert.equal(fetchPage.urls.length, 1);
  });
}
