// The public signals file is the contract the hosted site reads. Guard the two
// things the site depends on: every show carries counts only (never a seat
// grid), and each theatre carries the location/metro fields joined from the
// live watchlist pool so the nearest-first sort works without a rescan.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignals } from '../src/signals.mjs';
import { auditorium, cfg, makeScan, makeShow } from './helpers.mjs';

const liveCfg = {
  ...cfg,
  watchlist: {
    theatres: [
      { id: 'TEST1', name: 'Test Theatre', slug: 'test-theatre-test1', metro: 'bay', city: 'Dublin', lat: 37.7, lng: -121.9 },
    ],
    movies: [],
  },
};

function scanFor(overrides = {}) {
  return { ...makeScan(), config: { ...cfg, theatreName: 'Test Theatre', ...overrides } };
}

test('signals carry counts and booking links, never seat maps', () => {
  const out = buildSignals([scanFor()], liveCfg);
  assert.equal(out.movies.length, 1);
  const th = out.movies[0].theatres[0];
  assert.deepEqual(th.shows.map(s => s.id), ['2', '1', '3', '4']);
  const showKeys = ['bookingUrl', 'dateISO', 'dayLabel', 'id', 'open', 'pairs', 'part', 'pctFull', 'status', 'tier', 'timeLabel', 'usable', 'workHours'];
  assert.deepEqual(th.shows.map(s => Object.keys(s).sort()), [showKeys, showKeys, showKeys, showKeys]);
  assert.deepEqual(th.shows.map(s => Object.keys(s.open).sort()), Array(4).fill(['center', 'flexible', 'midBack']));
  assert.deepEqual(th.shows.map(s => 'seatMap' in s), [false, false, false, false]);
  const json = JSON.stringify(out);
  assert.equal(json.includes('"seatMap"'), false);
  assert.equal(json.includes('"auditoriumId"'), false);
  assert.equal(/"x":\d/.test(json), false, 'no seat coordinates may leak');
});

test('theatre entries join metro, city, coordinates and Fandango page from the live pool', () => {
  const th = buildSignals([scanFor()], liveCfg).movies[0].theatres[0];
  assert.equal(th.id, 'TEST1');
  assert.equal(th.metro, 'bay');
  assert.equal(th.city, 'Dublin');
  assert.equal(th.lat, 37.7);
  assert.equal(th.lng, -121.9);
  assert.equal(th.fandangoUrl, 'https://www.fandango.com/test-theatre-test1/theater-page');
  assert.equal(th.onSale, true);
  assert.equal(th.stats.total, th.shows.length);
});

test('a theatre missing from the pool degrades to nulls instead of throwing', () => {
  const th = buildSignals([scanFor({ fandango: { ...cfg.fandango, theaterId: 'GHOST' } })], liveCfg).movies[0].theatres[0];
  assert.equal(th.metro, null);
  assert.equal(th.city, null);
  assert.equal(th.lat, null);
  assert.equal(th.lng, null);
  assert.equal(th.fandangoUrl, null);
});

test('onsale-mode targets with no showtimes report onSale false', () => {
  const scan = scanFor({ mode: 'onsale' });
  scan.results = [];
  const th = buildSignals([scan], liveCfg).movies[0].theatres[0];
  assert.equal(th.mode, 'onsale');
  assert.equal(th.onSale, false);
  assert.equal(th.shows.length, 0);
});

// ---------------------------------------------------------------------------
// Per-show counts. Worked by hand from makeScan() (helpers.mjs): 9 rows A..I,
// 21 seats each = 189 seats per house, cx = (n-1)/20, row depth = index/8
// (E = 0.50, F = 0.625, H = 0.875, I = 1.0). Aug 1 2026 is a Saturday, Aug 3 a
// Monday. Shows come back chronologically: 2 (Sat 1:00 PM), 1 (Sat 7:05 PM),
// 3 (Sat 10:00 PM), 4 (Mon 1:00 PM); show 5 is expired and must be absent.
// ---------------------------------------------------------------------------
const theatre = () => buildSignals([scanFor()], liveCfg).movies[0].theatres[0];
const showById = (th, id) => th.shows.find(s => s.id === id);

test('expired showtimes are dropped; the rest come back in chronological order', () => {
  const th = theatre();
  assert.deepEqual(th.shows.map(s => s.id), ['2', '1', '3', '4']);
});

test('a show with a center pair run reports pairs, open seats per tier, usable and % full', () => {
  // E8..E11 open: cx .35 .40 .45 .50 all inside the center window (row E depth .50).
  // One run of 4 -> 2 pairs, both center. usable = 4. sold = 189 - 4 = 185; 185/189 = 97.9% -> 98.
  const s = showById(theatre(), '1');
  assert.equal(s.status, 'available');
  assert.equal(s.tier, 'center');
  assert.deepEqual(s.pairs, { center: 2, midBack: 0, flexible: 0, total: 2 });
  assert.deepEqual(s.open, { center: 4, midBack: 0, flexible: 0 });
  assert.equal(s.usable, 4);
  assert.equal(s.pctFull, 98);
});

test('a show with a single mid-back seat has open seats but no pairs and no tier', () => {
  // F5 open: row F depth .625 (center rows), cx .20 < .30 so not center; mid-back window is .12-.88.
  // sold = 188; 188/189 = 99.5% -> 99.
  const s = showById(theatre(), '2');
  assert.equal(s.tier, null);
  assert.deepEqual(s.pairs, { center: 0, midBack: 0, flexible: 0, total: 0 });
  assert.deepEqual(s.open, { center: 0, midBack: 1, flexible: 0 });
  assert.equal(s.usable, 1);
  assert.equal(s.pctFull, 99);
});

test('a flexible-only pair makes the show tier flexible and counts one pair', () => {
  // I1,I2 (cx 0, .05, row I depth 1.0): flexible pair. H1 .00 and H3 .10: flexible singles.
  // H5 .20 and H7 .30: mid-back singles (row H depth .875 is past the center rows).
  // open flexible 4, midBack 2; usable 6; sold = 189 - 6 = 183; 183/189 = 96.8% -> 97.
  const s = showById(theatre(), '4');
  assert.equal(s.tier, 'flexible');
  assert.deepEqual(s.pairs, { center: 0, midBack: 0, flexible: 1, total: 1 });
  assert.deepEqual(s.open, { center: 0, midBack: 2, flexible: 4 });
  assert.equal(s.usable, 6);
  assert.equal(s.pctFull, 97);
});

test('a sold-out show reports zero counts, usable 0 and no % full', () => {
  const s = showById(theatre(), '3');
  assert.equal(s.status, 'soldout');
  assert.equal(s.tier, null);
  assert.deepEqual(s.pairs, { center: 0, midBack: 0, flexible: 0, total: 0 });
  assert.deepEqual(s.open, { center: 0, midBack: 0, flexible: 0 });
  assert.equal(s.usable, 0);
  assert.equal(s.pctFull, null);
});

// The 'late' label for 10 PM is pinned from the code (format.mjs partOfDay); the README names no part-of-day labels.
test('each show carries its day, clock label, part of day and weekday-work-hours flag', () => {
  const th = theatre();
  const label = id => { const s = showById(th, id); return [s.dateISO, s.dayLabel, s.timeLabel, s.part, s.workHours]; };
  assert.deepEqual(label('1'), ['2026-08-01', 'Sat Aug 1', '7:05 PM', 'evening', false]);
  assert.deepEqual(label('2'), ['2026-08-01', 'Sat Aug 1', '1:00 PM', 'afternoon', false]);
  assert.deepEqual(label('3'), ['2026-08-01', 'Sat Aug 1', '10:00 PM', 'late', false]);
  assert.deepEqual(label('4'), ['2026-08-03', 'Mon Aug 3', '1:00 PM', 'afternoon', true]); // Monday 1 PM
});

// The jump.aspx URL shape and its parameter names are pinned from the code (viewmodel bookingUrl);
// the README only says "a Fandango booking link".
test('each show links to its own Fandango seat-selection page', () => {
  const url = new URL(showById(theatre(), '1').bookingUrl);
  assert.equal(url.origin + url.pathname, 'https://tickets.fandango.com/transaction/ticketing/mobile/jump.aspx');
  assert.equal(url.searchParams.get('showtimehashcode'), 'hash1');
  assert.equal(url.searchParams.get('sdate'), '2026-08-01+19:05');
  assert.equal(url.searchParams.get('mid'), '123');
  assert.equal(url.searchParams.get('tid'), 'TEST1');
});

// ---------------------------------------------------------------------------
// Theatre stats. From the same scan: 4 shows, 2 with pairs (shows 1 and 4),
// 1 sold out (show 3), best pair count 2 (show 1).
// ---------------------------------------------------------------------------
test('theatre stats count shows, shows with pairs, sold-out shows and the best pair count', () => {
  assert.deepEqual(theatre().stats, { total: 4, withPairs: 2, soldout: 1, bestPairs: 2 });
});

// Showtimes on Sat 7:05 PM, one per entry of `opens` (open seats per row for each).
function oneShowScan({ theaterId = 'TEST1', open = {}, opens = [open], title, format, extra = {} } = {}) {
  const fandango = { ...cfg.fandango, theaterId, ...(title ? { movieTitle: title } : {}), ...(format ? { formatFilter: format } : {}) };
  return {
    scannedAt: '2026-07-19T12:00:00.000Z',
    source: 'fandango',
    config: { ...cfg, fandango, ...extra },
    results: [{
      date: '2026-08-01',
      shows: opens.map((o, i) => makeShow({ id: 9 + i, ticketingDate: '2026-08-01+19:05', seats: auditorium(o) })),
      errors: [],
    }],
  };
}

// Privacy contract: publish counts, never inventory. Exact key sets at every
// level, so any new field (a seat id, a coordinate, a grid) fails here until
// someone reviews it. Key lists are pinned from the code's current shape.
test('every level of the document carries exactly the reviewed fields', () => {
  const doc = buildSignals([scanFor()], liveCfg);
  const movie = doc.movies[0];
  const th = movie.theatres[0];
  assert.deepEqual(Object.keys(doc).sort(), ['generatedAt', 'movies']);
  assert.deepEqual(Object.keys(movie).sort(), ['formats', 'mode', 'theatres', 'title']);
  assert.deepEqual(Object.keys(th).sort(), [
    'chain', 'city', 'directBookingUrl', 'fandangoUrl', 'format', 'id', 'lat', 'lng',
    'metro', 'mode', 'name', 'onSale', 'scannedAt', 'shows', 'stats',
  ]);
  assert.deepEqual(Object.keys(th.stats).sort(), ['bestPairs', 'soldout', 'total', 'withPairs']);
  const showKeys = ['bookingUrl', 'dateISO', 'dayLabel', 'id', 'open', 'pairs', 'part', 'pctFull', 'status', 'tier', 'timeLabel', 'usable', 'workHours'];
  assert.deepEqual(th.shows.map(s => Object.keys(s).sort()), [showKeys, showKeys, showKeys, showKeys]);
  assert.deepEqual(th.shows.map(s => Object.keys(s.pairs).sort()), Array(4).fill(['center', 'flexible', 'midBack', 'total']));
  assert.deepEqual(th.shows.map(s => Object.keys(s.open).sort()), Array(4).fill(['center', 'flexible', 'midBack']));
});

test('theatre stats report bestPairs 0 and withPairs 0 when no show has a pair', () => {
  const th = buildSignals([oneShowScan({ open: { E: [8] } })], liveCfg).movies[0].theatres[0];
  assert.deepEqual(th.stats, { total: 1, withPairs: 0, soldout: 0, bestPairs: 0 });
});

test('a theatre with exactly one showtime is on sale', () => {
  const th = buildSignals([oneShowScan({ open: { E: [8, 9] } })], liveCfg).movies[0].theatres[0];
  assert.equal(th.onSale, true);
  assert.deepEqual(th.stats, { total: 1, withPairs: 1, soldout: 0, bestPairs: 1 });
});

// ---------------------------------------------------------------------------
// Theatre identity fields. Fallback chains are pinned from the code (the README
// only says the fields exist): name -> theatreName | theaterSlug | theaterId;
// chain -> directBooking.label | chainCode | null; movie -> movieTitle | movieTitleMatch.
// ---------------------------------------------------------------------------
test('theatre name falls back from theatreName to the Fandango slug to the theatre id', () => {
  const named = scanFor({ theatreName: 'Named' });
  const slugOnly = scanFor({ theatreName: undefined });
  const idOnly = scanFor({ theatreName: undefined, fandango: { ...cfg.fandango, theaterSlug: undefined } });
  const names = [named, slugOnly, idOnly].map(s => buildSignals([s], liveCfg).movies[0].theatres[0].name);
  assert.deepEqual(names, ['Named', 'test-theatre-test1', 'TEST1']);
});

test('chain label and direct booking link come from directBooking when set', () => {
  const th = buildSignals([scanFor({ directBooking: { label: 'Alamo', url: 'https://book.example/alamo' } })], liveCfg).movies[0].theatres[0];
  assert.equal(th.chain, 'Alamo');
  assert.equal(th.directBookingUrl, 'https://book.example/alamo');
});

test('without directBooking the chain is the Fandango chain code and there is no direct link', () => {
  const th = theatre();
  assert.equal(th.chain, 'REGL');
  assert.equal(th.directBookingUrl, null);
});

test('chain is null when neither directBooking nor a chain code exists', () => {
  const th = buildSignals([scanFor({ fandango: { ...cfg.fandango, chainCode: undefined } })], liveCfg).movies[0].theatres[0];
  assert.equal(th.chain, null);
});

test('movie title is movieTitle when set, else the match string', () => {
  const plain = buildSignals([scanFor()], liveCfg).movies[0];
  assert.equal(plain.title, 'Odyssey'); // cfg has only movieTitleMatch
  const titled = buildSignals([scanFor({ fandango: { ...cfg.fandango, movieTitle: 'The Odyssey' } })], liveCfg).movies[0];
  assert.equal(titled.title, 'The Odyssey');
});

test('theatre carries its format, scan time and default mode; a missing scan time is null', () => {
  const th = theatre();
  assert.equal(th.format, 'IMAX 70MM');
  assert.equal(th.mode, 'seats');
  assert.equal(th.scannedAt, '2026-07-19T12:00:00.000Z');
  const undated = scanFor();
  delete undated.scannedAt;
  assert.equal(buildSignals([undated], liveCfg).movies[0].theatres[0].scannedAt, null);
});

test('a coordinate that is not a number degrades to null, zero stays zero', () => {
  const zero = { ...liveCfg, watchlist: { theatres: [{ id: 'TEST1', lat: 0, lng: 0 }] } };
  const str = { ...liveCfg, watchlist: { theatres: [{ id: 'TEST1', lat: '37.7', lng: '-121.9' }] } };
  const a = buildSignals([scanFor()], zero).movies[0].theatres[0];
  const b = buildSignals([scanFor()], str).movies[0].theatres[0];
  assert.deepEqual([a.lat, a.lng], [0, 0]);
  assert.deepEqual([b.lat, b.lng], [null, null]);
});

// ---------------------------------------------------------------------------
// Live config wins over the copy frozen into the cache (code comment on
// theatreSignal): tier geometry and party size.
// ---------------------------------------------------------------------------
test('live party size overrides the cached one; the cached one is the fallback', () => {
  // E8..E11 is one run of 4: party 2 -> 2 groups, party 3 -> 1 group (1 seat stranded).
  const open = { E: [8, 9, 10, 11] };
  const total = (live, cached) => buildSignals(
    [oneShowScan({ open, extra: { partySize: cached } })], live,
  ).movies[0].theatres[0].shows[0].pairs.total;
  assert.equal(total({ ...liveCfg, partySize: 3 }, 2), 1);
  const noLive = { ...liveCfg }; delete noLive.partySize;
  assert.equal(total(noLive, 3), 1);
  assert.equal(total(noLive, 2), 2);
});

test('live tier geometry overrides the cached tiers', () => {
  // Live center window starts at cx .45 (cached: .30). Run E8..E11 = cx .35 .40 .45 .50:
  // pair (E8,E9) is mid-back, pair (E10,E11) is center. Cached tiers would make both center.
  const live = { ...liveCfg, tiers: { ...cfg.tiers, center: { ...cfg.tiers.center, xMin: 0.45 } } };
  const s = buildSignals([oneShowScan({ open: { E: [8, 9, 10, 11] } })], live).movies[0].theatres[0].shows[0];
  assert.deepEqual(s.pairs, { center: 1, midBack: 1, flexible: 0, total: 2 });
});

// ---------------------------------------------------------------------------
// Grouping into movies. Pinned from the code: movies in first-seen order, formats
// de-duplicated, theatres best-first by their best pair count.
// ---------------------------------------------------------------------------
test('theatres of one movie are ordered best pair count first', () => {
  // MANY: three shows with E8,E9 (1 pair each) -> withPairs 3, bestPairs 1.
  // HIGH: one show E8..E11 (2 pairs) -> withPairs 1, bestPairs 2. Best pair count
  // wins over the number of shows with pairs. LOW: E8 alone -> bestPairs 0.
  const scans = [
    oneShowScan({ theaterId: 'MANY', opens: [{ E: [8, 9] }, { E: [8, 9] }, { E: [8, 9] }] }),
    oneShowScan({ theaterId: 'LOW', open: { E: [8] } }),
    oneShowScan({ theaterId: 'HIGH', open: { E: [8, 9, 10, 11] } }),
  ];
  const ths = buildSignals(scans, liveCfg).movies[0].theatres;
  assert.deepEqual(ths.map(t => t.id), ['HIGH', 'MANY', 'LOW']);
  assert.deepEqual(ths.map(t => [t.stats.bestPairs, t.stats.withPairs]), [[2, 1], [1, 3], [0, 0]]);
});

test('streams group by movie title, each movie listing its distinct formats and its theatres', () => {
  const scans = [
    oneShowScan({ theaterId: 'T1', title: 'Alpha' }),
    oneShowScan({ theaterId: 'T2', title: 'Alpha' }),
    oneShowScan({ theaterId: 'T3', title: 'Alpha', format: 'Dolby' }),
    oneShowScan({ theaterId: 'T4', title: 'Beta' }),
  ];
  const { movies } = buildSignals(scans, liveCfg);
  assert.deepEqual(movies.map(m => m.title), ['Alpha', 'Beta']);
  assert.deepEqual(movies[0].formats, ['IMAX 70MM', 'Dolby']);
  assert.deepEqual(movies[0].theatres.map(t => t.id).sort(), ['T1', 'T2', 'T3']);
  assert.deepEqual(movies[1].formats, ['IMAX 70MM']);
  assert.deepEqual(movies[1].theatres.map(t => t.id), ['T4']);
});

test('a movie carries its mode: seats by default, onsale when the target is an on-sale watch', () => {
  assert.equal(buildSignals([scanFor()], liveCfg).movies[0].mode, 'seats');
  assert.equal(buildSignals([oneShowScan({ extra: { mode: 'onsale' } })], liveCfg).movies[0].mode, 'onsale');
});

test('no scans gives an empty movie list', () => {
  assert.deepEqual(buildSignals([], liveCfg).movies, []);
});

test('generatedAt is the build time as an ISO timestamp', () => {
  const before = new Date().toISOString();
  const { generatedAt } = buildSignals([], liveCfg);
  const later = new Date().toISOString();
  assert.match(generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(generatedAt >= before && generatedAt <= later, `${generatedAt} not within ${before}..${later}`);
});

// ---------------------------------------------------------------------------
// `node src/signals.mjs`: reads config.json and data/scans/*.json (or the legacy
// data/scan-latest.json) and writes public/signals.json under the module's own
// root. Each run uses a throwaway copy of src/ in a temp dir, never the repo's
// data/ or public/.
// ---------------------------------------------------------------------------
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function makeRoot({ scans = {}, latest = null, config = liveCfg } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'signals-'));
  roots.push(root);
  cpSync(SRC, path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  if (scans) {
    mkdirSync(path.join(root, 'data', 'scans'), { recursive: true });
    for (const [name, body] of Object.entries(scans)) {
      writeFileSync(path.join(root, 'data', 'scans', name), typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
  if (latest) writeFileSync(path.join(root, 'data', 'scan-latest.json'), JSON.stringify(latest));
  return root;
}
const run = (root, script = path.join('src', 'signals.mjs')) =>
  spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
const output = root => path.join(root, 'public', 'signals.json');

test('running the module writes minified public/signals.json and reports counts', () => {
  const root = makeRoot({
    scans: {
      'a.json': oneShowScan({ theaterId: 'T1', title: 'Alpha' }),
      'b.json': oneShowScan({ theaterId: 'T2', title: 'Alpha' }),
      'c.json': oneShowScan({ theaterId: 'T3', title: 'Beta' }),
    },
    config: { ...liveCfg, watchlist: { theatres: [{ id: 'T1', metro: 'bay', city: 'Dublin', lat: 37.7, lng: -121.9 }] } },
  });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Wrote .*signals\.json: 2 movie\(s\) across 3 theatre stream\(s\) -> public\/signals\.json\n$/);
  const raw = readFileSync(output(root), 'utf8');
  assert.equal(raw, JSON.stringify(JSON.parse(raw)), 'file is minified');
  const { movies } = JSON.parse(raw);
  assert.deepEqual(movies.map(m => m.title).sort(), ['Alpha', 'Beta']);
  const t1 = movies.find(m => m.title === 'Alpha').theatres.find(t => t.id === 'T1');
  assert.equal(t1.metro, 'bay'); // joined from config.json's pool
  assert.equal(t1.lat, 37.7);
});

test('running the module twice succeeds when public/ already exists', () => {
  const root = makeRoot({ scans: { 'a.json': oneShowScan() } });
  mkdirSync(path.join(root, 'public'));
  writeFileSync(output(root), '{"stale":true}');
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(output(root), 'utf8')).movies.length, 1);
});

test('only scan caches that parse and name a Fandango target are used', () => {
  const root = makeRoot({
    scans: {
      'good.json': oneShowScan({ theaterId: 'T1' }),
      'broken.json': '{not json',
      'no-target.json': { config: { partySize: 2 }, results: [] },
      'empty.json': {},
      'notes.txt': JSON.stringify(oneShowScan({ theaterId: 'T9', title: 'Ignored' })),
    },
  });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  const { movies } = JSON.parse(readFileSync(output(root), 'utf8'));
  assert.equal(movies.length, 1);
  assert.deepEqual(movies[0].theatres.map(t => t.id), ['T1']);
});

test('scan-latest.json is ignored while any per-target cache is usable', () => {
  const root = makeRoot({
    scans: { 'a.json': oneShowScan({ theaterId: 'T1', title: 'Cached' }) },
    latest: oneShowScan({ theaterId: 'T2', title: 'Legacy' }),
  });
  assert.equal(run(root).status, 0);
  const { movies } = JSON.parse(readFileSync(output(root), 'utf8'));
  assert.deepEqual(movies.map(m => m.title), ['Cached']);
});

for (const [name, scans] of [
  ['there is no data/scans directory', null],
  ['data/scans holds only an unusable file', { 'broken.json': '{nope' }],
]) {
  test(`legacy scan-latest.json is the fallback when ${name}`, () => {
    const root = makeRoot({ scans, latest: oneShowScan({ theaterId: 'T2', title: 'Legacy' }) });
    const r = run(root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output(root), 'utf8')).movies.map(m => m.title), ['Legacy']);
  });
}

test('with no usable scan anywhere the file is written with no movies', () => {
  const root = makeRoot({ scans: null, latest: { config: { partySize: 2 }, results: [] } });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 movie\(s\) across 0 theatre stream\(s\)/);
  assert.deepEqual(JSON.parse(readFileSync(output(root), 'utf8')).movies, []);
});

test('importing the module writes nothing; only running it directly does', () => {
  const root = makeRoot({ scans: { 'a.json': oneShowScan() } });
  writeFileSync(path.join(root, 'importer.mjs'), "import './src/signals.mjs';\n");
  const r = run(root, 'importer.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(output(root)), false);
});
