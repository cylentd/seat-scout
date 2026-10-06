// Drop watcher: "did the theatre open more of this run, or did seats come back?"
//
// Deliberately NOT a scan. It fetches no seat maps and needs no prior scan — it
// asks theaterMovieShowtimes a handful of targeted questions per theatre and
// diffs the answer against a stored snapshot. That keeps a run cheap enough
// (~1 request per probed date) to schedule hourly against several theatres.
//
// Why not just read theaterCalendar? Because as of 2026-07 Fandango returns it
// theatre-wide for both Regal and AMC — Metreon's calendar runs to June 2027
// off the back of unrelated event cinema — and it ignores a movieId filter. It
// is only usable here as a cheap negative filter (see probePlan).
//
// This file is the I/O shell: it wires the real Chrome, Fandango, Discord and
// clock into src/drop-run.mjs, which holds every decision and its tests.
//
// Usage: node src/drop-watch.mjs [--once] [-v | --verbose]
//   reads watchlist.json; --once is the default and only mode (scheduling is
//   the OS's job — see README), -v / --verbose prints every probed date.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureChromeReady } from './browser.mjs';
import { PolitenessBudget } from './polite.mjs';
import { apiGet, showtimesPath, calendarPath } from './fandango-api.mjs';
import { alert } from './notify.mjs';
import { runWatch, isVerbose } from './drop-run.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

runWatch({
  root: ROOT,
  watchlist: JSON.parse(readFileSync(path.join(ROOT, 'watchlist.json'), 'utf8')),
  env: process.env,
  now: () => new Date(),
  verbose: isVerbose(process.argv),
  log: m => console.log(m),
  ensureChromeReady,
  makeBudget: politeness => new PolitenessBudget(politeness),
  api: {
    calendar: (browserCfg, budget, t) =>
      apiGet(browserCfg, budget, calendarPath(t.theaterId, t.chainCode)),
    showtimes: (browserCfg, budget, t, date, log) =>
      apiGet(browserCfg, budget, showtimesPath(t.theaterId, t.chainCode, date), { log }),
  },
  alert,
}).catch(e => { console.error(e.message); process.exit(1); });
