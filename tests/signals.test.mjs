// The public signals file is the contract the hosted site reads. Guard the two
// things the site depends on: every show carries counts only (never a seat
// grid), and each theatre carries the location/metro fields joined from the
// live watchlist pool so the nearest-first sort works without a rescan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals } from '../src/signals.mjs';
import { cfg, makeScan } from './helpers.mjs';

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
  assert.ok(th.shows.length > 0);
  for (const s of th.shows) {
    assert.deepEqual(Object.keys(s).sort(), ['bookingUrl', 'dateISO', 'dayLabel', 'id', 'open', 'pairs', 'part', 'pctFull', 'status', 'tier', 'timeLabel', 'usable', 'workHours']);
    assert.deepEqual(Object.keys(s.open).sort(), ['center', 'flexible', 'midBack']);
    assert.equal('seatMap' in s, false);
  }
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
  assert.equal(th.lat, null);
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
