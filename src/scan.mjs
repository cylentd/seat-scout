// Fandango-based scanner: finds matching showtimes and captures seat maps.
// All calls run in-page on fandango.com inside a real Chrome (see browser.mjs).
// Sold-out showtimes are detected from the showtimes payload and skipped — the
// seat-map endpoint is only hit for shows with availability.
//
// Usage: node src/scan.mjs [--fresh|--watch] [--start=YYYY-MM-DD]
//   --start    begin the scan window at a later date instead of today — e.g. a
//              known run extension — so no requests are spent walking the empty
//              gap in between. Cached results before the window are kept.
//   (default)  tiered-freshness scan: cached dates are reused only while young
//              enough for how far out they are (see TTL_TIERS below); shows
//              that have had zero bookable pairs for skipPairlessAfter straight
//              observations keep their cached seat map instead of a re-fetch
//   --fresh    ignore the cache entirely and re-fetch every date
//   --watch    cheap check-in: re-fetch seat maps only for shows that had pairs
//              in the last scan (plus one showtimes call per affected date to
//              catch sell-outs) — the "should I book today?" run
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evalInChrome, ensureChromeReady } from './browser.mjs';
import { PolitenessBudget, sleep } from './polite.mjs';
import {
  isoPlusDays, matchingShowtimes, compactSeatMap, dateIsClean,
  ttlMs, daysBetween, pairTotals, sameTarget, targetKey,
  observeResults, appendHistory, pairlessStreak, calendarDates, calendarIsTheatreWide,
} from './scan-core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const fd = cfg.fandango;
const budget = new PolitenessBudget(cfg.politeness);

// Lightweight ANSI styling. No-ops when stdout isn't a terminal (piped or
// redirected) or when NO_COLOR is set, so saved logs stay plain text.
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

// Sell-rate history: one compact observation appended per completed run, so
// the report can show how fast seats are moving (see computeTrend).
const historyPath = path.join(ROOT, 'data', `history-${targetKey(cfg)}.json`);
function recordHistory(results, kind, observed) {
  const shows = observeResults(cfg, results, observed);
  if (!Object.keys(shows).length) return;
  let history = [];
  try { if (existsSync(historyPath)) history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch { /* corrupt -> restart */ }
  history = appendHistory(history, { at: new Date().toISOString(), kind, shows });
  writeFileSync(historyPath, JSON.stringify(history, null, 1));
}

function tryFetch(url) {
  try {
    return evalInChrome(cfg, `
(async () => {
  const r = await fetch(${JSON.stringify(url)}, {credentials: 'include'});
  const retryAfter = r.headers.get('retry-after');
  if (!r.ok) return { httpStatus: r.status, retryAfter };
  return { httpStatus: 200, data: await r.json() };
})()`);
  } catch (e) {
    return { httpStatus: 0, error: e.message.split('\n')[0] };
  }
}

// Every request passes through the politeness budget (rate cap + off-peak gate).
// Server backpressure (429/503 + Retry-After) is honored exactly; a hard block
// (403/challenge) parks and waits for a human to clear the check.
async function apiGet(url) {
  for (let attempt = 1; ; attempt++) {
    await budget.beforeRequest();
    const res = tryFetch(url);
    if (res.httpStatus === 200) return res.data;

    // 404/410 are permanent — the resource is gone (e.g. a showtime removed
    // while still listed). Parking and retrying would stall the scan for
    // minutes on something that can never succeed.
    if (res.httpStatus === 404 || res.httpStatus === 410) throw new Error(`HTTP ${res.httpStatus} for ${url}`);

    const backoff = budget.backoffFor(res.httpStatus, res.retryAfter, attempt);
    if (backoff > 0 && attempt <= 6) {
      console.log(c.yellow(`\n[${res.httpStatus}${res.retryAfter ? ' Retry-After ' + res.retryAfter : ''}] honoring backpressure — waiting ${Math.round(backoff / 1000)}s`));
      await sleep(backoff);
      continue;
    }

    // Not throttling — a hard block or dead page. One quiet retry, then park.
    if (attempt === 1) { console.log(c.yellow(`\n[${res.error || 'HTTP ' + res.httpStatus}] backing off 90s…`)); await sleep(90000); continue; }
    console.log(c.red('*** Blocked — parking. If Chrome shows a verification prompt, click it. ***'));
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(120000);
      const r2 = tryFetch(url);
      if (r2.httpStatus === 200) { console.log(c.green('*** Access restored ***')); return r2.data; }
    }
    throw new Error(`${res.error || 'HTTP ' + res.httpStatus} for ${url}`);
  }
}

// One cheap calendar call: has the theatre opened dates beyond what we scanned?
// Fandango serves theaterCalendar THEATRE-WIDE (not per-film) for both Regal and
// AMC, so a hit means "the venue has some showtime out there" — not necessarily
// this movie. Hence the hedged wording and the pointer at drop-watch, which
// confirms per-film by asking theaterMovieShowtimes directly.
async function supplyProbe(results, today) {
  try {
    const cal = await apiGet(`/napi/theaterCalendar/${fd.theaterId}?chainCode=${fd.chainCode}`);
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

// --watch: revisit only the shows worth booking. One showtimes call per affected
// date refreshes sold-out/expired flags for every show on that date; seat maps
// are re-fetched just for the previous pair-bearers. ~7x fewer requests than a
// full scan, so it can run daily without leaning on Fandango.
async function watchRun(prev, outPaths, today) {
  if (!prev) throw new Error('No previous scan to watch — run "node src/scan.mjs" first.');
  const results = prev.results || [];
  const plan = [];
  for (const r of results) {
    if (r.date < today) continue;
    const targets = r.shows.filter(s =>
      s.seatMap && !s.expired && s.type === 'available' && pairTotals(cfg, s).pairs > 0);
    if (targets.length) plan.push({ result: r, targets });
  }
  // Supply probe runs BEFORE the "nothing to watch" bail-out below. A run with
  // no bookable pairs left is precisely when an extension matters most, so
  // returning early without probing hid the one thing worth reporting.
  await supplyProbe(results, today);

  const total = plan.reduce((n, p) => n + p.targets.length, 0);
  if (!total) {
    console.log(c.yellow('Nothing to watch — the last scan found no showtimes with bookable pairs.'));
    return;
  }

  console.log(c.bold(`Watching ${total} showtime${total === 1 ? '' : 's'} with bookable pairs across ${plan.length} day${plan.length === 1 ? '' : 's'}.`));
  console.log('pairs = adjacent seats for your party  ·  usable = open seats in your preferred rows\n');

  const save = () => {
    const body = JSON.stringify({ ...prev, scannedAt: new Date().toISOString(), results }, null, 1);
    for (const p of outPaths) writeFileSync(p, body);
  };

  const tally = { up: 0, down: 0, same: 0, lost: 0, failed: 0 };
  const STATS_W = 30; // width of the "pairs X → Y   usable A → B" block; tags align after it
  const observed = new Set(); // show ids with genuinely fresh data this run

  for (const { result, targets } of plan) {
    const date = result.date;
    console.log(c.cyan(dayLabel(date, today)));

    try {
      const st = await apiGet(`/napi/theaterMovieShowtimes/${fd.theaterId}?chainCode=${fd.chainCode}&startDate=${date}&isdesktop=true&partnerRestrictedTicketing=`);
      const current = new Map(matchingShowtimes(st, fd).map(s => [s.id, s]));
      for (const show of result.shows) {
        const cur = current.get(show.id);
        if (cur) {
          show.type = cur.type; show.expired = cur.expired;
          // A sold-out flag from the payload is a real observation (p=0, u=0).
          if (!show.expired && show.type === 'soldout') observed.add(String(show.id));
        }
      }
    } catch (e) {
      console.log('  ' + c.yellow(`showtimes refresh failed (${e.message.split('\n')[0]}) — keeping cached status`));
    }

    for (const show of targets) {
      const time = String(show.timeLabel).padStart(6);
      const before = pairTotals(cfg, show);
      if (show.expired || show.type !== 'available') {
        delete show.seatMap; // no longer purchasable; report renders it sold out
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
        const after = pairTotals(cfg, show);
        const d = after.pairs - before.pairs;
        let tag;
        if (d > 0) { tally.up++; tag = c.green(`↑ +${d} pair${d === 1 ? '' : 's'}`); }
        else if (d < 0) { tally.down++; tag = c.red(`↓ ${d} pair${d === -1 ? '' : 's'}`); }
        else { tally.same++; tag = 'no change'; }
        // Pad the (uncolored) stats to a fixed width so the change tags line up in their own column.
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
  recordHistory(results, 'watch', { ids: observed });

  const parts = [];
  if (tally.up) parts.push(c.green(`${tally.up} improved`));
  if (tally.down) parts.push(c.red(`${tally.down} fewer pairs`));
  if (tally.lost) parts.push(c.red(`${tally.lost} sold out/expired`));
  if (tally.same) parts.push(`${tally.same} unchanged`);
  if (tally.failed) parts.push(c.yellow(`${tally.failed} failed`));
  console.log(c.bold('Watch complete.') + '  ' + (parts.length ? parts.join('  ·  ') : 'no changes'));
  console.log('The report rebuilds next (or run: node src/report.mjs).');
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  const watch = process.argv.includes('--watch');
  await ensureChromeReady(cfg);

  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
  const startArg = (process.argv.find(a => a.startsWith('--start=')) || '').slice(8);
  if (startArg && !/^\d{4}-\d{2}-\d{2}$/.test(startArg)) throw new Error(`--start wants YYYY-MM-DD, got "${startArg}"`);
  const start = startArg > today ? startArg : today;
  const dates = Array.from({ length: fd.scanDays }, (_, i) => isoPlusDays(start, i));

  // Each target caches to its own file; scan-latest.json mirrors the most
  // recent run so report.mjs (and sharing flows) stay a single known path.
  const latestPath = path.join(ROOT, 'data', 'scan-latest.json');
  const targetPath = path.join(ROOT, 'data', 'scans', `${targetKey(cfg)}.json`);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  let prev = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, 'utf8')) : null;
  if (!prev && existsSync(latestPath)) {
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
    if (sameTarget(latest.config, cfg)) prev = latest; // migrate pre-per-target caches
  }
  if (prev && !sameTarget(prev.config, cfg)) prev = null; // hash-collision safety net

  if (watch) return watchRun(prev, [targetPath, latestPath], today);

  const prevByDate = new Map((!fresh && prev?.results || []).map(r => [r.date, r]));

  const resultsByDate = new Map();
  for (const d of dates) {
    const cached = prevByDate.get(d);
    if (!cached || !dateIsClean(cached)) continue;
    // Reuse only while the cache is young enough for how far out the date is.
    if (!cached.scannedAt) cached.scannedAt = prev.scannedAt; // pre-TTL scans
    const age = Date.now() - new Date(cached.scannedAt).getTime();
    if (age <= ttlMs(daysBetween(today, d))) resultsByDate.set(d, cached);
  }
  const save = () => {
    // The scan window is a slice of the run, not all of it: --start begins it
    // later, and scanDays bounds its far edge. Cached results on either side
    // (tonight's bookable show; a tail a longer prior scan reached) stay put.
    const beyond = (prev?.results || []).filter(r =>
      r.date >= today && (r.date < start || r.date > dates.at(-1)));
    const results = [...beyond, ...dates.map(d => resultsByDate.get(d)).filter(Boolean)]
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const body = JSON.stringify({ scannedAt: new Date().toISOString(), source: 'fandango', config: cfg, results }, null, 1);
    writeFileSync(targetPath, body);
    writeFileSync(latestPath, body);
    return results;
  };

  // Skip-rule inputs: a show with zero bookable pairs for skipPairlessAfter
  // straight observations keeps its cached seat map instead of costing a fresh
  // request every scan ('·' in the progress line). Carried shows are excluded
  // from history observation so a stale map can never extend its own streak;
  // --fresh has no cache and so refetches everything.
  const SKIP_AFTER = fd.skipPairlessAfter ?? 2;
  let history = [];
  try { if (existsSync(historyPath)) history = JSON.parse(readFileSync(historyPath, 'utf8')); } catch { /* corrupt -> no skips */ }

  let emptyStreak = 0;
  const observedIds = new Set(); // show ids with genuinely fresh data this run
  for (const date of dates) {
    if (resultsByDate.has(date)) {
      const c = resultsByDate.get(date);
      const ageH = Math.round((Date.now() - new Date(c.scannedAt).getTime()) / 3600_000);
      console.log(`${date}: using previous result (${c.shows.length} shows, ${ageH}h old)`);
      if (c.shows.length === 0 && ++emptyStreak >= fd.stopAfterEmptyDays) break; else if (c.shows.length) emptyStreak = 0;
      continue;
    }
    process.stdout.write(`${date}: `);
    const prevShows = new Map((prevByDate.get(date)?.shows || []).map(s => [s.id, s]));
    const out = { date, scannedAt: new Date().toISOString(), shows: [], errors: [] };
    try {
      const st = await apiGet(`/napi/theaterMovieShowtimes/${fd.theaterId}?chainCode=${fd.chainCode}&startDate=${date}&isdesktop=true&partnerRestrictedTicketing=`);
      const shows = matchingShowtimes(st, fd);
      for (const show of shows) {
        if (show.expired || show.type !== 'available') {
          out.shows.push(show);
          // A sold-out flag from the payload is a real observation (p=0, u=0).
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
  recordHistory(results, 'scan', { ids: observedIds });
  const counts = results.flatMap(r => r.shows);
  const withSeats = counts.filter(s => s.seatMap).length;
  const soldout = counts.filter(s => s.type === 'soldout').length;
  const failed = counts.filter(s => s.error).length;
  console.log(`\nDone. ${counts.length} showtimes: ${withSeats} with seat maps, ${soldout} sold out, ${failed} failed -> ${targetPath}`);
  if (failed || results.some(r => r.errors.length)) console.log('Incomplete — re-run "node src/scan.mjs" to fill gaps.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
