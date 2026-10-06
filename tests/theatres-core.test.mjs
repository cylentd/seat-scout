import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLocationQuery, locationKey, theatresNearPath,
  parseNearbyTheatres, annotateForTarget,
} from '../src/theatres-core.mjs';

test('parseLocationQuery accepts ZIPs and City, ST', () => {
  assert.deepEqual(parseLocationQuery('94568'), { zipCode: '94568' });
  assert.deepEqual(parseLocationQuery(' 94568-1234 '), { zipCode: '94568' });
  assert.deepEqual(parseLocationQuery('Dublin, CA'), { city: 'Dublin', state: 'CA' });
  assert.deepEqual(parseLocationQuery('dublin ca'), { city: 'dublin', state: 'CA' });
  assert.deepEqual(parseLocationQuery('New York NY'), { city: 'New York', state: 'NY' });
  assert.deepEqual(parseLocationQuery('Washington,  dc'), { city: 'Washington', state: 'DC' });
});

test('parseLocationQuery rejects what the endpoint cannot answer', () => {
  assert.equal(parseLocationQuery('Dublin'), null);        // bare city -> endpoint returns nothing
  assert.equal(parseLocationQuery('San Jose'), null);      // "Jose" is not a state
  assert.equal(parseLocationQuery('123'), null);
  assert.equal(parseLocationQuery('123456'), null);
  assert.equal(parseLocationQuery(''), null);
  assert.equal(parseLocationQuery(null), null);
});

test('locationKey is filename-safe and distinct per location', () => {
  assert.equal(locationKey({ zipCode: '94568' }), 'zip-94568');
  assert.equal(locationKey({ city: 'San Francisco', state: 'CA' }), 'san-francisco-ca');
  assert.equal(locationKey({ city: "Coeur d'Alene", state: 'ID' }), 'coeur-d-alene-id');
});

test('theatresNearPath carries the location and defaults', () => {
  const zip = theatresNearPath({ zipCode: '94568' }, '2026-07-25');
  assert.match(zip, /^\/napi\/theaterswithshowtimes\?/);
  assert.match(zip, /zipCode=94568/);
  assert.match(zip, /date=2026-07-25/);
  assert.match(zip, /limit=30/);
  const city = theatresNearPath({ city: 'San Francisco', state: 'CA' }, '2026-07-25', { limit: 5 });
  assert.match(city, /city=San\+Francisco/);
  assert.match(city, /state=CA/);
  assert.match(city, /limit=5/);
});

// Trimmed real-shape payload: theatres out of distance order, one non-ticketing.
const payload = {
  viewModel: {
    theaters: [
      {
        id: 'AAVAC', name: 'Cinemark Century at Hayward', chainCode: 'CNMK',
        theaterPageUrl: '/cinemark-century-at-hayward-aavac/theater-page',
        distance: 8.866, fullAddress: '1069 B Street, Hayward, CA 94541',
        city: 'Hayward', state: 'CA', isTicketing: true, formats: [], movies: [],
      },
      {
        id: 'aaopk', name: 'Regal Hacienda Crossings ScreenX, IMAX & RPX', chainCode: 'REGL',
        sluggedName: 'regal-hacienda-crossings-screenx-imax-and-rpx', formattedID: 'aaopk',
        distance: 2.4339, fullAddress: '5000 Dublin Blvd., Dublin, CA 94568',
        city: 'Dublin', state: 'CA', isTicketing: true,
        formats: ['IMAX 70MM', 'IMAX'],
        movies: [{
          title: 'The Odyssey (2026)',
          variants: [{
            amenityGroups: [{
              showtimes: [
                { filmFormat: [{ filterName: 'IMAX 70MM' }, { filterName: 'Reserved' }] },
                { filmFormat: [{ filterName: 'IMAX 70MM' }] },   // dupe format collapses
                { filmFormat: [] },                              // standard show adds nothing
              ],
            }],
          }],
        }],
      },
      { id: 'AAXXX', name: 'No Tickets Here', isTicketing: false, distance: 1.0 },
    ],
  },
};

test('parseNearbyTheatres normalizes, sorts by distance, drops non-ticketing', () => {
  const ts = parseNearbyTheatres(payload);
  assert.equal(ts.length, 2);
  assert.equal(ts[0].theaterId, 'AAOPK');                  // nearest first, id uppercased
  assert.equal(ts[0].theaterSlug, 'regal-hacienda-crossings-screenx-imax-and-rpx-aaopk'); // sluggedName+formattedID fallback
  assert.equal(ts[1].theaterSlug, 'cinemark-century-at-hayward-aavac');                   // from theaterPageUrl
  assert.equal(ts[0].distance, 2.4);
  assert.deepEqual(ts[0].movies, [{ title: 'The Odyssey (2026)', formats: ['IMAX 70MM', 'Reserved'] }]);
  assert.deepEqual(parseNearbyTheatres({}), []);
});

test('annotateForTarget badges movie and format matches', () => {
  const ts = parseNearbyTheatres(payload);
  const [regal, cinemark] = annotateForTarget(ts, 'The Odyssey', 'IMAX 70MM');
  assert.equal(regal.playsMovie, true);                    // "(2026)" year suffix ignored
  assert.equal(regal.playsFormat, true);
  assert.equal(cinemark.playsMovie, false);
  assert.equal(cinemark.playsFormat, false);

  // No movie hit -> format falls back to the theatre-level formats list.
  const [r2] = annotateForTarget(ts, 'Some Other Film', 'imax');
  assert.equal(r2.playsMovie, false);
  assert.equal(r2.playsFormat, true);                      // case-insensitive, exact format

  const [r3] = annotateForTarget(ts, '', '');
  assert.equal(r3.playsMovie, false);
  assert.equal(r3.playsFormat, false);
});

// ---- mutation-driven additions ----------------------------------------------
// Oracle: README "Theatre finder" (ZIP or "City, ST", nearest first, ticketing
// theatres only, badged when the movie / the movie in the picked format plays).
const STATE_CODES = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ' +
  'ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU').split(' ');
const parseOne = (over) => parseNearbyTheatres({ viewModel: { theaters: [{ id: 'AAAAA', name: 'T', ...over }] } })[0];
const showtimesWith = (...formatLists) => [{ amenityGroups: [{ showtimes: formatLists.map(fl => ({ filmFormat: fl.map(f => ({ filterName: f })) })) }] }];

test('parseLocationQuery accepts every USPS state and territory code, any case', () => {
  for (const st of STATE_CODES) {
    assert.deepEqual(parseLocationQuery(`Springfield, ${st}`), { city: 'Springfield', state: st }, st);
    assert.deepEqual(parseLocationQuery(`springfield ${st.toLowerCase()}`), { city: 'springfield', state: st }, st);
  }
  for (const bad of ['XX', 'ZZ', 'AB', 'OO', 'UK']) assert.equal(parseLocationQuery(`Springfield, ${bad}`), null, bad);
});

test('parseLocationQuery: separators, trailing dot, internal spaces and the city length window', () => {
  assert.deepEqual(parseLocationQuery('Dublin,CA'), { city: 'Dublin', state: 'CA' });
  assert.deepEqual(parseLocationQuery('Dublin, CA.'), { city: 'Dublin', state: 'CA' });
  assert.deepEqual(parseLocationQuery('  San   Jose ,  ca  '), { city: 'San Jose', state: 'CA' });
  assert.deepEqual(parseLocationQuery('St. Louis, MO'), { city: 'St. Louis', state: 'MO' });
  assert.deepEqual(parseLocationQuery('LA, CA'), { city: 'LA', state: 'CA' });          // 2 characters is the shortest city
  assert.equal(parseLocationQuery('X CA'), null);                                        // 1 character is too short
  assert.deepEqual(parseLocationQuery(`${'a'.repeat(60)}, CA`), { city: 'a'.repeat(60), state: 'CA' });
  assert.equal(parseLocationQuery(`${'a'.repeat(61)}, CA`), null);
});

test('parseLocationQuery: a comma left on the end of the city is stripped', () => {
  // Pinned from code, no README rule: the 2-character city window swallows the
  // comma of "X, CA" ("X,"), and the cleanup leaves the one-letter city "X".
  assert.deepEqual(parseLocationQuery('X, CA'), { city: 'X', state: 'CA' });
});

test('parseLocationQuery: only exact 5 or 5+4 digit ZIPs, and only strings', () => {
  assert.deepEqual(parseLocationQuery('94568-1234'), { zipCode: '94568' });
  for (const bad of ['9456', '94568-12', '94568 1234', 'x94568', '94568x']) assert.equal(parseLocationQuery(bad), null, bad);
  assert.equal(parseLocationQuery(94568), null);
  assert.equal(parseLocationQuery(undefined), null);
  assert.equal(parseLocationQuery('   '), null);
});

test('locationKey trims punctuation and lowercases the city and state', () => {
  assert.equal(locationKey({ city: 'St. Louis', state: 'MO' }), 'st-louis-mo');
  assert.equal(locationKey({ city: '  -Paris!- ', state: 'TX' }), 'paris-tx');
  assert.equal(locationKey({ city: 'DUBLIN', state: 'CA' }), 'dublin-ca');
  assert.notEqual(locationKey({ zipCode: '94568' }), locationKey({ zipCode: '94569' }));
});

test('theatresNearPath builds the exact query: ZIP, city, page and limit', () => {
  assert.equal(
    theatresNearPath({ zipCode: '94568' }, '2026-07-25'),
    '/napi/theaterswithshowtimes?zipCode=94568&city=&state=&date=2026-07-25&page=1&limit=30&isdesktop=true&filter=open-theaters&filterEnabled=true',
  );
  assert.equal(
    theatresNearPath({ city: 'San Francisco', state: 'CA' }, '2026-07-25', { page: 2, limit: 5 }),
    '/napi/theaterswithshowtimes?zipCode=&city=San+Francisco&state=CA&date=2026-07-25&page=2&limit=5&isdesktop=true&filter=open-theaters&filterEnabled=true',
  );
});

test('parseNearbyTheatres reads a payload with no viewModel wrapper, and survives junk', () => {
  assert.equal(parseNearbyTheatres({ theaters: [{ id: 'AAAAA', name: 'Flat' }] })[0].name, 'Flat');
  for (const junk of [null, undefined, {}, { viewModel: {} }, { viewModel: { theaters: null } }]) {
    assert.deepEqual(parseNearbyTheatres(junk), []);
  }
});

test('parseNearbyTheatres drops entries with no id or marked non-ticketing, keeps unmarked ones', () => {
  const out = parseNearbyTheatres({ viewModel: { theaters: [
    null, { name: 'No id' }, { id: 'AAAA1', isTicketing: false },
    { id: 'AAAA2', name: 'Unmarked' }, { id: 'AAAA3', name: 'Marked', isTicketing: true },
  ] } });
  assert.deepEqual(out.map(t => t.name), ['Unmarked', 'Marked']);
});

test('parseNearbyTheatres: name falls back to the id, ids and chain codes are uppercased', () => {
  assert.equal(parseOne({ name: undefined, id: 'aabcd' }).name, 'aabcd');
  assert.equal(parseOne({ name: undefined, id: 12345 }).name, '12345');
  assert.equal(parseOne({ name: 'Real name', id: 'aabcd' }).name, 'Real name');
  assert.equal(parseOne({ id: 'aabcd' }).theaterId, 'AABCD');
  assert.equal(parseOne({ chainCode: 'cnmk' }).chainCode, 'CNMK');
  assert.equal(parseOne({}).chainCode, '');
});

test('parseNearbyTheatres: the slug comes from the page URL, else the slugged name plus id, else empty', () => {
  assert.equal(parseOne({ theaterPageUrl: '/regal-x-aaopk/theater-page' }).theaterSlug, 'regal-x-aaopk');
  assert.equal(parseOne({ theaterPageUrl: 'regal-x-aaopk/theater-page' }).theaterSlug, 'regal-x-aaopk');   // no leading slash
  assert.equal(parseOne({ sluggedName: 'Regal-X', formattedID: 'AAOPK' }).theaterSlug, 'regal-x-aaopk');   // lowercased
  assert.equal(parseOne({ theaterPageUrl: '/bad/path', sluggedName: 'a', formattedID: 'B' }).theaterSlug, 'a-b'); // URL not recognised
  assert.equal(parseOne({ sluggedName: 'only-name' }).theaterSlug, '');
  assert.equal(parseOne({ formattedID: 'ONLYID' }).theaterSlug, '');
  assert.equal(parseOne({}).theaterSlug, '');
});

test('parseNearbyTheatres: distance rounds to one decimal and a missing one is null', () => {
  assert.equal(parseOne({ distance: 8.866 }).distance, 8.9);
  assert.equal(parseOne({ distance: 2.4339 }).distance, 2.4);
  assert.equal(parseOne({ distance: 0 }).distance, 0);
  assert.equal(parseOne({}).distance, null);
  assert.equal(parseOne({ distance: '3.2' }).distance, null);   // only real numbers count
});

test('parseNearbyTheatres: nearest first, theatres with no distance last', () => {
  const out = parseNearbyTheatres({ viewModel: { theaters: [
    { id: 'N1', name: 'no distance' }, { id: 'F1', name: 'far', distance: 9 },
    { id: 'C1', name: 'close', distance: 0.4 }, { id: 'M1', name: 'mid', distance: 3 },
  ] } });
  assert.deepEqual(out.map(t => t.name), ['close', 'mid', 'far', 'no distance']);
});

test('parseNearbyTheatres: address prefers the full address, else street plus city line', () => {
  assert.equal(parseOne({ fullAddress: '1 Main St, Dublin, CA 94568', address1: 'x', cityStateZip: 'y' }).address, '1 Main St, Dublin, CA 94568');
  assert.equal(parseOne({ address1: '1 Main St', cityStateZip: 'Dublin, CA 94568' }).address, '1 Main St, Dublin, CA 94568');
  assert.equal(parseOne({ address1: '1 Main St' }).address, '1 Main St');
  assert.equal(parseOne({ cityStateZip: 'Dublin, CA 94568' }).address, 'Dublin, CA 94568');
  assert.equal(parseOne({}).address, '');
});

test('parseNearbyTheatres: city, state and venue formats default to empty and drop blanks', () => {
  const t = parseOne({ city: 'Dublin', state: 'CA', formats: ['IMAX', '', null, 'RPX'] });
  assert.equal(t.city, 'Dublin');
  assert.equal(t.state, 'CA');
  assert.deepEqual(t.formats, ['IMAX', 'RPX']);
  const bare = parseOne({});
  assert.equal(bare.city, '');
  assert.equal(bare.state, '');
  assert.deepEqual(bare.formats, []);
});

test('parseNearbyTheatres: a movie keeps its title and the distinct formats it plays in', () => {
  const t = parseOne({ movies: [
    null, { variants: [] },                                                  // no title: dropped
    { title: 'Plain' },                                                      // no variants: no formats
    { title: 'Multi', variants: [
      ...showtimesWith(['IMAX', 'Reserved'], [], ['IMAX']),                  // standard shows add nothing, dupes collapse
      { amenityGroups: [{ showtimes: [{ filmFormat: [{ filterName: '' }, { filterName: 'Dolby' }] }, {}] }, {}] }, // blank name skipped, gaps tolerated
      {},
    ] },
  ] });
  assert.deepEqual(t.movies, [
    { title: 'Plain', formats: [] },
    { title: 'Multi', formats: ['IMAX', 'Reserved', 'Dolby'] },
  ]);
});

test('annotateForTarget ignores a year suffix and matches the title as a substring', () => {
  const t = { name: 'T', formats: [], movies: [{ title: 'The Odyssey (2026)', formats: [] }] };
  const plays = (title) => annotateForTarget([t], title, '')[0].playsMovie;
  assert.equal(plays('The Odyssey'), true);
  assert.equal(plays('the odyssey (2026)'), true);   // the query's own year is ignored too
  assert.equal(plays('odyssey'), true);              // substring
  assert.equal(plays('  The Odyssey  '), true);
  assert.equal(plays('Dune'), false);
  assert.equal(plays(undefined), false);
  assert.equal(plays(''), false);
});

test('annotateForTarget: when the movie plays, playsFormat is about that movie, not the venue', () => {
  const venueHasImax = { name: 'T', formats: ['IMAX'], movies: [{ title: 'Dune', formats: ['Standard'] }] };
  const [r] = annotateForTarget([venueHasImax], 'Dune', 'IMAX');
  assert.equal(r.playsMovie, true);
  assert.equal(r.playsFormat, false);   // the movie is not in IMAX here, even though the venue has IMAX
});

test('annotateForTarget: the format must match exactly, ignoring case and padding', () => {
  const t = { name: 'T', formats: [], movies: [{ title: 'Dune', formats: ['IMAX 70MM'] }] };
  const fmt = (f) => annotateForTarget([t], 'Dune', f)[0].playsFormat;
  assert.equal(fmt('IMAX 70MM'), true);
  assert.equal(fmt('  imax 70mm '), true);
  assert.equal(fmt('IMAX'), false);        // a prefix is not a match
  assert.equal(fmt('Dolby'), false);
  assert.equal(fmt(''), false);
  assert.equal(fmt(undefined), false);
});

test('annotateForTarget: with no movie hit, the venue format list decides', () => {
  const t = { name: 'T', formats: ['IMAX'], movies: [{ title: 'Other', formats: ['Dolby'] }] };
  assert.equal(annotateForTarget([t], 'Dune', 'IMAX')[0].playsFormat, true);
  assert.equal(annotateForTarget([t], 'Dune', 'Dolby')[0].playsFormat, false);   // only the movie-level list has Dolby
  assert.equal(annotateForTarget([{ name: 'T', movies: [] }], 'Dune', 'IMAX')[0].playsFormat, false); // no format list at all
});

test('annotateForTarget keeps each theatre intact and returns new objects', () => {
  const t = { name: 'Keep', theaterId: 'AAAAA', formats: [], movies: [] };
  const [out] = annotateForTarget([t], 'Dune', 'IMAX');
  assert.equal(out.name, 'Keep');
  assert.equal(out.theaterId, 'AAAAA');
  assert.equal('playsMovie' in t, false);
  assert.notEqual(out, t);
});
