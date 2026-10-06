import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoPlusDays, matchingShowtimes, compactSeatMap, dateIsClean,
  ttlMs, daysBetween, pairTotals, targetKey, listMovies,
  observeResults, appendHistory, pairlessStreak, computeTrend, calendarDates,
  expandTargets,
} from '../src/scan-core.mjs';
import { cfg, auditorium, makeShow } from './helpers.mjs';

const fd = cfg.fandango;

test('isoPlusDays crosses month and year boundaries', () => {
  assert.equal(isoPlusDays('2026-01-31', 1), '2026-02-01');
  assert.equal(isoPlusDays('2026-12-31', 1), '2027-01-01');
  assert.equal(isoPlusDays('2026-08-01', 0), '2026-08-01');
});

test('matchingShowtimes filters by title and format', () => {
  const payload = {
    viewModel: {
      movies: [
        {
          title: 'The Odyssey',
          variants: [{
            amenityGroups: [{
              showtimes: [
                { id: 1, showtimeHashCode: 'h1', date: '7:00p', ticketingDate: '2026-08-01+19:00', type: 'available', expired: false, filmFormat: [{ filterName: 'IMAX 70MM' }, { filterName: 'Reserved' }] },
                { id: 2, showtimeHashCode: 'h2', date: '9:00p', ticketingDate: '2026-08-01+21:00', type: 'soldout', expired: false, filmFormat: [{ filterName: 'Standard' }] },
              ],
            }],
          }],
        },
        {
          title: 'Some Other Movie',
          variants: [{ amenityGroups: [{ showtimes: [{ id: 3, filmFormat: [{ filterName: 'IMAX 70MM' }] }] }] }],
        },
      ],
    },
  };
  const shows = matchingShowtimes(payload, fd);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].id, 1);
  assert.equal(shows[0].hash, 'h1');
  assert.deepEqual(shows[0].formats, ['IMAX 70MM', 'Reserved']);
});

test('matchingShowtimes reads top-level movies and survives empty payloads', () => {
  const flat = { movies: [{ title: 'the odyssey', variants: [{ amenityGroups: [{ showtimes: [{ id: 9, ticketingDate: 'x', filmFormat: [{ filterName: 'IMAX 70MM' }] }] }] }] }] };
  assert.equal(matchingShowtimes(flat, fd).length, 1); // title match is case-insensitive
  assert.deepEqual(matchingShowtimes({}, fd), []);
  assert.deepEqual(matchingShowtimes({ viewModel: {} }, fd), []);
});

test('compactSeatMap maps API fields to the stored shape', () => {
  const sm = {
    auditoriumId: 21, totalAvailableSeatCount: 1, totalSeatCount: 2,
    seats: [
      { id: 'F1', x: 1, y: 2, width: 3, height: 4, column: 1, status: 'A', type: 'standard', rightNeighbor: 'F2' },
      { id: 'F2', x: 5, y: 2, width: 3, height: 4, column: 2, status: 'R', type: 'standard' },
    ],
  };
  const c = compactSeatMap(sm);
  assert.equal(c.auditoriumId, 21);
  assert.equal(c.totalAvailable, 1);
  assert.equal(c.totalSeats, 2);
  assert.deepEqual(c.seats[0], { id: 'F1', x: 1, y: 2, w: 3, h: 4, col: 1, status: 'A', type: 'standard', right: 'F2' });
  assert.equal(c.seats[1].right, null); // missing neighbor normalised to null
});

test('dateIsClean accepts complete results and rejects gaps', () => {
  const clean = { date: 'd', errors: [], shows: [
    makeShow({ id: 1, ticketingDate: 'x', seats: auditorium() }),
    makeShow({ id: 2, ticketingDate: 'x', type: 'soldout' }),          // sold out needs no map
    { ...makeShow({ id: 3, ticketingDate: 'x' }), expired: true },     // expired needs no map
  ] };
  assert.ok(dateIsClean(clean));
  assert.ok(!dateIsClean(null));
  assert.ok(!dateIsClean({ ...clean, errors: ['boom'] }));
  assert.ok(!dateIsClean({ date: 'd', errors: [], shows: [makeShow({ id: 4, ticketingDate: 'x' })] })); // available but no seat map
  assert.ok(!dateIsClean({ date: 'd', errors: [], shows: [{ ...makeShow({ id: 5, ticketingDate: 'x', seats: auditorium() }), error: 'x' }] }));
});

test('ttlMs tiers: near always refreshes, mid daily, far every 3 days', () => {
  const H = 3600_000;
  for (const d of [0, 1, 2, 3]) assert.equal(ttlMs(d), 0, `daysOut ${d}`);
  for (const d of [4, 10, 14]) assert.equal(ttlMs(d), 24 * H, `daysOut ${d}`);
  for (const d of [15, 40, 365]) assert.equal(ttlMs(d), 72 * H, `daysOut ${d}`);
});

test('daysBetween is calendar-day arithmetic', () => {
  assert.equal(daysBetween('2026-08-01', '2026-08-01'), 0);
  assert.equal(daysBetween('2026-08-01', '2026-08-15'), 14);
  assert.equal(daysBetween('2026-08-01', '2026-09-01'), 31);
});

test('targetKey is stable, filename-safe, and distinct per target', () => {
  const a = targetKey(cfg);
  assert.equal(a, targetKey(structuredClone(cfg)));       // deterministic
  assert.match(a, /^[a-z0-9-]+$/);                        // safe as a filename
  const other = structuredClone(cfg);
  other.fandango.formatFilter = 'IMAX';
  assert.notEqual(targetKey(other), a);
  const movie = structuredClone(cfg);
  movie.fandango.movieTitleMatch = 'Dune: Part Three';
  assert.notEqual(targetKey(movie), a);
  // partySize is not part of target identity
  const party = structuredClone(cfg);
  party.partySize = 6;
  assert.equal(targetKey(party), a);
});

test('targetKey hash guards against sanitisation collisions', () => {
  const a = structuredClone(cfg), b = structuredClone(cfg);
  a.fandango.movieTitleMatch = 'Movie: One';
  b.fandango.movieTitleMatch = 'Movie- One';   // same slug after sanitising
  assert.notEqual(targetKey(a), targetKey(b));
});

test('listMovies collects every playing title with its formats', () => {
  const payload = { viewModel: { movies: [
    { title: 'The Odyssey', variants: [{ amenityGroups: [{ showtimes: [
      { filmFormat: [{ filterName: 'IMAX 70MM' }] },
      { filmFormat: [{ filterName: 'IMAX 70MM' }, { filterName: 'Standard' }] },
    ] }] }] },
    { title: 'Dune: Part Three', variants: [{ amenityGroups: [{ showtimes: [
      { filmFormat: [{ filterName: 'Dolby Cinema' }] },
    ] }] }] },
    { variants: [] }, // untitled entries dropped
  ] } };
  const movies = listMovies(payload);
  assert.deepEqual(movies, [
    { title: 'The Odyssey', formats: ['IMAX 70MM', 'Standard'] },
    { title: 'Dune: Part Three', formats: ['Dolby Cinema'] },
  ]);
  assert.deepEqual(listMovies({}), []);
});

test('listMovies extracts a dark-preferred poster URL when present', () => {
  const payload = { viewModel: { movies: [{
    title: 'The Odyssey',
    poster: { size: { '400': 'https://img/light-400.jpg', full: 'https://img/light-full.jpg' } },
    darkPoster: { size: { '400': 'https://img/dark-400.jpg' } },
    variants: [{ amenityGroups: [{ showtimes: [{ filmFormat: [{ filterName: 'IMAX' }] }] }] }],
  }] } };
  const [m] = listMovies(payload);
  assert.equal(m.poster, 'https://img/dark-400.jpg');   // dark variant preferred
  assert.deepEqual(m.formats, ['IMAX']);
});

test('pairTotals agrees with the classifier', () => {
  const show = makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [8, 9, 10, 11], I: [1] }) });
  assert.deepEqual(pairTotals(cfg, show), { pairs: 2, usable: 5 });
});

// ---- history + trend --------------------------------------------------------

const results = () => [
  { date: '2026-08-01', shows: [
    makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [8, 9] }) }),
    makeShow({ id: 2, ticketingDate: '2026-08-01+22:00', type: 'soldout' }),
    { ...makeShow({ id: 3, ticketingDate: '2026-08-01+13:00' }), error: 'boom' },      // unobserved
    { ...makeShow({ id: 4, ticketingDate: '2026-08-01+10:00', seats: auditorium({ E: [8, 9] }) }), expired: true },
  ] },
  { date: '2026-08-02', shows: [
    makeShow({ id: 5, ticketingDate: '2026-08-02+19:00', seats: auditorium({ I: [1] }) }),
  ] },
];

test('observeResults records only genuinely observed shows', () => {
  const all = observeResults(cfg, results());
  assert.deepEqual(all, { 1: { p: 1, u: 2 }, 2: { p: 0, u: 0 }, 5: { p: 0, u: 1 } });
  // Full scans observe only the dates actually fetched this run…
  assert.deepEqual(Object.keys(observeResults(cfg, results(), { dates: new Set(['2026-08-02']) })), ['5']);
  // …watch runs only the shows they refreshed.
  assert.deepEqual(Object.keys(observeResults(cfg, results(), { ids: new Set(['1']) })), ['1']);
});

test('appendHistory caps the log', () => {
  let h = [];
  for (let i = 0; i < 45; i++) h = appendHistory(h, { at: `t${i}`, kind: 'scan', shows: {} });
  assert.equal(h.length, 40);
  assert.equal(h[0].at, 't5');
  assert.equal(h.at(-1).at, 't44');
});

test('pairlessStreak counts consecutive zero-pair observations, newest first', () => {
  const h = [
    { at: 't1', kind: 'scan', shows: { 7: { p: 2, u: 4 } } },
    { at: 't2', kind: 'watch', shows: { 7: { p: 0, u: 1 } } },
    { at: 't3', kind: 'watch', shows: {} },                    // 7 not observed — skipped
    { at: 't4', kind: 'scan', shows: { 7: { p: 0, u: 0 } } },
  ];
  assert.equal(pairlessStreak(h, 7), 2);       // t4 and t2; t1 had pairs and breaks it
  assert.equal(pairlessStreak(h, '7'), 2);     // id coerces
  assert.equal(pairlessStreak(h, 99), 0);      // never observed
  assert.equal(pairlessStreak([], 7), 0);
  assert.equal(pairlessStreak(null, 7), 0);
});

test('pairlessStreak resets when pairs reappear', () => {
  const h = [
    { at: 't1', kind: 'scan', shows: { 7: { p: 0, u: 0 } } },
    { at: 't2', kind: 'scan', shows: { 7: { p: 1, u: 2 } } },
    { at: 't3', kind: 'scan', shows: { 7: { p: 0, u: 1 } } },
  ];
  assert.equal(pairlessStreak(h, 7), 1);
});

const entry = (at, shows, kind = 'scan') => ({ at, kind, shows });

test('computeTrend needs at least two entries', () => {
  assert.equal(computeTrend(null, []), null);
  assert.equal(computeTrend([entry('2026-07-18T00:00:00Z', { 1: { p: 1, u: 2 } })], []), null);
});

test('computeTrend baseline: newest entry at least 12h older than the latest', () => {
  const h = [
    entry('2026-07-17T00:00:00Z', { 1: { p: 5, u: 9 } }),
    entry('2026-07-19T01:00:00Z', { 1: { p: 3, u: 6 } }), // 19h before newest — qualifies
    entry('2026-07-19T19:00:00Z', { 1: { p: 2, u: 4 } }), // 1h  before newest — too close
    entry('2026-07-19T20:00:00Z', { 1: { p: 2, u: 4 } }),
  ];
  const t = computeTrend(h, [{ id: 1, pairs: 1, usable: 2 }]);
  assert.equal(t.baselineAt, '2026-07-19T01:00:00Z');
  assert.deepEqual(t.perShow['1'], { wasPairs: 3, wasUsable: 6, pairsDelta: -2, usableDelta: -4 });
});

test('computeTrend falls back to the oldest entry when all are recent', () => {
  const h = [
    entry('2026-07-19T18:00:00Z', { 1: { p: 3, u: 6 } }),
    entry('2026-07-19T20:00:00Z', { 1: { p: 2, u: 4 } }),
  ];
  assert.equal(computeTrend(h, [{ id: 1, pairs: 2, usable: 4 }]).baselineAt, '2026-07-19T18:00:00Z');
});

test('computeTrend decomposes demand, calendar, and supply', () => {
  const h = [
    entry('2026-07-17T00:00:00Z', { A: { p: 2, u: 5 }, B: { p: 1, u: 2 }, C: { p: 1, u: 3 }, D: { p: 0, u: 1 } }),
    entry('2026-07-19T00:00:00Z', { A: { p: 1, u: 3 } }, 'watch'),
  ];
  const current = [
    { id: 'A', pairs: 1, usable: 3 },  // retained (fewer)
    { id: 'B', pairs: 0, usable: 0 },  // sold out of pairs
    // C absent → its date passed, NOT a sell-out
    { id: 'D', pairs: 0, usable: 1 },
    { id: 'E', pairs: 2, usable: 4 },  // new inventory
    { id: 'F', pairs: 0, usable: 0 },  // new but already pairless
  ];
  const t = computeTrend(h, current);
  assert.deepEqual(t.summary, { hadPairs: 3, lostPairs: 1, retained: 1, passed: 1, newShows: 2, newWithPairs: 1 });
  assert.deepEqual(t.newIds.sort(), ['E', 'F']);
  assert.equal(t.perShow['D'].usableDelta, 0);
});

test('computeTrend: a new week opening cannot masquerade as recovery', () => {
  // Both old shows drain to zero while 5 fresh ones open — aggregate would say
  // "2 with pairs → 5 with pairs", the decomposition says both truths.
  const h = [
    entry('2026-07-17T00:00:00Z', { A: { p: 2, u: 4 }, B: { p: 1, u: 2 } }),
    entry('2026-07-19T00:00:00Z', { A: { p: 1, u: 2 } }, 'watch'),
  ];
  const current = [
    { id: 'A', pairs: 0, usable: 0 }, { id: 'B', pairs: 0, usable: 1 },
    ...['N1', 'N2', 'N3', 'N4', 'N5'].map(id => ({ id, pairs: 1, usable: 3 })),
  ];
  const t = computeTrend(h, current);
  assert.equal(t.summary.lostPairs, 2);
  assert.equal(t.summary.retained, 0);
  assert.equal(t.summary.newShows, 5);
});

test('computeTrend: watch entries observe subsets without losing baselines', () => {
  const h = [
    entry('2026-07-17T00:00:00Z', { A: { p: 2, u: 5 }, B: { p: 1, u: 2 } }),
    entry('2026-07-18T00:00:00Z', { A: { p: 2, u: 4 } }, 'watch'),  // B unobserved here
    entry('2026-07-19T00:00:00Z', { A: { p: 1, u: 2 } }, 'watch'),
  ];
  const t = computeTrend(h, [{ id: 'A', pairs: 1, usable: 2 }, { id: 'B', pairs: 1, usable: 2 }]);
  assert.equal(t.baselineAt, '2026-07-18T00:00:00Z');
  assert.equal(t.perShow['A'].wasUsable, 4);
  assert.equal(t.perShow['B'].wasUsable, 2); // carried forward from the older full scan
});

test('calendarDates flattens per-movie day lists, optionally by hoCode', () => {
  const cal = [
    { hoCode: 'HO1', days: ['2026-08-10T00:00:00', '2026-08-11T00:00:00'] },
    { hoCode: 'HO2', days: ['2026-08-11T00:00:00', '2026-08-15T00:00:00'] },
  ];
  assert.deepEqual(calendarDates(cal), ['2026-08-10', '2026-08-11', '2026-08-15']);
  assert.deepEqual(calendarDates(cal, ['HO1']), ['2026-08-10', '2026-08-11']);
  assert.deepEqual(calendarDates({}), []);
});

test('expandTargets: no watchlist returns the legacy single target unchanged', () => {
  const legacy = { fandango: { theaterId: 'AAOPK' }, partySize: 2 };
  assert.deepEqual(expandTargets(legacy), [legacy]);
});

test('expandTargets: per-movie theatres + mode, each a legacy-shaped target', () => {
  const c = {
    partySize: 2,
    directBooking: { label: 'stale', url: 'x' },
    watchlist: {
      scanDays: 30, stopAfterEmptyDays: 3, skipPairlessAfter: 1,
      theatres: [
        { id: 'AAOPK', name: 'Hacienda', chainCode: 'REGL', slug: 'hac', directBooking: { label: 'Regal', url: 'r' } },
        { id: 'AANEM', name: 'Metreon', chainCode: 'AMC' },
        { id: 'AAACD', name: 'TCL Chinese', chainCode: '' },
      ],
      movies: [
        // Odyssey: only its 70mm subset (2 of 3 theatres), seat mode.
        { title: 'The Odyssey', match: 'Odyssey', movieId: 1, formats: ['IMAX 70MM'], theatres: ['AAOPK', 'AANEM'], mode: 'seats' },
        // Avengers: a different subset with a bogus id, two formats, onsale mode.
        { title: 'Avengers', match: 'Avengers', movieId: 2, formats: ['IMAX', 'Dolby'], theatres: ['AAACD', 'NOPE'], mode: 'onsale' },
      ],
    },
  };
  const targets = expandTargets(c);
  // Odyssey: 2 theatres x 1 format = 2. Avengers: 1 valid theatre (NOPE skipped) x 2 formats = 2.
  assert.equal(targets.length, 4);

  for (const t of targets) {
    assert.equal(t.watchlist, undefined);
    assert.equal(t.partySize, 2);
    assert.equal(t.fandango.scanDays, 30);
    assert.equal(t.fandango.skipPairlessAfter, 1);
  }

  // Mode rides on each target.
  assert.ok(targets.filter(t => t.fandango.movieTitle === 'The Odyssey').every(t => t.mode === 'seats'));
  assert.ok(targets.filter(t => t.fandango.movieTitle === 'Avengers').every(t => t.mode === 'onsale'));

  // Odyssey only hits its subset; TCL is not an Odyssey target.
  const odyTheatres = targets.filter(t => t.fandango.movieTitle === 'The Odyssey').map(t => t.fandango.theaterId);
  assert.deepEqual(odyTheatres.sort(), ['AANEM', 'AAOPK']);

  // Unknown theatre id is skipped, not scanned as a phantom.
  assert.equal(targets.some(t => t.fandango.theaterId === 'NOPE'), false);

  // Theatre metadata resolved from the pool: own directBooking kept, missing one cleared.
  const hac = targets.find(t => t.fandango.theaterId === 'AAOPK');
  const met = targets.find(t => t.fandango.theaterId === 'AANEM');
  assert.equal(hac.directBooking.label, 'Regal');
  assert.equal(hac.fandango.theaterSlug, 'hac');
  assert.equal(met.directBooking, null);
  assert.equal(met.fandango.theaterSlug, 'theater-aanem'); // slug fallback

  // Each (theatre, movie, format) is a distinct cache identity.
  const keys = new Set(targets.map(targetKey));
  assert.equal(keys.size, targets.length);
});

test('expandTargets: a movie with no theatres list falls back to the whole pool', () => {
  const c = {
    watchlist: {
      theatres: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }],
      movies: [{ title: 'M', match: 'M', formats: ['IMAX'] }],
    },
  };
  const targets = expandTargets(c);
  assert.deepEqual(targets.map(t => t.fandango.theaterId).sort(), ['A', 'B']);
  assert.ok(targets.every(t => t.mode === 'seats')); // default mode
});

// ---- mutation-driven additions ----------------------------------------------
// Oracle: README "Scan modes" (tiered freshness), "Per-target scan caches",
// "Sell-rate trend", and the hand-worked values in each comment.
import { sameTarget, TTL_TIERS } from '../src/scan-core.mjs';

const showtime = (over = {}) => ({
  id: 7, showtimeHashCode: 'h7', date: '7:00p', ticketingDate: '2026-08-01+19:00', type: 'available',
  expired: false, filmFormat: [{ filterName: 'IMAX 70MM' }], ...over,
});
const odysseyPayload = (...showtimes) => ({ viewModel: { movies: [{ title: 'The Odyssey', variants: [{ amenityGroups: [{ showtimes }] }] }] } });

test('isoPlusDays moves forward and back by whole days, leap day included', () => {
  assert.equal(isoPlusDays('2026-03-01', -1), '2026-02-28');
  assert.equal(isoPlusDays('2028-02-28', 1), '2028-02-29');
  assert.equal(isoPlusDays('2026-08-01', 30), '2026-08-31');
  assert.equal(isoPlusDays('2026-08-10', -10), '2026-07-31');
});

test('matchingShowtimes returns each match with its stored fields', () => {
  assert.deepEqual(matchingShowtimes(odysseyPayload(showtime()), fd), [{
    movieTitle: 'The Odyssey', id: 7, hash: 'h7', timeLabel: '7:00p', ticketingDate: '2026-08-01+19:00',
    type: 'available', expired: false, formats: ['IMAX 70MM'],
  }]);
});

test('matchingShowtimes: expired is a strict boolean, truthy or missing', () => {
  const [a, b, c] = matchingShowtimes(odysseyPayload(showtime({ expired: true }), showtime({ expired: undefined }), showtime({ expired: 1 })), fd);
  assert.equal(a.expired, true);
  assert.equal(b.expired, false);
  assert.equal(c.expired, true);
});

test('matchingShowtimes needs the exact format name, and skips showtimes with no formats', () => {
  const p = odysseyPayload(showtime({ id: 1, filmFormat: [{ filterName: 'IMAX' }] }), showtime({ id: 2, filmFormat: undefined }), showtime({ id: 3 }));
  assert.deepEqual(matchingShowtimes(p, fd).map(s => s.id), [3]);
});

test('matchingShowtimes treats the title match as a case-insensitive pattern found anywhere in the title', () => {
  const payload = { viewModel: { movies: [
    { title: 'The Odyssey: Extended Cut', variants: [{ amenityGroups: [{ showtimes: [showtime({ id: 1 })] }] }] },
    { title: 'Dune', variants: [{ amenityGroups: [{ showtimes: [showtime({ id: 2 })] }] }] },
    { variants: [{ amenityGroups: [{ showtimes: [showtime({ id: 3 })] }] }] }, // untitled
  ] } };
  assert.deepEqual(matchingShowtimes(payload, { ...fd, movieTitleMatch: 'odys+ey|dune' }).map(s => s.id), [1, 2]);
  assert.deepEqual(matchingShowtimes(payload, fd).map(s => s.id), [1]);
});

test('matchingShowtimes walks every variant and amenity group, in order', () => {
  const payload = { viewModel: { movies: [{ title: 'The Odyssey', variants: [
    { amenityGroups: [{ showtimes: [showtime({ id: 1 })] }, { showtimes: [showtime({ id: 2 })] }] },
    { amenityGroups: [{ showtimes: [showtime({ id: 3 })] }, {}] },
    {},
  ] }, { title: 'Odyssey Redux' }] } };
  assert.deepEqual(matchingShowtimes(payload, fd).map(s => s.id), [1, 2, 3]);
});

test('matchingShowtimes prefers viewModel.movies over a top-level movies list', () => {
  const payload = { ...odysseyPayload(showtime({ id: 1 })), movies: odysseyPayload(showtime({ id: 2 })).viewModel.movies };
  assert.deepEqual(matchingShowtimes(payload, fd).map(s => s.id), [1]);
});

test('compactSeatMap keeps the stored seat shape and tolerates a map with no seats', () => {
  assert.deepEqual(compactSeatMap({ auditoriumId: 3, totalAvailableSeatCount: 0, totalSeatCount: 0 }),
    { auditoriumId: 3, totalAvailable: 0, totalSeats: 0, seats: [] });
});

test('dateIsClean: only null or missing errors count as no error', () => {
  const ok = makeShow({ id: 1, ticketingDate: 'x', seats: auditorium() });
  assert.equal(dateIsClean({ date: 'd', shows: [ok] }), true);                       // no errors list at all
  assert.equal(dateIsClean({ date: 'd', errors: [], shows: [] }), true);              // nothing to fetch
  assert.equal(dateIsClean({ date: 'd', errors: [], shows: [{ ...ok, error: null }] }), true);
  assert.ok(!dateIsClean({ date: 'd', errors: [], shows: [{ ...ok, error: 'timeout' }] }));
  assert.ok(!dateIsClean(undefined));
});

test('dateIsClean: an unknown show type needs no seat map either', () => {
  assert.equal(dateIsClean({ date: 'd', errors: [], shows: [{ ...makeShow({ id: 1, ticketingDate: 'x' }), type: 'cancelled' }] }), true);
});

test('freshness tiers are 3 days / 14 days / beyond, with 0, 24 and 72 hours (README)', () => {
  assert.deepEqual(TTL_TIERS, [
    { maxDaysOut: 3, hours: 0 }, { maxDaysOut: 14, hours: 24 }, { maxDaysOut: Infinity, hours: 72 },
  ]);
  assert.equal(ttlMs(-2), 0);   // a date already behind us is always re-fetched
});

test('daysBetween is signed', () => {
  assert.equal(daysBetween('2026-08-15', '2026-08-01'), -14);
  assert.equal(daysBetween('2026-01-01', '2027-01-01'), 365);
});

test('sameTarget: each of theatre, chain, movie and format alone breaks the match', () => {
  const same = () => structuredClone(cfg);
  assert.equal(sameTarget(same(), same()), true);
  for (const key of ['theaterId', 'chainCode', 'movieTitleMatch', 'formatFilter']) {
    const other = same();
    other.fandango[key] = 'different';
    assert.equal(sameTarget(cfg, other), false, key);
  }
  for (const key of ['movieId', 'scanDays', 'theaterSlug', 'stopAfterEmptyDays']) {
    const other = same();
    other.fandango[key] = 'different';
    assert.equal(sameTarget(cfg, other), true, `${key} is not part of the identity`);
  }
});

test('sameTarget is false (not just falsy) when either side has no fandango block', () => {
  assert.equal(sameTarget(null, cfg), false);
  assert.equal(sameTarget(undefined, cfg), false);
  assert.equal(sameTarget({}, cfg), false);
  assert.equal(sameTarget(cfg, {}), false);
});

const splitKey = (key) => { const i = key.lastIndexOf('-'); return { slug: key.slice(0, i), hash: key.slice(i + 1) }; };
const keyFor = (over) => { const c = structuredClone(cfg); Object.assign(c.fandango, over); return targetKey(c); };

test('targetKey is a readable slug of theatre, chain, format and movie, then a hash', () => {
  const { slug, hash } = splitKey(targetKey(cfg));
  assert.equal(slug, 'test1-regl-imax-70mm-odyssey');   // "TEST1|REGL|IMAX 70MM|Odyssey" lowercased, non-alphanumerics -> "-"
  assert.match(hash, /^[0-9a-f]+$/);
});

test('targetKey trims separators off both ends of the slug and caps it at 60 characters', () => {
  assert.equal(splitKey(keyFor({ theaterId: '!!AB', movieTitleMatch: 'Dune!' })).slug, 'ab-regl-imax-70mm-dune');
  const long = splitKey(keyFor({ movieTitleMatch: 'a'.repeat(100) }));
  assert.equal(long.slug, ('test1-regl-imax-70mm-' + 'a'.repeat(100)).slice(0, 60));
  assert.equal(long.slug.length, 60);
});

test('targetKey: the hash tells apart targets whose slugs collide, at either end of the text', () => {
  const keys = [
    keyFor({ theaterId: '!A' }), keyFor({ theaterId: '?A' }),               // first character differs
    keyFor({ movieTitleMatch: 'M!' }), keyFor({ movieTitleMatch: 'M?' }),   // last character differs
    keyFor({ movieTitleMatch: 'ODYSSEY' }), keyFor({ movieTitleMatch: 'odyssey' }), // case differs
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('targetKey hashes are lowercase hexadecimal', () => {
  const hashes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].map(m => splitKey(keyFor({ movieTitleMatch: `Movie ${m}` })).hash);
  for (const h of hashes) assert.match(h, /^[0-9a-f]+$/);
  assert.ok(hashes.some(h => /[a-f]/.test(h)), 'at least one hash needs a-f digits; decimal-only means the radix is wrong');
});

test('expandTargets: defaults are 40 days, 4 empty days, skip pairless after 2', () => {
  const [t] = expandTargets({ watchlist: { theatres: [{ id: 'A', name: 'A' }], movies: [{ title: 'M', match: 'M', formats: ['F'] }] } });
  assert.equal(t.fandango.scanDays, 40);
  assert.equal(t.fandango.stopAfterEmptyDays, 4);
  assert.equal(t.fandango.skipPairlessAfter, 2);
});

test('expandTargets: the watchlist wins over the legacy fandango block, which wins over the defaults', () => {
  const legacy = { scanDays: 25, stopAfterEmptyDays: 7, skipPairlessAfter: 5 };
  const w = { theatres: [{ id: 'A', name: 'A' }], movies: [{ title: 'M', match: 'M', formats: ['F'] }] };
  const [fromLegacy] = expandTargets({ fandango: legacy, watchlist: w });
  assert.deepEqual([fromLegacy.fandango.scanDays, fromLegacy.fandango.stopAfterEmptyDays, fromLegacy.fandango.skipPairlessAfter], [25, 7, 5]);
  const [fromList] = expandTargets({ fandango: legacy, watchlist: { ...w, scanDays: 10, stopAfterEmptyDays: 2, skipPairlessAfter: 1 } });
  assert.deepEqual([fromList.fandango.scanDays, fromList.fandango.stopAfterEmptyDays, fromList.fandango.skipPairlessAfter], [10, 2, 1]);
});

test('expandTargets returns the config itself when the watchlist is malformed or yields nothing', () => {
  const noMovies = { watchlist: { theatres: [{ id: 'A', name: 'A' }], movies: null } };
  const noTheatres = { watchlist: { theatres: 'A', movies: [] } };
  const allUnknown = { watchlist: { theatres: [{ id: 'A', name: 'A' }], movies: [{ title: 'M', match: 'M', formats: ['F'], theatres: ['ZZ'] }] } };
  const noFormats = { watchlist: { theatres: [{ id: 'A', name: 'A' }], movies: [{ title: 'M', match: 'M' }] } };
  for (const c of [noMovies, noTheatres, allUnknown, noFormats]) assert.deepEqual(expandTargets(c), [c]);
  assert.equal(expandTargets(noMovies)[0], noMovies);
  assert.equal(expandTargets(allUnknown)[0], allUnknown);
});

test('expandTargets: an empty theatres list on a movie means the whole pool', () => {
  const c = { watchlist: { theatres: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], movies: [{ title: 'M', match: 'M', formats: ['F'], theatres: [] }] } };
  assert.deepEqual(expandTargets(c).map(t => t.fandango.theaterId), ['A', 'B']);
});

test('expandTargets: movies, then theatres, then formats, each target fully described', () => {
  const c = {
    partySize: 3, theatreName: 'legacy', fandango: { theaterId: 'OLD', formatFilter: 'OLDFMT', scanDays: 40 },
    watchlist: {
      theatres: [{ id: 'T1', name: 'One', chainCode: 'REGL', slug: 'one-t1' }, { id: 'T2', name: 'Two' }],
      movies: [
        { title: 'Alpha', match: 'Al', movieId: 11, formats: ['F1', 'F2'] },
        { title: 'Beta', match: 'Be', movieId: 22, formats: ['F1'], theatres: ['T2'], mode: 'onsale' },
      ],
    },
  };
  const targets = expandTargets(c);
  assert.deepEqual(targets.map(t => `${t.fandango.movieTitle}/${t.fandango.theaterId}/${t.fandango.formatFilter}`),
    ['Alpha/T1/F1', 'Alpha/T1/F2', 'Alpha/T2/F1', 'Alpha/T2/F2', 'Beta/T2/F1']);
  assert.deepEqual(targets[0].fandango, {
    theaterId: 'T1', theaterSlug: 'one-t1', chainCode: 'REGL', movieTitleMatch: 'Al', movieId: 11, movieTitle: 'Alpha',
    formatFilter: 'F1', scanDays: 40, stopAfterEmptyDays: 4, skipPairlessAfter: 2,
  });
  assert.deepEqual(targets[2].fandango.theaterSlug, 'theater-t2');   // no slug in the pool entry
  assert.equal(targets[2].fandango.chainCode, '');
  assert.equal(targets[0].theatreName, 'One');
  assert.equal(targets[0].partySize, 3);
  assert.equal(targets[0].mode, 'seats');
  assert.equal(targets[4].mode, 'onsale');
  assert.ok('watchlist' in c, 'the input config keeps its watchlist');
});

test('listMovies: no variants means no formats, blank format names are skipped', () => {
  const payload = { viewModel: { movies: [
    { title: 'Bare' },
    { title: 'Blank', variants: [{ amenityGroups: [{ showtimes: [{ filmFormat: [{ filterName: '' }, { filterName: 'IMAX' }] }, {}] }, {}] }, {}] },
  ] } };
  assert.deepEqual(listMovies(payload), [{ title: 'Bare', formats: [] }, { title: 'Blank', formats: ['IMAX'] }]);
  assert.deepEqual(listMovies({ movies: [{ title: 'Top', variants: [] }] }), [{ title: 'Top', formats: [] }]);
});

const posterOfMovie = (m) => listMovies({ viewModel: { movies: [{ title: 'T', ...m }] } })[0];

test('poster: the biggest listed size wins (full, then 500, 400, 300)', () => {
  const sizes = { full: 'https://i/full.jpg', 500: 'https://i/500.jpg', 400: 'https://i/400.jpg', 300: 'https://i/300.jpg' };
  assert.equal(posterOfMovie({ poster: { size: sizes } }).poster, 'https://i/full.jpg');
  const { full: _full, ...withoutFull } = sizes;
  assert.equal(posterOfMovie({ poster: { size: withoutFull } }).poster, 'https://i/500.jpg');
  const { 500: _500, ...without500 } = withoutFull;
  assert.equal(posterOfMovie({ poster: { size: without500 } }).poster, 'https://i/400.jpg');
  assert.equal(posterOfMovie({ poster: { size: { 300: 'https://i/300.jpg' } } }).poster, 'https://i/300.jpg');
});

test('poster: a dark variant without a usable URL falls back to the light one', () => {
  const light = { size: { full: 'https://i/light.jpg' } };
  for (const dark of [undefined, null, { size: null }, { size: {} }, { size: { full: 'ftp://i/dark.jpg' } }, { size: { full: 42 } }]) {
    assert.equal(posterOfMovie({ darkPoster: dark, poster: light }).poster, 'https://i/light.jpg', JSON.stringify(dark));
  }
});

test('poster: an ImageRenderer URL is re-requested at 640 px wide', () => {
  // Pinned from code (640 is the retina width its comment names), not a README rule.
  assert.equal(posterOfMovie({ poster: { size: { full: 'https://images.example.com/ImageRenderer/100/fandango/p123/poster.jpg' } } }).poster,
    'https://images.example.com/ImageRenderer/640/fandango/p123/poster.jpg');
  assert.equal(posterOfMovie({ poster: { size: { full: 'https://img/plain.jpg' } } }).poster, 'https://img/plain.jpg'); // no width segment: untouched
});

test('poster: flat fallback fields are tried in order and need an http(s) URL', () => {
  const fields = ['posterImage', 'image', 'imageUrl', 'thumbnailUrl'];
  for (const f of fields) assert.equal(posterOfMovie({ [f]: 'https://i/flat.jpg' }).poster, 'https://i/flat.jpg', f);
  assert.equal(posterOfMovie({ media: { posterImage: 'https://i/m1.jpg' } }).poster, 'https://i/m1.jpg');
  assert.equal(posterOfMovie({ media: { image: 'http://i/m2.jpg' } }).poster, 'http://i/m2.jpg');
  assert.equal(posterOfMovie({ image: 'https://i/second.jpg', posterImage: 'https://i/first.jpg' }).poster, 'https://i/first.jpg');
  assert.equal(posterOfMovie({ posterImage: '/relative.jpg', image: 'https://i/ok.jpg' }).poster, 'https://i/ok.jpg');
  assert.equal(posterOfMovie({ posterImage: 42, image: 'https://i/ok.jpg' }).poster, 'https://i/ok.jpg');
});

test('poster: structured sizes beat flat fields, and no poster means no poster key', () => {
  assert.equal(posterOfMovie({ posterImage: 'https://i/flat.jpg', poster: { size: { 400: 'https://i/s.jpg' } } }).poster, 'https://i/s.jpg');
  const none = posterOfMovie({ posterImage: 'not a url' });
  assert.deepEqual(none, { title: 'T', formats: [] });
  assert.equal('poster' in none, false);
});

test('pairTotals counts usable seats in every tier but not front rows or accessible seats', () => {
  // E8,E9 center pair · D8 mid-back single · I1 flexible single · A5 front · E1 open wheelchair seat
  const show = makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [1, 8, 9], D: [8], I: [1], A: [5] }, { E: [1] }) });
  assert.deepEqual(pairTotals(cfg, show), { pairs: 1, usable: 4 });
});

test('pairTotals adds the groups of every tier', () => {
  // E8,E9 center pair · D8,D9 mid-back pair · I1,I2 flexible pair
  const show = makeShow({ id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [8, 9], D: [8, 9], I: [1, 2] }) });
  assert.deepEqual(pairTotals(cfg, show), { pairs: 3, usable: 6 });
});

test('observeResults: a sold-out show that still carries a seat map is read from the map', () => {
  const soldWithMap = makeShow({ id: 8, ticketingDate: 'x', type: 'soldout', seats: auditorium({ E: [8, 9] }) });
  assert.deepEqual(observeResults(cfg, [{ date: 'd', shows: [soldWithMap] }]), { 8: { p: 1, u: 2 } });
});

test('observeResults: dates and ids filters combine, and expired shows never count', () => {
  assert.deepEqual(observeResults(cfg, results(), { dates: new Set(['2026-08-01']), ids: new Set(['5']) }), {});
  assert.deepEqual(Object.keys(observeResults(cfg, results(), { dates: new Set(['2026-08-01']), ids: new Set(['1', '4']) })), ['1']); // 4 is expired
});

test('appendHistory: a custom cap, a missing history, and the input left alone', () => {
  assert.deepEqual(appendHistory(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  assert.deepEqual(appendHistory(undefined, 'a'), ['a']);
  const h = ['a'];
  appendHistory(h, 'b');
  assert.deepEqual(h, ['a']);
  const forty = Array.from({ length: 40 }, (_, i) => i);
  assert.equal(appendHistory(forty.slice(0, 39), 39).length, 40);   // 40 entries fit under the default cap
  assert.equal(appendHistory(forty, 40)[0], 1);                     // the 41st pushes the oldest out
});

test('pairlessStreak counts the oldest observation too, and shrugs off empty entries', () => {
  assert.equal(pairlessStreak([{ at: 't1', shows: { 7: { p: 0, u: 0 } } }], 7), 1);
  assert.equal(pairlessStreak([{ at: 't1', shows: { 7: { p: 0, u: 0 } } }, { at: 't2', shows: { 7: { p: 0, u: 1 } } }], 7), 2);
  assert.equal(pairlessStreak([null, { at: 't0' }, { at: 't1', shows: null }, { at: 't2', shows: { 7: { p: 0, u: 0 } } }], 7), 1);
  assert.equal(pairlessStreak(undefined, 7), 0);
});

test('computeTrend: a baseline exactly 12 h older qualifies, one minute short does not', () => {
  const at = (iso, p) => entry(iso, { A: { p, u: p * 2 } });
  const oldest = at('2026-07-17T20:00:00Z', 3);
  const newest = at('2026-07-19T12:00:00Z', 1);
  const exact = computeTrend([oldest, at('2026-07-19T00:00:00Z', 2), newest], [{ id: 'A', pairs: 1, usable: 2 }]);
  assert.equal(exact.baselineAt, '2026-07-19T00:00:00Z');
  const short = computeTrend([oldest, at('2026-07-19T00:01:00Z', 2), newest], [{ id: 'A', pairs: 1, usable: 2 }]);
  assert.equal(short.baselineAt, '2026-07-17T20:00:00Z');
});

test('computeTrend: the minimum gap is a parameter, and a zero gap leaves no baseline', () => {
  const h = [entry('2026-07-17T00:00:00Z', { A: { p: 3, u: 6 } }), entry('2026-07-19T00:00:00Z', { A: { p: 2, u: 4 } }), entry('2026-07-19T12:00:00Z', { A: { p: 1, u: 2 } })];
  const cur = [{ id: 'A', pairs: 1, usable: 2 }];
  assert.equal(computeTrend(h, cur, 24).baselineAt, '2026-07-17T00:00:00Z'); // the 12 h-old entry is too close for 24 h
  assert.equal(computeTrend(h, cur, 0), null);                                // newest qualifies against itself
});

test('computeTrend needs a list of entries', () => {
  for (const bad of [undefined, 'abc', {}, 7]) assert.equal(computeTrend(bad, []), null);
});

test('computeTrend: baseline values come from at or before the baseline, never after it', () => {
  const h = [
    entry('2026-07-17T00:00:00Z', { A: { p: 2, u: 5 } }),
    entry('2026-07-18T16:00:00Z', { A: { p: 1, u: 3 } }),            // baseline: 20 h before newest
    entry('2026-07-19T10:00:00Z', { A: { p: 0, u: 0 }, X: { p: 1, u: 2 } }, 'watch'), // later than the baseline
    entry('2026-07-19T12:00:00Z', { Y: { p: 2, u: 4 } }, 'watch'),
  ];
  const t = computeTrend(h, [{ id: 'A', pairs: 0, usable: 1 }, { id: 'X', pairs: 1, usable: 2 }, { id: 'Y', pairs: 2, usable: 4 }]);
  assert.equal(t.baselineAt, '2026-07-18T16:00:00Z');
  assert.deepEqual(t.perShow['A'], { wasPairs: 1, wasUsable: 3, pairsDelta: -1, usableDelta: -2 });
  assert.equal('X' in t.perShow, false);                 // first seen after the baseline: no "was" to compare
  assert.deepEqual(t.newIds, ['Y']);                     // X was observed before the newest entry; only Y is first seen there
  assert.deepEqual(t.summary, { hadPairs: 1, lostPairs: 1, retained: 0, passed: 0, newShows: 1, newWithPairs: 1 });
});

test('computeTrend: a show that had no pairs is compared but never counted as lost', () => {
  const h = [entry('2026-07-17T00:00:00Z', { D: { p: 0, u: 1 } }), entry('2026-07-19T00:00:00Z', { D: { p: 0, u: 1 } })];
  const t = computeTrend(h, [{ id: 'D', pairs: 1, usable: 3 }]);
  assert.deepEqual(t.perShow['D'], { wasPairs: 0, wasUsable: 1, pairsDelta: 1, usableDelta: 2 });
  assert.deepEqual(t.summary, { hadPairs: 0, lostPairs: 0, retained: 0, passed: 0, newShows: 0, newWithPairs: 0 });
});

test('computeTrend: entries without a shows list are skipped, shows gone from the report are not compared', () => {
  const h = [{ at: '2026-07-17T00:00:00Z', kind: 'scan', shows: null }, entry('2026-07-18T00:00:00Z', { A: { p: 1, u: 2 }, B: { p: 0, u: 0 } }), entry('2026-07-19T00:00:00Z', {})];
  const t = computeTrend(h, [{ id: 'A', pairs: 1, usable: 2 }]);
  assert.deepEqual(Object.keys(t.perShow), ['A']);                  // B left the report: no comparison row
  assert.equal(t.summary.retained, 1);
  assert.deepEqual(t.newIds, []);
});

test('computeTrend: new shows are listed in report order and counted with pairs', () => {
  const h = [entry('2026-07-17T00:00:00Z', { A: { p: 1, u: 2 } }), entry('2026-07-19T00:00:00Z', { A: { p: 1, u: 2 } })];
  const t = computeTrend(h, [{ id: 'N2', pairs: 0, usable: 0 }, { id: 'A', pairs: 1, usable: 2 }, { id: 'N1', pairs: 2, usable: 4 }, { id: 3, pairs: 1, usable: 2 }]);
  assert.deepEqual(t.newIds, ['N2', 'N1', '3']);
  assert.equal(t.summary.newShows, 3);
  assert.equal(t.summary.newWithPairs, 2);
});
