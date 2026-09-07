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
