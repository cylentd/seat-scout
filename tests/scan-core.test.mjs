import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoPlusDays, matchingShowtimes, compactSeatMap, dateIsClean,
  ttlMs, daysBetween, pairTotals, targetKey, listMovies,
  observeResults, appendHistory, pairlessStreak, computeTrend, calendarDates,
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
