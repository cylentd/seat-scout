// Public "signals" exporter — the SAFE-to-publish view of a scan.
//
// It emits per-showtime *counts* (adjacent-pair quality, usable seats, sold-out
// status, a booking deep link) and nothing else. The raw seat map — the actual
// inventory — never leaves this machine. That distinction is the whole point of
// the hosted version: publish the signal ("2 good pairs open"), never the map.
//
// Reuses the report's view model (src/report/viewmodel.mjs), whose per-show
// objects already carry only derived counts — the seat grid is embedded
// elsewhere for the local report and is deliberately absent here.
//
// Usage: node src/signals.mjs   ->   public/signals.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadReportModel } from './report-load.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Keep only the fields that are safe and useful to a public reader. No seat
// grid, no auditorium geometry — just how good this showtime is and where to
// book it.
function showSignal(s) {
  return {
    id: s.id,
    status: s.status,                 // available | soldout | unavailable
    dateISO: s.dateISO,
    dayLabel: s.dayLabel,
    timeLabel: s.timeLabel,
    part: s.part,                     // morning | afternoon | evening | night
    workHours: s.workHours,           // weekday work-hours start (harder to attend)
    tier: s.tierKey,                  // best pair tier: center | midBack | flexible | null
    pairs: s.pairs,                   // { center, midBack, flexible, total }
    usable: s.avail?.usable ?? 0,     // open seats outside the front rows
    pctFull: s.avail?.pctFull ?? null,
    bookingUrl: s.bookingUrl,
  };
}

export function buildSignals(cfg, model, scannedAt = null) {
  const f = cfg.fandango;
  const shows = (model.shows || []).map(showSignal);
  const withPairs = shows.filter(s => s.pairs.total > 0).length;
  const soldout = shows.filter(s => s.status === 'soldout').length;
  const bestPairs = shows.reduce((m, s) => Math.max(m, s.pairs.total), 0);

  // One-theatre scan today, but the shape is an array so adding theatres later
  // (a watchlist scan) needs no change on the reading side.
  const theatre = {
    id: f.theaterId,
    name: cfg.theatreName || f.theaterSlug || f.theaterId,
    chain: cfg.directBooking?.label || null,
    directBookingUrl: cfg.directBooking?.url || null,
    scannedAt,
    stats: { total: shows.length, withPairs, soldout, bestPairs },
    shows,
  };

  return {
    generatedAt: new Date().toISOString(),
    movie: { title: f.movieTitle || f.movieTitleMatch, format: f.formatFilter },
    theatres: [theatre],
  };
}

function main() {
  const { cfg, scan, model } = loadReportModel(ROOT);
  const signals = buildSignals(cfg, model, scan.scannedAt);
  const outDir = path.join(ROOT, 'public');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'signals.json');
  writeFileSync(outPath, JSON.stringify(signals)); // minified — it's a web asset
  const t = signals.theatres[0];
  console.log(`Wrote ${outPath}: ${t.stats.total} showtimes, ${t.stats.withPairs} with pairs, best ${t.stats.bestPairs} -> public/signals.json`);
}

// Run only when invoked directly, so tests can import buildSignals cleanly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
