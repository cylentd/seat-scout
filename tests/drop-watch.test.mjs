import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readJson, statePaths, seedFromScan, loadBaseline, windowFor, webhookFor,
  browserCfgFor, makeProbe, discoverRun, checkTarget, runWatch, isVerbose,
} from '../src/drop-run.mjs';
import { targetKey } from '../src/scan-core.mjs';
import { makeShow } from './helpers.mjs';

// Oracle: README "Drop watch". Rules it states: each run probes aheadDays past
// the known last showtime plus recheckDays from today; a first run walks
// forward until the run ends, records a baseline and never alerts; the env
// webhook wins over watchlist.json. Every date below is worked by hand.
// Anything else is pinned from code and says so where it is asserted.

const TODAY = '2026-07-20';
// Local 09:00 on 2026-07-20, so the watcher's local "today" is 2026-07-20 in any zone.
const NOW = new Date(2026, 6, 20, 9, 0, 0);

const roots = [];
const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-watch-'));
  roots.push(dir);
  return dir;
};
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Runs fn with process.env.TZ set to zone, then puts the old zone back.
async function inZone(zone, fn) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

const metreon = (over = {}) => ({
  name: 'Metreon', theaterId: 'AAFQQ', theaterSlug: 'amc-metreon-16-aafqq', chainCode: 'AMC',
  movieTitle: 'The Odyssey', movieTitleMatch: 'Odyssey', format: 'IMAX 70MM', ...over,
});

// One theaterMovieShowtimes showtime; `date` is Fandango's time label.
const st = (date, time, { type = 'available', format = 'IMAX 70MM' } = {}) => ({
  ticketingDate: `${date}+${time}`, date: time, type, filmFormat: [{ filterName: format }],
});
const payload = shows => ({
  viewModel: { movies: [{ title: 'The Odyssey', variants: [{ amenityGroups: [{ showtimes: shows }] }] }] },
});
// The stored form of st(date, time): id is the ticketingDate, time the label.
const stored = (date, time, type = 'available') => ({ id: `${date}+${time}`, time, type });
// A scan file as the scanner writes it: scanner-shaped shows, label 'raw'.
const scanOf = dates => ({ results: dates.map(d => ({ date: d, shows: [makeShow({ id: 7, ticketingDate: `${d}+19:00` })] })) });

// Fake Fandango. `days` maps a date to its showtimes (absent = nothing plays);
// `failing` dates throw; `malformed` dates answer null; `calendar` undefined
// means the calendar request fails.
function fakeApi({ days = {}, failing = [], malformed = [], calendar } = {}) {
  const requested = [];
  const calls = [];
  return {
    requested, calls,
    calendar: async (browserCfg, budget, t) => {
      calls.push({ kind: 'calendar', browserCfg, budget, t });
      if (calendar === undefined) throw new Error('calendar 500');
      return calendar;
    },
    showtimes: async (browserCfg, budget, t, date, log) => {
      calls.push({ kind: 'showtimes', browserCfg, budget, t, date, log });
      requested.push(date);
      if (failing.includes(date)) throw new Error('HTTP 503\n    at apiGet');
      return malformed.includes(date) ? null : payload(days[date] || []);
    },
  };
}

// checkTarget wired straight to a fake API, no disk.
const check = (t, api, { prev = null, watchlist = {}, verbose = false } = {}) => {
  const lines = [];
  const run = checkTarget(t, {
    watchlist, today: TODAY, prev, verbose, log: m => lines.push(m),
    getCalendar: () => api.calendar(null, null, t),
    getShowtimes: date => api.showtimes(null, null, t, date),
  });
  return run.then(r => ({ ...r, lines }));
};

// runWatch with every outside effect faked and a temp dir as the repo root.
function harness({ watchlist, api, env = {}, alert, verbose = false, now = () => NOW, ensureChromeReady, makeBudget }) {
  const root = tempRoot();
  const lines = [], alerts = [], chrome = [];
  const run = () => runWatch({
    root, watchlist, env, verbose, now, log: m => lines.push(m),
    ensureChromeReady: ensureChromeReady || (async cfg => { chrome.push({ cfg, requestsBefore: api.calls.length }); }),
    makeBudget: makeBudget || (politeness => ({ politeness })),
    api,
    alert: alert || (async (target, diff, opts) => { alerts.push({ target, diff, opts }); }),
  });
  return { root, lines, alerts, chrome, run };
}

const writeSnapshot = (root, t, dates) => {
  const { snapPath } = statePaths(root, t);
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify({ dates }));
};
const writeScan = (root, t, scan) => {
  const { scanPath } = statePaths(root, t);
  fs.mkdirSync(path.dirname(scanPath), { recursive: true });
  fs.writeFileSync(scanPath, JSON.stringify(scan));
};

// ---- command line -----------------------------------------------------------

// drops.bat's own usage line documents `drops.bat -v`; the script's documents --verbose.
// Both must turn on the per-date log (2026-10-06: -v was silently ignored).
const verboseCases = [
  ['-v (drops.bat)', ['node', 'src/drop-watch.mjs', '-v'], true],
  ['--verbose', ['node', 'src/drop-watch.mjs', '--verbose'], true],
  ['--once only', ['node', 'src/drop-watch.mjs', '--once'], false],
  ['no flags', ['node', 'src/drop-watch.mjs'], false],
];
for (const [label, argv, expected] of verboseCases) {
  test(`verbose flag: ${label} -> ${expected}`, () => {
    assert.equal(isVerbose(argv), expected);
  });
}

// ---- state on disk ----------------------------------------------------------

const readJsonCases = [
  // [label, file contents (null = no file), expected]
  ['valid JSON is parsed', '{"a":1}', { a: 1 }],
  ['corrupt JSON gives the fallback', '{"a":', 'fb'],
  ['a missing file gives the fallback', null, 'fb'],
];
for (const [label, contents, expected] of readJsonCases) {
  test(`readJson: ${label}`, () => {
    const p = path.join(tempRoot(), 'state.json');
    if (contents !== null) fs.writeFileSync(p, contents);
    assert.deepEqual(readJson(p, 'fb'), expected);
  });
}

test('state files are named with the scanner\'s target key, format as the format filter', () => {
  const root = tempRoot();
  const key = targetKey({ fandango: { theaterId: 'AAFQQ', chainCode: 'AMC', movieTitleMatch: 'Odyssey', formatFilter: 'IMAX 70MM' } });
  assert.deepEqual(statePaths(root, metreon()), {
    snapPath: path.join(root, 'data', 'drops', `${key}.json`),
    scanPath: path.join(root, 'data', 'scans', `${key}.json`),
  });
});

const seedCases = [
  ['a scan seeds a snapshot from its dates',
    { results: [...scanOf(['2026-07-24']).results, { date: '2026-07-25', shows: [] }] },
    { dates: { '2026-07-24': [{ id: '2026-07-24+19:00', time: 'raw', type: 'available' }], '2026-07-25': [] } }],
  ['a scan with no results seeds nothing', { results: [] }, null],
  ['no scan seeds nothing', null, null],
];
for (const [label, scan, expected] of seedCases) {
  test(`seedFromScan: ${label}`, () => {
    assert.deepEqual(seedFromScan(scan), expected);
  });
}

test('the stored snapshot is the baseline when it exists, even if a scan exists too', () => {
  const root = tempRoot();
  const paths = statePaths(root, metreon());
  writeSnapshot(root, metreon(), { '2026-07-30': [stored('2026-07-30', '19:00')] });
  writeScan(root, metreon(), scanOf(['2026-07-22']));
  const lines = [];
  assert.deepEqual(loadBaseline(paths, m => lines.push(m)), { dates: { '2026-07-30': [stored('2026-07-30', '19:00')] } });
  assert.deepEqual(lines, []);
});

test('with no snapshot (or a corrupt one) the baseline is seeded from the last scan', () => {
  const root = tempRoot();
  const paths = statePaths(root, metreon());
  fs.mkdirSync(path.dirname(paths.snapPath), { recursive: true });
  fs.writeFileSync(paths.snapPath, 'not json');
  writeScan(root, metreon(), { results: [...scanOf(['2026-07-22']).results, { date: '2026-07-23', shows: [] }] });
  const lines = [];
  const prev = loadBaseline(paths, m => lines.push(m));
  assert.deepEqual(prev, { dates: { '2026-07-22': [{ id: '2026-07-22+19:00', time: 'raw', type: 'available' }], '2026-07-23': [] } });
  assert.deepEqual(lines, ['  seeded from previous scan (run ends 2026-07-22)']);
});

test('with neither a snapshot nor a scan there is no baseline', () => {
  const lines = [];
  assert.equal(loadBaseline(statePaths(tempRoot(), metreon()), m => lines.push(m)), null);
  assert.deepEqual(lines, []);
});

// ---- settings ---------------------------------------------------------------

// Pinned from code: README names aheadDays and recheckDays but states no
// defaults and no target-over-watchlist precedence. The defaults 10 / 4 / 4 / 60
// (aheadDays / recheckDays / stopAfterEmptyDays / maxDiscoverDays) come from
// src/drop-run.mjs windowFor.
const windowCases = [
  // [label, target, watchlist, expected]
  ['defaults (pinned from code)', {}, {}, { aheadDays: 10, recheckDays: 4, stopAfterEmpty: 4, maxDays: 60 }],
  ['watchlist values', {}, { aheadDays: 7, recheckDays: 2, stopAfterEmptyDays: 3, maxDiscoverDays: 30 },
    { aheadDays: 7, recheckDays: 2, stopAfterEmpty: 3, maxDays: 30 }],
  ['target beats watchlist', { aheadDays: 5, recheckDays: 1 }, { aheadDays: 7, recheckDays: 2 },
    { aheadDays: 5, recheckDays: 1, stopAfterEmpty: 4, maxDays: 60 }],
  ['zero is a setting, not a gap', { aheadDays: 0, recheckDays: 0 }, { aheadDays: 7, recheckDays: 2, stopAfterEmptyDays: 0, maxDiscoverDays: 0 },
    { aheadDays: 0, recheckDays: 0, stopAfterEmpty: 0, maxDays: 0 }],
];
for (const [label, t, wl, expected] of windowCases) {
  test(`probe window settings: ${label}`, () => {
    assert.deepEqual(windowFor(t, wl), expected);
  });
}

const webhookCases = [
  // [label, env, watchlist, expected]
  ['env wins over watchlist.json', { SEAT_SCOUT_DISCORD_WEBHOOK: 'https://env' }, { discordWebhook: 'https://file' }, 'https://env'],
  ['watchlist.json when env is unset', {}, { discordWebhook: 'https://file' }, 'https://file'],
  // Pinned from code: an empty env var counts as unset.
  ['watchlist.json when env is empty', { SEAT_SCOUT_DISCORD_WEBHOOK: '' }, { discordWebhook: 'https://file' }, 'https://file'],
  ['none anywhere', {}, {}, null],
];
for (const [label, env, wl, expected] of webhookCases) {
  test(`webhook: ${label}`, () => {
    assert.equal(webhookFor(env, wl), expected);
  });
}

const chromeCases = [
  ['real session on 9222 by default', {}, 'real', 9222],
  ['watchlist overrides session and port', { browserSession: 'isolated', cdpPort: 9333 }, 'isolated', 9333],
];
for (const [label, wl, session, port] of chromeCases) {
  test(`Chrome config: ${label}, pointed at the first target's theatre`, () => {
    assert.deepEqual(browserCfgFor(wl, metreon()), {
      browserSession: session, cdpPort: port,
      fandango: { theaterId: 'AAFQQ', theaterSlug: 'amc-metreon-16-aafqq' },
    });
  });
}

// ---- one probe --------------------------------------------------------------

test('a date the theatre calendar lacks is empty without a request', async () => {
  let fetched = 0;
  const probe = makeProbe({ calendar: ['2026-07-21'], fetchShows: async () => { fetched++; return []; }, log: () => {} });
  assert.deepEqual(await probe('2026-07-20'), { date: '2026-07-20', shows: [] });
  assert.equal(fetched, 0);
});

for (const [label, calendar] of [['no calendar', null], ['an empty calendar', []]]) {
  test(`with ${label} every date is requested`, async () => {
    const asked = [];
    const probe = makeProbe({ calendar, fetchShows: async d => { asked.push(d); return [{ id: 1 }]; }, log: () => {} });
    assert.deepEqual(await probe('2026-07-20'), { date: '2026-07-20', shows: [{ id: 1 }] });
    assert.deepEqual(asked, ['2026-07-20']);
  });
}

test('a failed probe is unknown (null), logged with the first line of the error', async () => {
  const lines = [];
  const probe = makeProbe({ calendar: null, fetchShows: async () => { throw new Error('HTTP 503\n    at apiGet'); }, log: m => lines.push(m) });
  assert.equal(await probe('2026-07-21'), null);
  assert.deepEqual(lines, ['    2026-07-21: probe failed (HTTP 503) — skipped']);
});

// Pinned from code (the script header says only "--verbose prints every probed date").
const probeLogCases = [
  // [label, verbose, date, expected lines]; the calendar holds only the 20th.
  ['verbose, requested date', true, '2026-07-20', ['    2026-07-20: 2 show(s)']],
  ['verbose, calendar-skipped date', true, '2026-07-21', ['    2026-07-21: no theatre showtimes (skipped, no request)']],
  ['quiet, requested date', false, '2026-07-20', []],
  ['quiet, calendar-skipped date', false, '2026-07-21', []],
];
for (const [label, verbose, date, expected] of probeLogCases) {
  test(`probe log: ${label}`, async () => {
    const lines = [];
    const probe = makeProbe({ calendar: ['2026-07-20'], fetchShows: async () => [{ id: 1 }, { id: 2 }], log: m => lines.push(m), verbose });
    await probe(date);
    assert.deepEqual(lines, expected);
  });
}

// ---- first-run walk ---------------------------------------------------------

// A probe over a hand-written run: `plays` dates have one show, `fails` return null.
const walkProbe = ({ plays = [], fails = [] }) => async date =>
  fails.includes(date) ? null : { date, shows: plays.includes(date) ? [{ id: date }] : [] };
const walked = r => r.map(x => x.date);

test('first run walks forward until stopAfterEmpty empty days in a row', async () => {
  // Plays 20-22; with 2 empties to stop, 23 and 24 are the empties -> stop.
  const r = await discoverRun({ today: TODAY, stopAfterEmpty: 2, maxDays: 60,
    probe: walkProbe({ plays: ['2026-07-20', '2026-07-21', '2026-07-22'] }) });
  assert.deepEqual(walked(r), ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']);
});

test('a dark day inside the run resets the empty streak', async () => {
  // Plays 20, 22, 24: single dark days at 21 and 23 never reach 2; 25 and 26 do.
  const r = await discoverRun({ today: TODAY, stopAfterEmpty: 2, maxDays: 60,
    probe: walkProbe({ plays: ['2026-07-20', '2026-07-22', '2026-07-24'] }) });
  assert.deepEqual(walked(r), ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26']);
});

test('discovery stops at maxDays even while the run continues', async () => {
  const every = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  const r = await discoverRun({ today: TODAY, stopAfterEmpty: 2, maxDays: 3, probe: walkProbe({ plays: every }) });
  assert.deepEqual(walked(r), ['2026-07-20', '2026-07-21', '2026-07-22']);
});

test('a failed probe during discovery is not recorded and does not count as empty', async () => {
  // Plays 20; 21 fails (skipped); 22 and 23 are the two empties -> stop after 23.
  const r = await discoverRun({ today: TODAY, stopAfterEmpty: 2, maxDays: 60,
    probe: walkProbe({ plays: ['2026-07-20'], fails: ['2026-07-21'] }) });
  assert.deepEqual(walked(r), ['2026-07-20', '2026-07-22', '2026-07-23']);
});

// ---- one target -------------------------------------------------------------

test('first run: discovers the run, suppresses alerts, and says how far it looks', async () => {
  const api = fakeApi({ days: { '2026-07-20': [st('2026-07-20', '19:00')], '2026-07-21': [st('2026-07-21', '19:00')] } });
  const r = await check(metreon(), api, { watchlist: { stopAfterEmptyDays: 2 } });
  // Plays 20-21; 22 and 23 are the two empties.
  assert.deepEqual(api.requested, ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']);
  assert.equal(r.suppress, true);
  assert.equal(r.diff.runEnd, '2026-07-21');
  assert.deepEqual(r.lines, ['  no baseline — discovering the full run (up to 60 days)']);
});

test('later run probes aheadDays past the run end plus recheckDays from today', async () => {
  const api = fakeApi();
  const prev = { dates: { '2026-07-25': [stored('2026-07-25', '19:00')] } };
  const r = await check(metreon({ aheadDays: 3 }), api, { prev, watchlist: { recheckDays: 2 } });
  // Ahead: 26, 27, 28 (3 past the 25th). Recheck: 20, 21 (2 from today).
  assert.deepEqual(api.requested, ['2026-07-20', '2026-07-21', '2026-07-26', '2026-07-27', '2026-07-28']);
  assert.equal(r.suppress, false);
});

test('later run skips planned dates the theatre calendar lacks', async () => {
  const api = fakeApi({ calendar: { showtimeDates: ['2026-07-21', '2026-07-27'] } });
  const prev = { dates: { '2026-07-25': [stored('2026-07-25', '19:00')] } };
  await check(metreon({ aheadDays: 3, recheckDays: 2 }), api, { prev });
  assert.deepEqual(api.requested, ['2026-07-21', '2026-07-27']);
});

test('verbose later run lists the planned dates', async () => {
  const prev = { dates: { '2026-07-25': [stored('2026-07-25', '19:00')] } };
  const r = await check(metreon({ aheadDays: 1, recheckDays: 1 }), fakeApi(), { prev, verbose: true });
  assert.deepEqual(r.lines, [
    '  probing 2 date(s): 2026-07-20, 2026-07-26',
    '    2026-07-20: 0 show(s)',
    '    2026-07-26: 0 show(s)',
  ]);
});

test('only showtimes in the target\'s film and format count', async () => {
  const api = fakeApi({ days: { '2026-07-20': [st('2026-07-20', '19:00'), st('2026-07-20', '13:00', { format: 'Standard' })] } });
  const r = await check(metreon(), api, { watchlist: { stopAfterEmptyDays: 1 } });
  assert.deepEqual(r.snapshot.dates['2026-07-20'], [stored('2026-07-20', '19:00')]);
});

test('a new date is supply; the merged snapshot keeps unprobed and failed dates', async () => {
  const prev = { dates: {
    '2026-07-21': [stored('2026-07-21', '19:00')],
    '2026-07-25': [stored('2026-07-25', '19:00')],
  } };
  const api = fakeApi({ days: { '2026-07-26': [st('2026-07-26', '19:00')] }, failing: ['2026-07-21'] });
  const r = await check(metreon({ aheadDays: 1, recheckDays: 2 }), api, { prev });
  // Probed 20 (empty), 21 (failed), 26 (new). 25 was not probed.
  assert.equal(r.diff.supply, 1);
  assert.equal(r.diff.lost.length, 0);
  assert.deepEqual(r.snapshot, { dates: {
    '2026-07-20': [],
    '2026-07-21': [stored('2026-07-21', '19:00')],
    '2026-07-25': [stored('2026-07-25', '19:00')],
    '2026-07-26': [stored('2026-07-26', '19:00')],
  } });
});

// ---- the whole run ----------------------------------------------------------

for (const [label, watchlist] of [['an empty target list', { targets: [] }], ['no target list', {}]]) {
  test(`a watchlist with ${label} fails before Chrome is touched`, async () => {
    const h = harness({ watchlist, api: fakeApi() });
    await assert.rejects(h.run(), { name: 'Error', message: 'watchlist.json has no targets.' });
    assert.equal(h.chrome.length, 0);
  });
}

test('Chrome is made ready once, with the first target\'s theatre', async () => {
  const api = fakeApi();
  const h = harness({ watchlist: { targets: [metreon(), metreon({ name: 'Other', theaterId: 'XYZ' })], cdpPort: 9333 }, api });
  await h.run();
  assert.deepEqual(h.chrome, [{ cfg: {
    browserSession: 'real', cdpPort: 9333,
    fandango: { theaterId: 'AAFQQ', theaterSlug: 'amc-metreon-16-aafqq' },
  }, requestsBefore: 0 }]);
});

test('no Fandango request is made until Chrome reports ready', async () => {
  const api = fakeApi();
  let ready, asked;
  const chromeReady = new Promise(r => { ready = r; });
  const chromeAsked = new Promise(r => { asked = r; });
  const h = harness({ watchlist: { targets: [metreon()], maxDiscoverDays: 1 }, api,
    ensureChromeReady: () => { asked(); return chromeReady; } });
  const running = h.run();
  await chromeAsked;
  const requestsWhileWaiting = api.calls.length;
  ready();
  await running;
  assert.equal(requestsWhileWaiting, 0);
  // Once ready: one calendar and one showtimes request (maxDiscoverDays 1).
  assert.deepEqual(api.calls.map(c => c.kind), ['calendar', 'showtimes']);
});

test('Chrome failing to come up rejects the whole run before any request or alert', async () => {
  // Pinned from code: the shell turns this rejection into exit code 1.
  const api = fakeApi();
  const h = harness({ watchlist: { targets: [metreon()] }, api,
    ensureChromeReady: async () => { throw new Error('no CDP on :9222'); } });
  await assert.rejects(h.run(), { name: 'Error', message: 'no CDP on :9222' });
  assert.equal(api.calls.length, 0);
  assert.deepEqual(h.alerts, []);
});

test('one politeness budget, built from the watchlist, paces every request of every target', async () => {
  const api = fakeApi({ calendar: {} });
  const politeness = { burstSize: 3 };
  const built = [];
  const h = harness({
    watchlist: { targets: [metreon(), metreon({ name: 'B', theaterId: 'BBB' })], politeness, maxDiscoverDays: 1 }, api,
    makeBudget: p => { const b = { p }; built.push(b); return b; },
  });
  await h.run();
  assert.equal(built.length, 1);
  assert.equal(built[0].p, politeness);
  // 2 targets x (1 calendar + 1 showtimes on the 20th); every one on the same budget and port.
  assert.deepEqual(api.calls.map(c => [c.kind, c.t.name, c.date, c.budget === built[0], c.browserCfg.cdpPort]), [
    ['calendar', 'Metreon', undefined, true, 9222],
    ['showtimes', 'Metreon', '2026-07-20', true, 9222],
    ['calendar', 'B', undefined, true, 9222],
    ['showtimes', 'B', '2026-07-20', true, 9222],
  ]);
});

test('Fandango request notes are logged indented under the target', async () => {
  const api = fakeApi();
  const showtimes = api.showtimes;
  api.showtimes = async (...args) => { args[4]('parked for a human check'); return showtimes(...args); };
  const h = harness({ watchlist: { targets: [metreon()], maxDiscoverDays: 1 }, api });
  await h.run();
  assert.ok(h.lines.includes('  parked for a human check'), h.lines.join('\n'));
});

test('first run records a baseline on disk and never alerts', async () => {
  const api = fakeApi({ days: { '2026-07-20': [st('2026-07-20', '19:00')] } });
  const t = metreon();
  const h = harness({ watchlist: { targets: [t], stopAfterEmptyDays: 1 }, api });
  const hits = await h.run();
  assert.equal(hits, 0);
  assert.deepEqual(h.alerts, []);
  assert.ok(h.lines.includes('  baseline recorded (run ends 2026-07-20) — alerts start from the next run'), h.lines.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePaths(h.root, t).snapPath, 'utf8')), {
    checkedAt: NOW.toISOString(), target: t,
    dates: { '2026-07-20': [stored('2026-07-20', '19:00')], '2026-07-21': [] },
  });
});

test('a first run that finds nothing says the run end is unknown', async () => {
  const h = harness({ watchlist: { targets: [metreon()], stopAfterEmptyDays: 1 }, api: fakeApi() });
  await h.run();
  assert.ok(h.lines.includes('  baseline recorded (run ends unknown) — alerts start from the next run'), h.lines.join('\n'));
});

// Pinned from code. README: "First runs record a baseline and never alert." A
// watcher's first run whose baseline is seeded from data/scans/<key>.json is
// treated as a later run and DOES alert. README is ambiguous on whether a
// seeded baseline is a real one; flagged for David 2026-10-06.
test('a first watcher run seeded from a previous scan is treated as a later run and alerts', async () => {
  const t = metreon({ aheadDays: 1, recheckDays: 0 });
  const api = fakeApi({ days: { '2026-07-23': [st('2026-07-23', '19:00')] } });
  const h = harness({ watchlist: { targets: [t] }, api });
  writeScan(h.root, t, scanOf(['2026-07-22']));
  const hits = await h.run();
  // Seeded run ends on the 22nd; one day ahead is the 23rd, which now plays.
  assert.deepEqual(api.requested, ['2026-07-23']);
  assert.equal(hits, 1);
  assert.deepEqual(h.alerts.map(a => a.diff.supply), [1]);
  assert.ok(h.lines.includes('  seeded from previous scan (run ends 2026-07-22)'), h.lines.join('\n'));
});

test('a later run alerts with the diff and the env webhook, and counts the news', async () => {
  const t = metreon({ aheadDays: 1, recheckDays: 0 });
  const api = fakeApi({ days: { '2026-07-26': [st('2026-07-26', '19:00')] } });
  const h = harness({ watchlist: { targets: [t], discordWebhook: 'https://file' }, api,
    env: { SEAT_SCOUT_DISCORD_WEBHOOK: 'https://env' } });
  writeSnapshot(h.root, t, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  const hits = await h.run();
  assert.equal(hits, 1);
  assert.equal(h.alerts.length, 1);
  assert.deepEqual(h.alerts[0].target, { name: 'Metreon', movie: 'The Odyssey', format: 'IMAX 70MM' });
  assert.deepEqual(h.alerts[0].opts, { webhookUrl: 'https://env' });
  assert.equal(h.alerts[0].diff.runEnd, '2026-07-26');
  assert.equal(h.lines.at(-1), '\nDone — 1 target(s) had news.');
  assert.ok(!h.lines.some(l => l.startsWith('(no Discord webhook')));
});

test('a later run saves the merged snapshot, so the same news is not reported twice', async () => {
  const t = metreon({ aheadDays: 1, recheckDays: 0 });
  const api = fakeApi({ days: { '2026-07-26': [st('2026-07-26', '19:00')] } });
  const h = harness({ watchlist: { targets: [t] }, api });
  writeSnapshot(h.root, t, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  await h.run();
  const saved = JSON.parse(fs.readFileSync(statePaths(h.root, t).snapPath, 'utf8'));
  const secondHits = await h.run();
  // Run 1 probes the 26th (new) and saves 25 + 26. Run 2's run end is the
  // 26th, so it probes the 27th (nothing): no supply, no returns.
  assert.deepEqual(saved, { checkedAt: NOW.toISOString(), target: t, dates: {
    '2026-07-25': [stored('2026-07-25', '19:00')],
    '2026-07-26': [stored('2026-07-26', '19:00')],
  } });
  assert.deepEqual(api.requested, ['2026-07-26', '2026-07-27']);
  assert.equal(secondHits, 0);
  assert.deepEqual(h.alerts.map(a => [a.diff.supply, a.diff.returns]), [[1, 0], [0, 0]]);
});

test('with no webhook anywhere the run is terminal-only and alerts get null', async () => {
  const t = metreon({ movieTitle: undefined, aheadDays: 1, recheckDays: 0 });
  const h = harness({ watchlist: { targets: [t] }, api: fakeApi() });
  writeSnapshot(h.root, t, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  await h.run();
  assert.ok(h.lines.includes('(no Discord webhook configured — terminal only)'));
  assert.deepEqual(h.alerts[0].opts, { webhookUrl: null });
  // No movieTitle: the title match stands in for it.
  assert.deepEqual(h.alerts[0].target, { name: 'Metreon', movie: 'Odyssey', format: 'IMAX 70MM' });
  assert.ok(h.lines.includes('\nMetreon — Odyssey (IMAX 70MM)'));
});

const newsCases = [
  // [label, stored type, payload type, expected hits, Done line]
  ['selling out is alerted but is not news', 'available', 'soldout', 0, '\nDone — nothing new.'],
  ['returned seats are news', 'soldout', 'available', 1, '\nDone — 1 target(s) had news.'],
];
for (const [label, was, now, hits, done] of newsCases) {
  test(`a later run: ${label}`, async () => {
    const t = metreon({ aheadDays: 0, recheckDays: 1 });
    const api = fakeApi({ days: { '2026-07-20': [st('2026-07-20', '19:00', { type: now })] } });
    const h = harness({ watchlist: { targets: [t] }, api });
    writeSnapshot(h.root, t, { '2026-07-20': [stored('2026-07-20', '19:00', was)] });
    assert.equal(await h.run(), hits);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.lines.at(-1), done);
  });
}

test('one target failing is logged and the next target still runs', async () => {
  const a = metreon({ name: 'A', aheadDays: 1, recheckDays: 0 });
  const b = metreon({ name: 'B', theaterId: 'BBB', aheadDays: 1, recheckDays: 0 });
  const seen = [];
  const h = harness({ watchlist: { targets: [a, b] }, api: fakeApi(),
    alert: async target => { seen.push(target.name); if (target.name === 'A') throw new Error('Discord down\n    at post'); } });
  writeSnapshot(h.root, a, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  writeSnapshot(h.root, b, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  await h.run();
  assert.deepEqual(seen, ['A', 'B']);
  assert.ok(h.lines.includes('  check failed: Discord down'), h.lines.join('\n'));
});

// Pinned from code: a failed save is caught per target, and the save comes
// before the alert, so that target's news is not sent this run.
test('a snapshot that cannot be saved skips that target\'s alert; the next target still runs', async () => {
  const a = metreon({ name: 'A', aheadDays: 1, recheckDays: 0 });
  const b = metreon({ name: 'B', theaterId: 'BBB', aheadDays: 1, recheckDays: 0 });
  const api = fakeApi({ days: { '2026-07-26': [st('2026-07-26', '19:00')] } });
  const h = harness({ watchlist: { targets: [a, b] }, api });
  // A's snapshot path is a directory: unreadable (so A seeds from its scan) and unwritable.
  fs.mkdirSync(statePaths(h.root, a).snapPath, { recursive: true });
  writeScan(h.root, a, scanOf(['2026-07-25']));
  writeSnapshot(h.root, b, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  const hits = await h.run();
  assert.deepEqual(h.alerts.map(x => x.target.name), ['B']);
  assert.equal(hits, 1);
  const failed = h.lines.filter(l => l.startsWith('  check failed: '));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^ {2}check failed: (EISDIR|EPERM): /);
});

// Pinned from code: matchingShowtimes throws on a null payload inside the
// probe, so it is handled exactly like a failed request.
test('a malformed showtimes payload is a failed probe: logged, left out, and the run goes on', async () => {
  const a = metreon({ name: 'A', aheadDays: 1, recheckDays: 0 });
  const b = metreon({ name: 'B', theaterId: 'BBB', aheadDays: 1, recheckDays: 0 });
  const api = fakeApi({ malformed: ['2026-07-26'] });
  const h = harness({ watchlist: { targets: [a, b] }, api });
  writeSnapshot(h.root, a, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  writeSnapshot(h.root, b, { '2026-07-25': [stored('2026-07-25', '19:00')] });
  await h.run();
  assert.deepEqual(h.alerts.map(x => [x.target.name, x.diff.supply]), [['A', 0], ['B', 0]]);
  assert.equal(h.lines.filter(l => /^ {4}2026-07-26: probe failed \(.+\) — skipped$/.test(l)).length, 2);
  assert.ok(!h.lines.some(l => l.startsWith('  check failed')), h.lines.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePaths(h.root, a).snapPath, 'utf8')).dates,
    { '2026-07-25': [stored('2026-07-25', '19:00')] });
});

test('the run header names the target count', async () => {
  const h = harness({ watchlist: { targets: [metreon(), metreon({ name: 'B', theaterId: 'BBB' })], maxDiscoverDays: 1 }, api: fakeApi() });
  await h.run();
  assert.ok(h.lines.some(l => l.startsWith('Drop watch · ') && l.endsWith(' · 2 target(s)')), h.lines.join('\n'));
});

test('today is the local date, not the UTC one, late in the evening', async () => {
  // 06:30 UTC on 07-21 is 23:30 on 07-20 in Los Angeles (PDT, UTC-7).
  const late = new Date('2026-07-21T06:30:00Z');
  const api = fakeApi();
  await inZone('America/Los_Angeles', async () => {
    const h = harness({ watchlist: { targets: [metreon()], maxDiscoverDays: 1 }, api, now: () => late });
    await h.run();
  });
  assert.deepEqual(api.requested, ['2026-07-20']);
});

test('verbose is passed through to the probes', async () => {
  const h = harness({ watchlist: { targets: [metreon()], maxDiscoverDays: 1 }, api: fakeApi(), verbose: true });
  await h.run();
  assert.ok(h.lines.includes('    2026-07-20: 0 show(s)'), h.lines.join('\n'));
});
