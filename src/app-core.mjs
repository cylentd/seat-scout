// Pure logic for the local launcher: turning a landing-page submission into a
// validated config, and maintaining the recent-scouts profile list. No
// filesystem, no network — unit-testable.
import { sameTarget, targetKey } from './scan-core.mjs';

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const cleanStr = (v, max, re = null) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  if (!s) return null;
  if (re && !re.test(s)) return null;
  return s;
};

// The direct-booking button is labelled with the chain's brand and nothing else,
// so it reads as a vendor choice beside the Fandango link. Derived from the host
// so switching theatres can't leave a stale chain name behind.
const BOOKING_BRANDS = {
  'regmovies.com': 'Regal',
  'amctheatres.com': 'AMC',
  'cinemark.com': 'Cinemark',
  'harkins.com': 'Harkins',
  'marcustheatres.com': 'Marcus',
};

export function bookingBrand(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return 'Book direct'; }
  if (BOOKING_BRANDS[host]) return BOOKING_BRANDS[host];
  const parts = host.split('.');
  const name = parts.length > 1 ? parts[parts.length - 2] : host;
  return name ? name[0].toUpperCase() + name.slice(1) : 'Book direct';
}

// Merge a { movie, format, partySize, scanDays, theatre? } submission into a
// deep-cloned config. Returns { cfg, targetChanged, errors }. On any error the
// original config is returned untouched.
export function applyScoutRequest(cfg, body) {
  const errors = [];
  const next = structuredClone(cfg);
  const b = body || {};

  const movie = cleanStr(b.movie, 100);
  if (!movie) errors.push('movie is required');
  const format = cleanStr(b.format, 40);
  if (!format) errors.push('format is required');

  if (movie) {
    next.fandango.movieTitle = movie;                 // display name
    next.fandango.movieTitleMatch = escapeRegex(movie); // literal, case-insensitive match
  }
  if (format) next.fandango.formatFilter = format;
  next.partySize = clampInt(b.partySize, 1, 8, cfg.partySize);
  next.fandango.scanDays = clampInt(b.scanDays, 7, 60, cfg.fandango.scanDays);

  if (b.theatre && typeof b.theatre === 'object') {
    const t = b.theatre;
    const name = cleanStr(t.name, 80);
    const theaterId = cleanStr(t.theaterId, 10, /^[A-Za-z0-9]+$/);
    const theaterSlug = cleanStr(t.theaterSlug, 120, /^[a-z0-9-]+$/);
    const chainCode = cleanStr(t.chainCode, 8, /^[A-Za-z0-9]+$/);
    if (name) next.theatreName = name;
    if (theaterId) next.fandango.theaterId = theaterId.toUpperCase();
    if (theaterSlug) next.fandango.theaterSlug = theaterSlug;
    if (chainCode) next.fandango.chainCode = chainCode.toUpperCase();
    // Direct (fee-free) booking link: https only; explicit empty clears it, and
    // switching theatres without a new link drops the stale one.
    const directRaw = typeof t.directUrl === 'string' ? t.directUrl.trim() : null;
    if (directRaw) {
      if (/^https:\/\/[^\s"'<>]+$/.test(directRaw) && directRaw.length <= 300) {
        next.directBooking = { label: bookingBrand(directRaw), url: directRaw };
      } else {
        errors.push('direct booking URL looks invalid (must be https)');
      }
    } else if (directRaw === '' || (theaterId && theaterId.toUpperCase() !== cfg.fandango.theaterId)) {
      delete next.directBooking;
    }
    // Any partial-but-present junk is a user mistake worth surfacing.
    for (const [k, v] of [['theaterId', t.theaterId], ['theaterSlug', t.theaterSlug], ['chainCode', t.chainCode]]) {
      if (v != null && String(v).trim() && !cleanStr(String(v), 120, { theaterId: /^[A-Za-z0-9]+$/, theaterSlug: /^[a-z0-9-]+$/, chainCode: /^[A-Za-z0-9]+$/ }[k])) {
        errors.push(`${k} looks invalid`);
      }
    }
  }

  if (errors.length) return { cfg, targetChanged: false, errors };

  const targetChanged = !sameTarget(cfg, next);
  // The stored poster belongs to the previous movie — drop it on a movie change
  // so the report doesn't wear the wrong art.
  if (targetChanged && next.fandango.movieTitleMatch !== cfg.fandango.movieTitleMatch) {
    delete next.posterFile;
  }
  return { cfg: next, targetChanged, errors };
}

export const MAX_PROFILES = 8;

// One "recent scout" per target: everything the landing page needs to refill
// the form. Identity is the target key, so re-scouting the same combination
// just refreshes its slot instead of duplicating it.
export function profileFromCfg(cfg, lastUsed) {
  const fd = cfg.fandango;
  return {
    key: targetKey(cfg),
    movie: fd.movieTitle || fd.movieTitleMatch,
    format: fd.formatFilter,
    partySize: cfg.partySize,
    scanDays: fd.scanDays,
    theatre: {
      name: cfg.theatreName,
      theaterId: fd.theaterId,
      theaterSlug: fd.theaterSlug,
      chainCode: fd.chainCode,
      directUrl: cfg.directBooking?.url || '',
    },
    lastUsed,
  };
}

// Most-recent first, deduped by target, capped. Returns a new array.
export function upsertProfile(profiles, cfg, lastUsed) {
  const entry = profileFromCfg(cfg, lastUsed);
  return [entry, ...(profiles || []).filter(p => p && p.key !== entry.key)].slice(0, MAX_PROFILES);
}
