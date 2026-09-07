// Public "signals" exporter — the SAFE-to-publish view of the whole watchlist.
//
// It emits per-showtime *counts* (adjacent-pair quality, usable seats, sold-out
// status, a booking deep link) and nothing else. The raw seat map — the actual
// inventory — never leaves this machine. That distinction is the whole point of
// the hosted version: publish the signal ("2 good pairs open"), never the map.
//
// MULTI-TARGET: reads every per-target cache in data/scans/ (one per
// theatre x movie x format), reuses the report view model (whose per-show
// objects already carry only derived counts), and groups them by movie, each
// movie carrying its theatres. Falls back to scan-latest.json for a legacy
// single-target scan with no per-target caches yet.
//
// Usage: node src/signals.mjs   ->   public/signals.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildReportModel } from './report/viewmodel.mjs';
import { targetKey } from './scan-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Keep only the fields safe and useful to a public reader. No seat grid, no
// auditorium geometry — just how good this showtime is and where to book it.
function showSignal(s) {
  return {
    id: s.id,
    status: s.status,                 // available | soldout | unavailable
    dateISO: s.dateISO,
    dayLabel: s.dayLabel,
    timeLabel: s.timeLabel,
    part: s.part,                     // morning | afternoon | evening | night
    workHours: s.workHours,
    tier: s.tierKey,                  // best pair tier, or null
    pairs: s.pairs,                   // { center, midBack, flexible, total }
    usable: s.avail?.usable ?? 0,
    pctFull: s.avail?.pctFull ?? null,
    bookingUrl: s.bookingUrl,
  };
}

// One theatre's stream for one (movie, format), derived from its scan cache.
// Seat-tier geometry + partySize are GLOBAL analysis knobs read from the live
// config, not the copy frozen into the cache at scan time — otherwise changing
// the tiers would only take effect after a fresh scan of every theatre.
function theatreSignal(scan, liveCfg) {
  const cfg = { ...scan.config, tiers: liveCfg.tiers, partySize: liveCfg.partySize ?? scan.config.partySize };
  const f = cfg.fandango;
  const histPath = path.join(ROOT, 'data', `history-${targetKey(cfg)}.json`);
  let history = null;
  try { if (existsSync(histPath)) history = JSON.parse(readFileSync(histPath, 'utf8')); } catch { /* no trend */ }

  const model = buildReportModel(cfg, scan, history);
  // buildReportModel groups shows under days[]; there is no flat model.shows.
  const shows = (model.days || []).flatMap(d => d.shows).map(showSignal);
  const withPairs = shows.filter(s => s.pairs.total > 0).length;
  const soldout = shows.filter(s => s.status === 'soldout').length;
  const bestPairs = shows.reduce((m, s) => Math.max(m, s.pairs.total), 0);

  return {
    movieTitle: f.movieTitle || f.movieTitleMatch,
    format: f.formatFilter,
    mode: cfg.mode || 'seats',
    theatre: {
      id: f.theaterId,
      name: cfg.theatreName || f.theaterSlug || f.theaterId,
      chain: cfg.directBooking?.label || f.chainCode || null,
      directBookingUrl: cfg.directBooking?.url || null,
      format: f.formatFilter,
      mode: cfg.mode || 'seats',
      onSale: shows.length > 0, // onsale mode: false until tickets open
      scannedAt: scan.scannedAt || null,
      stats: { total: shows.length, withPairs, soldout, bestPairs },
      shows,
    },
  };
}

// Group the per-(theatre,movie,format) streams into movies, each with its
// theatres (best-first) — the shape the public site reads.
export function buildSignals(scans, liveCfg) {
  const entries = scans.map(s => theatreSignal(s, liveCfg));
  const byMovie = new Map();
  for (const e of entries) {
    if (!byMovie.has(e.movieTitle)) byMovie.set(e.movieTitle, { title: e.movieTitle, mode: e.mode, formats: new Set(), theatres: [] });
    const m = byMovie.get(e.movieTitle);
    m.formats.add(e.format);
    m.theatres.push(e.theatre);
  }
  const movies = [...byMovie.values()].map(m => ({
    title: m.title,
    mode: m.mode,
    formats: [...m.formats],
    theatres: m.theatres.sort((a, b) => b.stats.bestPairs - a.stats.bestPairs),
  }));
  return { generatedAt: new Date().toISOString(), movies };
}

// Every per-target cache, with a legacy single-target fallback.
function loadScans() {
  const dir = path.join(ROOT, 'data', 'scans');
  const scans = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => { try { return JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
        .filter(s => s && s.config?.fandango)
    : [];
  if (scans.length) return scans;
  const latest = path.join(ROOT, 'data', 'scan-latest.json');
  if (existsSync(latest)) {
    const s = JSON.parse(readFileSync(latest, 'utf8'));
    if (s?.config?.fandango) return [s];
  }
  return [];
}

function main() {
  const liveCfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const scans = loadScans();
  const signals = buildSignals(scans, liveCfg);
  const outDir = path.join(ROOT, 'public');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'signals.json');
  writeFileSync(outPath, JSON.stringify(signals)); // minified — it's a web asset
  const theatres = signals.movies.reduce((n, m) => n + m.theatres.length, 0);
  console.log(`Wrote ${outPath}: ${signals.movies.length} movie(s) across ${theatres} theatre stream(s) -> public/signals.json`);
}

// Run only when invoked directly, so tests can import buildSignals cleanly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
