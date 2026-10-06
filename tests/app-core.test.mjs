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

// ---- mutation-driven additions ----------------------------------------------
import { targetKey } from '../src/scan-core.mjs';

const submit = (extra, config = base()) => applyScoutRequest(config, { movie: 'X', format: 'Y', ...extra });
const withDirectLink = () => ({ ...base(), directBooking: { label: 'Book direct', url: 'https://old.example/x' } });
const DIRECT_ERR = 'direct booking URL looks invalid (must be https)';

test('escapeRegex escapes every regex metacharacter', () => {
  for (const ch of '.*+?^${}()|[]\\') assert.equal(escapeRegex(ch), '\\' + ch, `char ${ch}`);
  assert.equal(escapeRegex('a.b.c'), 'a\\.b\\.c');            // every occurrence, not just the first
  assert.equal(escapeRegex('Dune Part 2'), 'Dune Part 2');    // plain text is left alone
});

test('movie title becomes a literal, escaped match pattern', () => {
  const { cfg: next } = submit({ movie: 'Dune (2026)' });
  assert.equal(next.fandango.movieTitle, 'Dune (2026)');
  assert.equal(next.fandango.movieTitleMatch, 'Dune \\(2026\\)');
});

test('an empty or missing body reports both required fields and changes nothing', () => {
  for (const body of [null, undefined, {}]) {
    const original = base();
    const r = applyScoutRequest(original, body);
    assert.deepEqual(r.errors, ['movie is required', 'format is required']);
    assert.equal(r.targetChanged, false);
    assert.equal(r.cfg, original);
  }
  assert.deepEqual(applyScoutRequest(base(), { movie: 5, format: ['IMAX'] }).errors,
    ['movie is required', 'format is required']); // only strings count
});

test('an invalid submission never reports a target change, even if the movie differs', () => {
  const r = applyScoutRequest(base(), { movie: 'Dune', format: '' });
  assert.deepEqual(r.errors, ['format is required']);
  assert.equal(r.targetChanged, false);
});

test('a submission leaves the config it was given untouched', () => {
  const original = base();
  const snapshot = JSON.stringify(original);
  applyScoutRequest(original, { movie: 'Dune', format: 'IMAX', partySize: 5, scanDays: 20, theatre: { name: 'New', theaterId: 'NEWID' } });
  assert.equal(JSON.stringify(original), snapshot);
});

test('text fields are trimmed and cut to their length limits', () => {
  const { cfg: next, errors } = submit({
    movie: 'M'.repeat(101), format: 'F'.repeat(41),
    theatre: { name: '  ' + 'N'.repeat(81), theaterId: 'abcdefghijk', theaterSlug: 'a'.repeat(121), chainCode: 'abcdefghi' },
  });
  assert.deepEqual(errors, []);
  assert.equal(next.fandango.movieTitle, 'M'.repeat(100));
  assert.equal(next.fandango.formatFilter, 'F'.repeat(40));
  assert.equal(next.theatreName, 'N'.repeat(80));
  assert.equal(next.fandango.theaterId, 'ABCDEFGHIJ');   // 10 characters, uppercased
  assert.equal(next.fandango.theaterSlug, 'a'.repeat(120));
  assert.equal(next.fandango.chainCode, 'ABCDEFGH');     // 8 characters, uppercased
  assert.equal(submit({ movie: '  Dune  ' }).cfg.fandango.movieTitle, 'Dune');
});

test('party size is clamped to 1..8 and scan days to 7..60, junk keeps the current value', () => {
  const size = (v) => submit({ partySize: v }).cfg.partySize;
  assert.equal(size(0), 1);
  assert.equal(size(1), 1);
  assert.equal(size(2), 2);
  assert.equal(size(8), 8);
  assert.equal(size(9), 8);
  assert.equal(size(-5), 1);
  assert.equal(size('3.9'), 3);        // parseInt reads the integer part
  assert.equal(size(undefined), cfg.partySize);
  const days = (v) => submit({ scanDays: v }).cfg.fandango.scanDays;
  assert.equal(days(6), 7);
  assert.equal(days(7), 7);
  assert.equal(days(60), 60);
  assert.equal(days(61), 60);
  assert.equal(days('14 days'), 14);
  assert.equal(days(undefined), cfg.fandango.scanDays);
});

test('a theatre that is null or not an object is ignored without error', () => {
  for (const theatre of [null, 'AAOPK', 7]) {
    const r = submit({ theatre });
    assert.deepEqual(r.errors, [], String(theatre));
    assert.equal(r.cfg.fandango.theaterId, 'TEST1');
    assert.equal(r.cfg.theatreName, 'Test Theatre');
  }
});

test('each junk theatre field is named in its own error, in id, slug, chain order', () => {
  assert.deepEqual(submit({ theatre: { theaterId: 'bad id!' } }).errors, ['theaterId looks invalid']);
  assert.deepEqual(submit({ theatre: { theaterSlug: 'Has Caps' } }).errors, ['theaterSlug looks invalid']);
  assert.deepEqual(submit({ theatre: { chainCode: 'a-b' } }).errors, ['chainCode looks invalid']);
  assert.deepEqual(
    submit({ theatre: { theaterId: 'x y', theaterSlug: 'X', chainCode: '??' } }).errors,
    ['theaterId looks invalid', 'theaterSlug looks invalid', 'chainCode looks invalid'],
  );
});

test('blank theatre fields are not mistakes and change nothing', () => {
  const r = submit({ theatre: { name: '   ', theaterId: '   ', theaterSlug: '', chainCode: null } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.cfg.fandango.theaterId, 'TEST1');
  assert.equal(r.cfg.fandango.theaterSlug, 'test-theatre-test1');
  assert.equal(r.cfg.fandango.chainCode, 'REGL');
  assert.equal(r.cfg.theatreName, 'Test Theatre');
});

test('a theatre error rejects the whole submission', () => {
  const original = base();
  const r = submit({ partySize: 6, theatre: { theaterId: 'bad id!' } }, original);
  assert.equal(r.cfg, original);
  assert.equal(r.targetChanged, false);
});

test('direct booking URL: 300 characters is the longest accepted', () => {
  const at = (n) => submit({ theatre: { directUrl: 'https://' + 'a'.repeat(n - 8) } });
  assert.deepEqual(at(300).errors, []);
  assert.equal(at(300).cfg.directBooking.url.length, 300);
  assert.deepEqual(at(301).errors, [DIRECT_ERR]);
});

test('direct booking URL: whitespace, quotes, angle brackets and a bare scheme are invalid', () => {
  for (const url of ['https://a.example/x y', 'https://a.example/"x', "https://a.example/'x", 'https://a.example/<x', 'https://a.example/x>', 'https://', 'ftp://a.example/x']) {
    assert.deepEqual(submit({ theatre: { directUrl: url } }).errors, [DIRECT_ERR], url);
  }
});

test('direct booking URL is trimmed before it is stored', () => {
  const r = submit({ theatre: { directUrl: '  https://www.amctheatres.com/x  ' } });
  assert.equal(r.cfg.directBooking.url, 'https://www.amctheatres.com/x');
  assert.equal(r.cfg.directBooking.label, 'AMC');
});

test('direct booking URL: an invalid one keeps the old link and rejects the submission', () => {
  const original = withDirectLink();
  const r = submit({ theatre: { directUrl: 'http://x.example' } }, original);
  assert.equal(r.cfg, original);
  assert.equal(r.cfg.directBooking.url, 'https://old.example/x');
});

test('direct booking URL: a blank field clears the link, an absent one keeps it', () => {
  assert.ok(!('directBooking' in submit({ theatre: { directUrl: '   ' } }, withDirectLink()).cfg));
  assert.equal(submit({ theatre: { name: 'Same house' } }, withDirectLink()).cfg.directBooking.url, 'https://old.example/x');
  assert.equal(submit({ theatre: { directUrl: 5 } }, withDirectLink()).cfg.directBooking.url, 'https://old.example/x');
});

test('direct booking URL: the same theatre id, in any case, keeps the link', () => {
  assert.equal(submit({ theatre: { theaterId: 'TEST1' } }, withDirectLink()).cfg.directBooking.url, 'https://old.example/x');
  assert.equal(submit({ theatre: { theaterId: 'test1' } }, withDirectLink()).cfg.directBooking.url, 'https://old.example/x');
});

test('direct booking URL: a new link replaces the old one when the theatre also changes', () => {
  const r = submit({ theatre: { theaterId: 'NEWID', directUrl: 'https://www.harkins.com/x' } }, withDirectLink());
  assert.deepEqual(r.cfg.directBooking, { label: 'Harkins', url: 'https://www.harkins.com/x' });
});

test('a target change is flagged when only the theatre changes', () => {
  const r = submit({ movie: 'Odyssey', format: 'IMAX 70MM', theatre: { theaterId: 'NEWID' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.targetChanged, true);
});

test('the poster survives a change that keeps the movie (format or theatre)', () => {
  const withPoster = { ...base(), posterFile: 'data/poster.jpg' };
  const byFormat = applyScoutRequest(withPoster, { movie: 'Odyssey', format: 'IMAX' });
  assert.equal(byFormat.targetChanged, true);
  assert.equal(byFormat.cfg.posterFile, 'data/poster.jpg');
  const byTheatre = applyScoutRequest(withPoster, { movie: 'Odyssey', format: 'IMAX 70MM', theatre: { theaterId: 'NEWID' } });
  assert.equal(byTheatre.targetChanged, true);
  assert.equal(byTheatre.cfg.posterFile, 'data/poster.jpg');
});

test('bookingBrand names the five known chains, with or without www', () => {
  const brands = {
    'regmovies.com': 'Regal', 'amctheatres.com': 'AMC', 'cinemark.com': 'Cinemark',
    'harkins.com': 'Harkins', 'marcustheatres.com': 'Marcus',
  };
  for (const [host, brand] of Object.entries(brands)) {
    assert.equal(bookingBrand(`https://${host}/x`), brand, host);
    assert.equal(bookingBrand(`https://www.${host}/x`), brand, `www.${host}`);
  }
});

test('bookingBrand falls back to the capitalised domain name, or a neutral label', () => {
  assert.equal(bookingBrand('https://tickets.example.org/x'), 'Example');   // subdomain ignored
  assert.equal(bookingBrand('https://www.fandango.com'), 'Fandango');
  assert.equal(bookingBrand('https://localhost:3000/x'), 'Localhost');      // one-label host
  assert.equal(bookingBrand(''), 'Book direct');
  assert.equal(bookingBrand(undefined), 'Book direct');
});

test('profileFromCfg: the movie falls back to the match text, and the link to an empty string', () => {
  const plain = profileFromCfg(base(), 'T');
  assert.equal(plain.movie, 'Odyssey');
  assert.equal(plain.theatre.directUrl, '');
  const named = base();
  named.fandango.movieTitle = 'The Odyssey';
  named.directBooking = { label: 'Regal', url: 'https://www.regmovies.com/x' };
  const p = profileFromCfg(named, 'T');
  assert.equal(p.movie, 'The Odyssey');
  assert.equal(p.theatre.directUrl, 'https://www.regmovies.com/x');
});

test('profileFromCfg: every field the landing form refills, plus the target key', () => {
  const { key, ...rest } = profileFromCfg(base(), '2026-07-19T00:00:00.000Z');
  assert.equal(key, targetKey(base()));
  assert.deepEqual(rest, {
    movie: 'Odyssey', format: 'IMAX 70MM', partySize: 2, scanDays: 40,
    theatre: { name: 'Test Theatre', theaterId: 'TEST1', theaterSlug: 'test-theatre-test1', chainCode: 'REGL', directUrl: '' },
    lastUsed: '2026-07-19T00:00:00.000Z',
  });
});

test('recent scouts keep at most 8 profiles, newest first, oldest dropped', () => {
  assert.equal(MAX_PROFILES, 8); // README: "capped at 8"
  let profiles = [];
  for (let i = 0; i < 10; i++) {
    const c = base();
    c.fandango.movieTitleMatch = `Movie ${i}`;
    profiles = upsertProfile(profiles, c, `t${i}`);
  }
  assert.equal(profiles.length, 8);
  assert.deepEqual(profiles.map(p => p.lastUsed), ['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2']);
});

test('re-scouting an older target moves it to the front without duplicating it', () => {
  const mk = (name) => { const c = base(); c.fandango.movieTitleMatch = name; return c; };
  let profiles = upsertProfile(upsertProfile([], mk('A'), 't1'), mk('B'), 't2'); // [B, A]
  profiles = upsertProfile(profiles, mk('A'), 't3');
  assert.deepEqual(profiles.map(p => [p.movie, p.lastUsed]), [['A', 't3'], ['B', 't2']]);
});

test('upsertProfile copes with no list, empty slots, and does not edit the list it was given', () => {
  assert.equal(upsertProfile(undefined, base(), 't1').length, 1);
  assert.equal(upsertProfile(null, base(), 't1').length, 1);
  const other = base();
  other.fandango.movieTitleMatch = 'Other';
  const list = [null, profileFromCfg(other, 't0')];
  const out = upsertProfile(list, base(), 't1');
  assert.deepEqual(out.map(p => p.movie), ['Odyssey', 'Other']); // the null slot is dropped
  assert.equal(list.length, 2);
});
