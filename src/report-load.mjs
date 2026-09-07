// Loading side of report generation: read config + scan + history off disk and
// build the view model. Split out so report.mjs and share-report.mjs agree on
// which history file belongs to a scan — that selection is subtle enough that
// duplicating it would eventually drift.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReportModel } from './report/viewmodel.mjs';
import { targetKey } from './scan-core.mjs';

export function loadReportModel(ROOT) {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const scan = JSON.parse(readFileSync(path.join(ROOT, 'data', 'scan-latest.json'), 'utf8'));

  // Sell-rate history belongs to the target the scan was made for.
  const histPath = path.join(ROOT, 'data', `history-${targetKey(scan.config?.fandango ? scan.config : cfg)}.json`);
  let history = null;
  try { if (existsSync(histPath)) history = JSON.parse(readFileSync(histPath, 'utf8')); } catch { /* unreadable -> no trend */ }

  const model = buildReportModel(cfg, scan, history);

  // Poster art is embedded as a data URI so report.html stays a single
  // self-contained file. Optional: the hero just omits it when absent.
  if (cfg.posterFile) {
    const posterPath = path.join(ROOT, cfg.posterFile);
    if (existsSync(posterPath)) {
      const mime = path.extname(posterPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      model.meta.poster = `data:${mime};base64,${readFileSync(posterPath).toString('base64')}`;
    }
  }

  return { cfg, scan, model };
}

// The one-embed description of a report — title, stats line, top picks, footer.
// Shared by share-report.mjs and the Discord bot so a report is always
// summarized the same way no matter which door it leaves through.
export function reportSummary(cfg, scan, model) {
  const fd = cfg.fandango;
  const movie = fd.movieTitle || fd.movieTitleMatch;
  const s = model.stats;
  return {
    title: `${movie} · ${fd.formatFilter} · ${cfg.theatreName}`,
    statsLine: `**${s.withPairs}/${s.total}** showtimes have an acceptable adjacent pair.`,
    picks: model.topPicks || [],
    footer: `Scanned ${new Date(scan.scannedAt).toLocaleString()} · tap a showtime to book`,
  };
}
