// Fandango-based scanner: finds matching showtimes and captures seat maps.
// All calls run in-page on fandango.com inside a real Chrome (see browser.mjs).
// Sold-out showtimes are detected from the showtimes payload and skipped — the
// seat-map endpoint is only hit for shows with availability.
//
// MULTI-TARGET: config.json's `watchlist` (theatres x movies x formats) is
// expanded into one single-target scan each (expandTargets). One
// theaterMovieShowtimes payload is fetched per (theatre, date) and SHARED across
// every movie watched at that theatre (getShowtimes memo), so adding movies
// costs seat-map calls, not showtimes calls. One PolitenessBudget governs the
// whole run, so the per-minute ceiling holds across all targets, not per target.
// Each target caches to its own file; the FIRST target also mirrors to
// scan-latest.json so report.mjs stays a single known path.
//
// Usage: node src/scan.mjs [--fresh|--watch] [--start=YYYY-MM-DD]
//   --start    begin the scan window at a later date instead of today.
//   (default)  tiered-freshness scan (see TTL tiers in scan-core).
//   --fresh    ignore the cache entirely and re-fetch every date.
//   --watch    cheap check-in: re-fetch seat maps only for prior pair-bearers.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureChromeReady } from './browser.mjs';
import { PolitenessBudget } from './polite.mjs';
import { apiGet as fandangoGet } from './fandango-api.mjs';
import {
  isoPlusDays, matchingShowtimes, compactSeatMap, dateIsClean,
  ttlMs, daysBetween, pairTotals, sameTarget, targetKey,
  observeResults, appendHistory, pairlessStreak, calendarDates, calendarIsTheatreWide,
  expandTargets,
} from './scan-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const budget = new PolitenessBudget(cfg.politeness);
const LATEST_PATH = path.join(ROOT, 'data', 'scan-latest.json');

// Lightweight ANSI styling. No-ops when stdout isn't a terminal or NO_COLOR is
// set, so saved logs stay plain text.
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: s => paint('1', s),
  red: s => paint('31', s),
  green: s => paint('32', s),
  yellow: s => paint('33', s),
  cyan: s => paint('36', s),
};

// "2026-07-25" -> "Sat, Jul 25 (tomorrow)" — readable day headers for watch runs.
function dayLabel(iso, today) {
  const nice = new Date(`${iso}T12:00:00`).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
  if (iso === today) return `${nice} (today)`;
  if (iso === isoPlusDays(today, 1)) return `${nice} (tomorrow)`;
  return nice;
}

// URL builders, parameterized by a target's fandango block.
const showtimesUrl = (fd, date) =>
  `/napi/theaterMovieShowtimes/${fd.theaterId}?chainCode=${fd.chainCode}&startDate=${date}&isdesktop=true&partnerRestrictedTicketing=`;
const calendarUrl = (fd) =>
  `/napi/theaterCalendar/${fd.theaterId}?chainCode=${fd.chainCode}`;

// Every request goes through the shared request layer (fandango-api.mjs): the
// politeness budget, exact Retry-After backpressure, and parking on a hard block.
// Only the console styling is scan's own.
const scanLog = msg =>
  console.log(msg.startsWith('Blocked') ? c.red(`*** ${msg} ***`)
    : msg.startsWith('Access') ? c.green(`*** ${msg} ***`)
    : c.yellow(`\n${msg}`));
const apiGet = url => fandangoGet(cfg, budget, url, { log: scanLog });

// Run-scoped showtimes memo: one theaterMovieShowtimes payload per (theatre,
// date), shared across every movie watched at that theatre. Only successes are
// cached, so a thrown error lets the next movie retry the date.
const showtimesMemo = new Map();
async function getShowtimes(fd, date) {
  const key = `${fd.theaterId}|${date}`;
  if (showtimesMemo.has(key)) return showtimesMemo.get(key);
  const st = await apiGet(showtimesUrl(fd, date));
  showtimesMemo.set(key, st);
  return st;
}

// Per-target cache/history paths. The first target also mirrors to
// scan-latest.json so report.mjs and sharing stay a single known path.
function targetPaths(target, isPrimary) {
  const key = targetKey(target);
  const targetPath = path.join(ROOT, 'data', 'scans', `${key}.json`);
  const historyPath = path.join(ROOT, 'data', `history-${key}.json`);
  const outPaths = isPrimary ? [targetPath, LATEST_PATH] : [targetPath];
  return { key, targetPath, historyPath, outPaths };
}

function loadPrev(target, targetPath, isPrimary) {
  let prev = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, 'utf8')) : null;
  if (!prev && isPrimary && existsSync(LATEST_PATH)) {
    const latest = JSON.parse(readFileSync(LATEST_PATH, 'utf8'));
    if (sameTarget(latest.config, target)) prev = latest; // migrate the pre-watchlist cache
  }
  if (prev && !sameTarget(prev.config, target)) prev = null; // hash-collision safety net
  return prev;
}

// Sell-rate history: one compact observation appended per completed run.
function recordHistory(historyPath, target, results, kind, observed) {
  const shows = observeResults(target, results, observed);
  if (!Object.keys(shows).length) return;
  let history = [];
  try { if (existsSync(historyPath)) history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch { /* corrupt -> restart */ }
  history = appendHistory(history, { at: new Date().toISOString(), kind, shows });
  writeFileSync(historyPath, JSON.stringify(history, null, 1));
}

// One cheap calendar call: has the theatre opened dates beyond what we scanned?
async function supplyProbe(fd, results, today) {
  try {
    const cal = await apiGet(calendarUrl(fd));
    const lastCached = results.map(r => r.date).sort().at(-1) || today;
    const fresh = calendarDates(cal).filter(d => d > lastCached);
    if (!fresh.length) return;
    console.log(
      c.green(c.bold(`Theatre has dates beyond your scan: ${fresh[0]} → ${fresh.at(-1)}`)) +
      c.green(` (you scanned to ${lastCached}).`) +
      (calendarIsTheatreWide(cal)
        ? c.yellow(' These are theatre-wide and may belong to other films — run "npm run drops" to confirm this one.')
        : c.green(' Run a full scan to fetch them — fresh dates have the best seat selection.')) + '\n');
  } catch { /* best-effort probe */ }
}

// --watch: revisit only the shows worth booking for one target.
async function watchRun(target, historyPath, outPaths, prev, today) {
  const fd = target.fandango;
  if (!prev) { console.log(c.yellow('No previous scan to watch — run a full scan first.')); return; }
  const results = prev.results || [];
  const plan = [];
  for (const r of results) {
    if (r.date < today) continue;
    const shows = r.shows.filter(s =>
      s.seatMap && !s.expired && s.type === 'available' && pairTotals(target, s).pairs > 0);
    if (shows.length) plan.push({ result: r, shows });
  }
  // Supply probe runs BEFORE the "nothing to watch" bail-out: a run with no
  // bookable pairs left is exactly when an extension matters most.
  await supplyProbe(fd, results, today);

  const total = plan.reduce((n, p) => n + p.shows.length, 0);
  if (!total) {
    console.log(c.yellow('Nothing to watch — the last scan found no showtimes with bookable pairs.'));
    return;
  }

  console.log(c.bold(`Watching ${total} showtime${total === 1 ? '' : 's'} with bookable pairs across ${plan.length} day${plan.length === 1 ? '' : 's'}.`));

  const save = () => {
    const body = JSON.stringify({ ...prev, scannedAt: new Date().toISOString(), results }, null, 1);
    for (const p of outPaths) writeFileSync(p, body);
  };

  const tally = { up: 0, down: 0, same: 0, lost: 0, failed: 0 };
  const STATS_W = 30;
  const observed = new Set();

  for (const { result, shows } of plan) {
    const date = result.date;
    console.log(c.cyan(dayLabel(date, today)));

    try {
      const st = await getShowtimes(fd, date);
      const current = new Map(matchingShowtimes(st, fd).map(s => [s.id, s]));
      for (const show of result.shows) {
        const cur = current.get(show.id);
        if (cur) {
          show.type = cur.type; show.expired = cur.expired;
          if (!show.expired && show.type === 'soldout') observed.add(String(show.id));
        }
      }
    } catch (e) {
      console.log('  ' + c.yellow(`showtimes refresh failed (${e.message.split('\n')[0]}) — keeping cached status`));
    }

    for (const show of shows) {
      const time = String(show.timeLabel).padStart(6);
      const before = pairTotals(target, show);
      if (show.expired || show.type !== 'available') {
        delete show.seatMap;
        tally.lost++;
        const what = show.expired ? 'EXPIRED' : 'SOLD OUT';
        console.log(`  ${time}  ` + c.red(`had ${before.pairs} pair${before.pairs === 1 ? '' : 's'}  →  ${what}`));
        continue;
      }
      try {
        const sm = await apiGet(`/napi/seatMap/${show.hash}`);
        show.seatMap = compactSeatMap(sm);
        delete show.error;
        observed.add(String(show.id));
        const after = pairTotals(target, show);
        const d = after.pairs - before.pairs;
        let tag;
        if (d > 0) { tally.up++; tag = c.green(`↑ +${d} pair${d === 1 ? '' : 's'}`); }
        else if (d < 0) { tally.down++; tag = c.red(`↓ ${d} pair${d === -1 ? '' : 's'}`); }
        else { tally.same++; tag = 'no change'; }
        const stats = `pairs ${before.pairs} → ${after.pairs}   usable ${before.usable} → ${after.usable}`;
        console.log(`  ${time}  ${stats.padEnd(STATS_W)}  ${tag}`);
      } catch (e) {
        show.error = e.message.split(' for ')[0];
        tally.failed++;
        console.log(`  ${time}  ` + c.yellow(`seat map failed (${show.error})`));
      }
    }
    save();
    console.log('');
  }
  save();
  recordHistory(historyPath, target, results, 'watch', { ids: observed });

  const parts = [];
  if (tally.up) parts.push(c.green(`${tally.up} improved`));
  if (tally.down) parts.push(c.red(`${tally.down} fewer pairs`));
  if (tally.lost) parts.push(c.red(`${tally.lost} sold out/expired`));
  if (tally.same) parts.push(`${tally.same} unchanged`);
  if (tally.failed) parts.push(c.yellow(`${tally.failed} failed`));
  console.log(c.bold('Watch complete.') + '  ' + (parts.length ? parts.join('  ·  ') : 'no changes'));
}

// Full tiered-freshness scan for one target.
async function scanOneTarget(target, { fresh, start, today, isPrimary }) {
  const fd = target.fandango;
  const { targetPath, historyPath, outPaths } = targetPaths(target, isPrimary);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  const dates = Array.from({ length: fd.scanDays }, (_, i) => isoPlusDays(start, i));
  const prev = loadPrev(target, targetPath, isPrimary);
  const prevByDate = new Map((!fresh && prev?.results || []).map(r => [r.date, r]));

  // Reuse cached dates only while young enough for how far out they are.
  const resultsByDate = new Map();
  for (const d of dates) {
    const cached = prevByDate.get(d);
    if (!cached || !dateIsClean(cached)) continue;
    if (!cached.scannedAt) cached.scannedAt = prev.scannedAt; // pre-TTL scans
    const age = Date.now() - new Date(cached.scannedAt).getTime();
    if (age <= ttlMs(daysBetween(today, d))) resultsByDate.set(d, cached);
  }

  const save = () => {
    // Cached results on either side of the window (a tail a longer prior scan
    // reached; tonight's show before --start) stay put.
    const beyond = (prev?.results || []).filter(r =>
      r.date >= today && (r.date < start || r.date > dates.at(-1)));
    const results = [...beyond, ...dates.map(d => resultsByDate.get(d)).filter(Boolean)]
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const body = JSON.stringify({ scannedAt: new Date().toISOString(), source: 'fandango', config: target, results }, null, 1);
    for (const p of outPaths) writeFileSync(p, body);
    return results;
  };

  const SKIP_AFTER = fd.skipPairlessAfter ?? 2;
  let history = [];
  try { if (existsSync(historyPath)) history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch { /* corrupt -> no skips */ }

  let emptyStreak = 0;
  const observedIds = new Set();
  for (const date of dates) {
    if (resultsByDate.has(date)) {
      const cached = resultsByDate.get(date);
      const ageH = Math.round((Date.now() - new Date(cached.scannedAt).getTime()) / 3600_000);
      console.log(`${date}: using previous result (${cached.shows.length} shows, ${ageH}h old)`);
      if (cached.shows.length === 0 && ++emptyStreak >= fd.stopAfterEmptyDays) break; else if (cached.shows.length) emptyStreak = 0;
      continue;
    }
    process.stdout.write(`${date}: `);
    const prevShows = new Map((prevByDate.get(date)?.shows || []).map(s => [s.id, s]));
    const out = { date, scannedAt: new Date().toISOString(), shows: [], errors: [] };
    try {
      const st = await getShowtimes(fd, date);
      const shows = matchingShowtimes(st, fd);
      for (const show of shows) {
        if (show.expired || show.type !== 'available') {
          out.shows.push(show);
          if (!show.expired && show.type === 'soldout') observedIds.add(String(show.id));
          process.stdout.write(show.type === 'soldout' ? 'S' : 'x');
          continue;
        }
        const prevShow = prevShows.get(show.id);
        if (SKIP_AFTER > 0 && prevShow?.seatMap && pairlessStreak(history, show.id) >= SKIP_AFTER) {
          out.shows.push({ ...show, seatMap: prevShow.seatMap, seatMapCarried: true });
          process.stdout.write('·');
          continue;
        }
        try {
          const sm = await apiGet(`/napi/seatMap/${show.hash}`);
          out.shows.push({ ...show, seatMap: compactSeatMap(sm) });
          observedIds.add(String(show.id));
          process.stdout.write('■');
        } catch (e) {
          out.shows.push({ ...show, error: e.message.split(' for ')[0] });
          process.stdout.write('✗');
        }
      }
      console.log(` ${shows.length} show(s)`);
      if (shows.length === 0) { if (++emptyStreak >= fd.stopAfterEmptyDays) { resultsByDate.set(date, out); save(); console.log(`No ${fd.formatFilter} shows for ${fd.stopAfterEmptyDays} straight days — end of run reached.`); break; } }
      else emptyStreak = 0;
    } catch (e) {
      out.errors.push(e.message);
      console.log(`ERROR: ${e.message.split('\n')[0]}`);
    }
    resultsByDate.set(date, out);
    save();
  }

  const results = save();
  recordHistory(historyPath, target, results, 'scan', { ids: observedIds });
  const counts = results.flatMap(r => r.shows);
  const withSeats = counts.filter(s => s.seatMap).length;
  const soldout = counts.filter(s => s.type === 'soldout').length;
  const failed = counts.filter(s => s.error).length;

  // onsale mode: before tickets open the title simply isn't in the payload, so
  // zero shows is the "not on sale yet" signal, not an error. Once it appears,
  // the same scan captures seats — no mode switch needed.
  if (target.mode === 'onsale' && counts.length === 0) {
    console.log('⏳ Not on sale yet — no showtimes for this title/format.');
    return;
  }
  console.log(`Done. ${counts.length} showtimes: ${withSeats} with seat maps, ${soldout} sold out, ${failed} failed`);
  if (failed || results.some(r => r.errors.length)) console.log('Incomplete — re-run to fill gaps.');
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  const watch = process.argv.includes('--watch');
  await ensureChromeReady(cfg);

  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
  const startArg = (process.argv.find(a => a.startsWith('--start=')) || '').slice(8);
  if (startArg && !/^\d{4}-\d{2}-\d{2}$/.test(startArg)) throw new Error(`--start wants YYYY-MM-DD, got "${startArg}"`);
  const start = startArg > today ? startArg : today;

  const targets = expandTargets(cfg);
  console.log(c.bold(`Scanning ${targets.length} target${targets.length === 1 ? '' : 's'}${watch ? ' (watch)' : fresh ? ' (fresh)' : ''}.`));

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const isPrimary = i === 0;
    const fd = target.fandango;
    const label = `${fd.movieTitle || fd.movieTitleMatch} · ${fd.formatFilter} · ${target.theatreName || fd.theaterId}`;
    console.log('\n' + c.bold(c.cyan(`=== ${label} ===`)));
    try {
      if (watch) {
        const { targetPath, historyPath, outPaths } = targetPaths(target, isPrimary);
        const prev = loadPrev(target, targetPath, isPrimary);
        await watchRun(target, historyPath, outPaths, prev, today);
      } else {
        await scanOneTarget(target, { fresh, start, today, isPrimary });
      }
    } catch (e) {
      console.error(c.red(`[${label}] ${e.message.split('\n')[0]}`));
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
