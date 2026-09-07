import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScoutRequest, escapeRegex, upsertProfile, profileFromCfg, bookingBrand, MAX_PROFILES } from '../src/app-core.mjs';
import { sameTarget } from '../src/scan-core.mjs';
import { cfg } from './helpers.mjs';

const base = () => structuredClone(cfg);

test('escapeRegex neutralises regex metacharacters', () => {
  assert.equal(escapeRegex('Mission: Impossible (Part 1+2)?'), 'Mission: Impossible \\(Part 1\\+2\\)\\?');
  assert.ok(new RegExp(escapeRegex('2001: A Space Odyssey [4K]'), 'i').test('2001: a space odyssey [4k]'));
});

test('a valid submission updates movie, format, party size, and horizon', () => {
  const { cfg: next, targetChanged, errors } = applyScoutRequest(base(), {
    movie: '  Dune: Part Three ', format: 'IMAX', partySize: 4, scanDays: 14,
  });
  assert.deepEqual(errors, []);
  assert.equal(next.fandango.movieTitle, 'Dune: Part Three');
  assert.equal(next.fandango.movieTitleMatch, 'Dune: Part Three');
  assert.equal(next.fandango.formatFilter, 'IMAX');
  assert.equal(next.partySize, 4);
  assert.equal(next.fandango.scanDays, 14);
  assert.equal(targetChanged, true);
});

test('same target resubmitted is not a target change', () => {
  const first = applyScoutRequest(base(), { movie: 'Odyssey', format: 'IMAX 70MM', partySize: 2, scanDays: 40 });
  assert.deepEqual(first.errors, []);
  assert.equal(first.targetChanged, false); // movieTitleMatch already 'Odyssey'
});

test('party size change alone is not a target change (no re-scan needed)', () => {
  const { targetChanged, errors } = applyScoutRequest(base(), {
    movie: 'Odyssey', format: 'IMAX 70MM', partySize: 3, scanDays: 40,
  });
  assert.deepEqual(errors, []);
  assert.equal(targetChanged, false);
});

test('missing movie or format rejects and leaves config untouched', () => {
  const original = base();
  const r1 = applyScoutRequest(original, { movie: '  ', format: 'IMAX' });
  assert.ok(r1.errors.includes('movie is required'));
  assert.equal(r1.cfg, original);
  const r2 = applyScoutRequest(original, { movie: 'Dune', format: '' });
  assert.ok(r2.errors.includes('format is required'));
});

test('party size and horizon are clamped to sane ranges', () => {
  const { cfg: next } = applyScoutRequest(base(), { movie: 'X', format: 'Y', partySize: 99, scanDays: 2 });
  assert.equal(next.partySize, 8);
  assert.equal(next.fandango.scanDays, 7);
  const { cfg: next2 } = applyScoutRequest(base(), { movie: 'X', format: 'Y', partySize: 'nope', scanDays: 'nah' });
  assert.equal(next2.partySize, cfg.partySize);
  assert.equal(next2.fandango.scanDays, cfg.fandango.scanDays);
});

test('theatre fields are validated and normalised', () => {
  const { cfg: next, errors } = applyScoutRequest(base(), {
    movie: 'X', format: 'Y',
    theatre: { name: 'AMC Metreon', theaterId: 'aabbc', theaterSlug: 'amc-metreon-16-aabbc', chainCode: 'amc' },
  });
  assert.deepEqual(errors, []);
  assert.equal(next.theatreName, 'AMC Metreon');
  assert.equal(next.fandango.theaterId, 'AABBC');
  assert.equal(next.fandango.chainCode, 'AMC');
  assert.equal(next.fandango.theaterSlug, 'amc-metreon-16-aabbc');
});

test('junk theatre id is rejected', () => {
  const { errors } = applyScoutRequest(base(), {
    movie: 'X', format: 'Y', theatre: { theaterId: 'not valid!!' },
  });
  assert.ok(errors.some(e => e.includes('theaterId')));
});

test('changing the movie drops the stale poster', () => {
  const withPoster = { ...base(), posterFile: 'data/poster.jpg' };
  const { cfg: next } = applyScoutRequest(withPoster, { movie: 'Dune', format: 'IMAX 70MM' });
  assert.ok(!('posterFile' in next));
  const { cfg: same } = applyScoutRequest(withPoster, { movie: 'Odyssey', format: 'IMAX 70MM' });
  assert.equal(same.posterFile, 'data/poster.jpg');
});

test('bookingBrand: known chains by name, otherwise the domain, never a verb', () => {
  assert.equal(bookingBrand('https://www.regmovies.com/theatres/x-0347'), 'Regal');
  assert.equal(bookingBrand('https://amctheatres.com/movies/x'), 'AMC');
  assert.equal(bookingBrand('https://www.alamodrafthouse.com/x'), 'Alamodrafthouse');
  assert.equal(bookingBrand('not a url'), 'Book direct');
});

test('direct booking URL: https accepted, junk rejected, empty clears', () => {
  const withDirect = { ...base(), directBooking: { label: 'Book direct', url: 'https://old.example/x' } };

  const ok = applyScoutRequest(base(), {
    movie: 'X', format: 'Y', theatre: { directUrl: 'https://www.regmovies.com/theatres/x-0347' },
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.cfg.directBooking.url, 'https://www.regmovies.com/theatres/x-0347');
  assert.equal(ok.cfg.directBooking.label, 'Regal'); // button says the brand, nothing else

  const bad = applyScoutRequest(base(), { movie: 'X', format: 'Y', theatre: { directUrl: 'http://insecure.example' } });
  assert.ok(bad.errors.some(e => e.includes('direct booking')));

  const cleared = applyScoutRequest(withDirect, { movie: 'X', format: 'Y', theatre: { directUrl: '' } });
  assert.ok(!('directBooking' in cleared.cfg));
});

test('switching theatres without a new direct URL drops the stale link', () => {
  const withDirect = { ...base(), directBooking: { label: 'Book direct', url: 'https://old.example/x' } };
  const { cfg: next, errors } = applyScoutRequest(withDirect, {
    movie: 'X', format: 'Y', theatre: { theaterId: 'NEWID' },
  });
  assert.deepEqual(errors, []);
  assert.equal(next.fandango.theaterId, 'NEWID');
  assert.ok(!('directBooking' in next));
});

test('profileFromCfg captures everything the form needs', () => {
  const p = profileFromCfg(base(), '2026-07-19T00:00:00.000Z');
  assert.equal(p.movie, 'Odyssey');
  assert.equal(p.format, 'IMAX 70MM');
  assert.equal(p.partySize, 2);
  assert.equal(p.scanDays, 40);
  assert.equal(p.theatre.theaterId, 'TEST1');
  assert.ok(p.key);
});

test('upsertProfile dedupes by target, newest first, capped', () => {
  let profiles = upsertProfile([], base(), 't1');
  // Same target again: refreshed in place, not duplicated.
  const resized = { ...base(), partySize: 5 };
  profiles = upsertProfile(profiles, resized, 't2');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].partySize, 5);
  assert.equal(profiles[0].lastUsed, 't2');
  // A different movie gets its own slot at the front.
  const dune = base();
  dune.fandango.movieTitleMatch = 'Dune';
  dune.fandango.movieTitle = 'Dune';
  profiles = upsertProfile(profiles, dune, 't3');
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].movie, 'Dune');
  // The list never grows past the cap.
  for (let i = 0; i < MAX_PROFILES + 3; i++) {
    const c = base();
    c.fandango.movieTitleMatch = `Movie ${i}`;
    profiles = upsertProfile(profiles, c, `t${i + 4}`);
  }
  assert.equal(profiles.length, MAX_PROFILES);
  assert.equal(profiles[0].movie, `Movie ${MAX_PROFILES + 2}`);
});

test('sameTarget compares the four identity fields only', () => {
  const a = base(), b = base();
  assert.ok(sameTarget(a, b));
  b.partySize = 6;
  assert.ok(sameTarget(a, b), 'partySize must not invalidate the seat-map cache');
  b.fandango.formatFilter = 'IMAX';
  assert.ok(!sameTarget(a, b));
  assert.ok(!sameTarget(null, b));
  assert.ok(!sameTarget({}, b));
});
