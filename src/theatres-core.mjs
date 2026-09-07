// Pure logic for finding theatres near a location — no network, no filesystem.
// Data source is Fandango's /napi/theaterswithshowtimes, the endpoint behind the
// site's "<zip>_movietimes" browse pages: one call returns every theatre near a
// ZIP or city/state, sorted by distance, each with the movies (and their
// showtime formats) it plays on the requested date.

// USPS state/territory codes — the endpoint silently returns nothing for a city
// without a state, so a bare-city query is rejected up front with a usable
// error instead of an empty result.
const STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
  'VI', 'GU',
]);

// "94568" / "94568-1234" -> { zipCode } · "Dublin, CA" / "dublin ca" -> { city, state }.
// Anything else (including a city with no recognizable state) -> null.
export function parseLocationQuery(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const zip = s.match(/^(\d{5})(?:-\d{4})?$/);
  if (zip) return { zipCode: zip[1] };
  const m = s.match(/^(.{2,60}?)[,\s]+([A-Za-z]{2})\.?$/);
  if (m && STATES.has(m[2].toUpperCase())) {
    return { city: m[1].replace(/,+$/, '').trim(), state: m[2].toUpperCase() };
  }
  return null;
}

// Filename-safe cache key for a parsed location.
export function locationKey(loc) {
  if (loc.zipCode) return `zip-${loc.zipCode}`;
  const city = loc.city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${city}-${loc.state.toLowerCase()}`;
}

// limit=30 comfortably covers a metro search radius in one page (a dense East
// Bay ZIP returns 13 total), so no pagination loop is needed.
export function theatresNearPath(loc, date, { page = 1, limit = 30 } = {}) {
  const q = new URLSearchParams({
    zipCode: loc.zipCode || '',
    city: loc.city || '',
    state: loc.state || '',
    date,
    page: String(page),
    limit: String(limit),
    isdesktop: 'true',
    filter: 'open-theaters',
    filterEnabled: 'true',
  });
  return `/napi/theaterswithshowtimes?${q}`;
}

// Unique showtime filmFormat names across one movie's variants — "" (standard)
// showtimes carry an empty filmFormat array and contribute nothing.
function movieFormats(m) {
  const formats = new Set();
  for (const v of m.variants || []) {
    for (const g of v.amenityGroups || []) {
      for (const st of g.showtimes || []) {
        for (const f of st.filmFormat || []) if (f.filterName) formats.add(f.filterName);
      }
    }
  }
  return [...formats];
}

// theaterPageUrl "/regal-hacienda-…-aaopk/theater-page" -> the slug config.json
// expects. sluggedName+formattedID is the fallback for a missing page URL.
function slugOf(t) {
  const m = String(t.theaterPageUrl || '').match(/^\/?([a-z0-9-]+)\/theater-page/);
  if (m) return m[1];
  if (t.sluggedName && t.formattedID) return `${t.sluggedName}-${t.formattedID}`.toLowerCase();
  return '';
}

// theaterswithshowtimes payload -> normalized theatres, nearest first. Only
// ticketing theatres are kept: without ticketing there is no seat map, and a
// seat map is the whole point.
export function parseNearbyTheatres(json) {
  const vm = json?.viewModel || json || {};
  return (vm.theaters || [])
    .filter(t => t && t.id && t.isTicketing !== false)
    .map(t => ({
      name: t.name || String(t.id),
      theaterId: String(t.id).toUpperCase(),
      theaterSlug: slugOf(t),
      chainCode: String(t.chainCode || '').toUpperCase(),
      distance: Number.isFinite(t.distance) ? Math.round(t.distance * 10) / 10 : null,
      address: t.fullAddress || [t.address1, t.cityStateZip].filter(Boolean).join(', '),
      city: t.city || '',
      state: t.state || '',
      formats: (t.formats || []).filter(Boolean),
      movies: (t.movies || [])
        .filter(m => m && m.title)
        .map(m => ({ title: m.title, formats: movieFormats(m) })),
    }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

const normTitle = (t) => String(t || '').replace(/\s*\(\d{4}\)\s*$/, '').trim().toLowerCase();

// Badge each theatre for the wizard's current pick. playsMovie/playsFormat are
// hints, not filters: `movies` reflects one date only, so a theatre that plays
// the movie tomorrow but not today shows unbadged rather than being hidden.
// When the movie plays, playsFormat means "in the chosen format"; otherwise it
// falls back to the theatre-level formats list (the venue's special formats).
export function annotateForTarget(theatres, movieTitle, format) {
  const movie = normTitle(movieTitle);
  const fmt = String(format || '').trim().toLowerCase();
  const hasFmt = (list) => !!fmt && (list || []).some(f => String(f).toLowerCase() === fmt);
  return theatres.map(t => {
    const hit = movie ? t.movies.find(m => normTitle(m.title).includes(movie)) : null;
    return {
      ...t,
      playsMovie: !!hit,
      playsFormat: hit ? hasFmt(hit.formats) : hasFmt(t.formats),
    };
  });
}
