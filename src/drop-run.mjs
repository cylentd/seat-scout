// Drop watcher decisions: which baseline, which dates, whether to alert.
//
// Every outside effect (Chrome, Fandango, Discord, the clock) arrives as an
// argument, so these rules are testable without a browser. src/drop-watch.mjs
// is the shell that wires the real ones. The diff itself lives in scan-core.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  matchingShowtimes, calendarDates, snapshotFromDates, runEndOf,
  diffDrops, mergeSnapshot, probePlan, targetKey, isoPlusDays,
} from './scan-core.mjs';

export const readJson = (p, fallback) => {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }
  catch { return fallback; }
};

// A watchlist entry is shaped like a scan config's fandango block, so targetKey
// (and therefore the snapshot filename) matches the scanner's naming exactly.
const cfgFor = t => ({
  fandango: {
    theaterId: t.theaterId, chainCode: t.chainCode,
    movieTitleMatch: t.movieTitleMatch, formatFilter: t.format,
  },
});

export function statePaths(root, t) {
  const key = targetKey(cfgFor(t));
  return {
    snapPath: path.join(root, 'data', 'drops', `${key}.json`),
    scanPath: path.join(root, 'data', 'scans', `${key}.json`),
  };
}

// First run for a target: seed from an existing scan rather than alerting on
// the entire known run as though it just dropped.
export function seedFromScan(scan) {
  if (!scan?.results?.length) return null;
  return snapshotFromDates(scan.results.map(r => ({ date: r.date, shows: r.shows })));
}

// The stored snapshot, else one seeded from the last scan, else null.
export function loadBaseline({ snapPath, scanPath }, log) {
  let prev = readJson(snapPath, null);
  if (!prev) {
    prev = seedFromScan(readJson(scanPath, null));
    if (prev) log(`  seeded from previous scan (run ends ${runEndOf(prev)})`);
  }
  return prev;
}

// Target settings beat watchlist settings beat defaults; 0 is a real setting.
export const windowFor = (t, watchlist) => ({
  aheadDays: t.aheadDays ?? watchlist.aheadDays ?? 10,
  recheckDays: t.recheckDays ?? watchlist.recheckDays ?? 4,
  stopAfterEmpty: watchlist.stopAfterEmptyDays ?? 4,
  maxDays: watchlist.maxDiscoverDays ?? 60,
});

// The environment variable wins and keeps the URL out of the repo.
export const webhookFor = (env, watchlist) =>
  env.SEAT_SCOUT_DISCORD_WEBHOOK || watchlist.discordWebhook || null;

// drops.bat documents -v, the script --verbose; both print every probed date.
export const isVerbose = argv => argv.includes('--verbose') || argv.includes('-v');

export const browserCfgFor = (watchlist, first) => ({
  browserSession: watchlist.browserSession ?? 'real',
  cdpPort: watchlist.cdpPort ?? 9222,
  fandango: { theaterId: first.theaterId, theaterSlug: first.theaterSlug },
});

// Returns a probe: date -> { date, shows } on success, null when the request
// failed. A failed probe is UNKNOWN, not empty — dropping it keeps the diff
// from reading an outage as "the showtimes vanished".
export function makeProbe({ calendar, fetchShows, log, verbose }) {
  // Cheap negative filter: dates the venue has no showtimes at all can't have ours.
  const calSet = calendar?.length ? new Set(calendar) : null;
  return async (date) => {
    if (calSet && !calSet.has(date)) {
      if (verbose) log(`    ${date}: no theatre showtimes (skipped, no request)`);
      return { date, shows: [] };
    }
    try {
      const shows = await fetchShows(date);
      if (verbose) log(`    ${date}: ${shows.length} show(s)`);
      return { date, shows };
    } catch (e) {
      log(`    ${date}: probe failed (${e.message.split('\n')[0]}) — skipped`);
      return null;
    }
  };
}

// Cold start: walk forward until the run demonstrably ends, rather than
// stopping at an arbitrary window edge. Otherwise the recorded run end is just
// "as far as we happened to look", and every later run would report the
// untouched remainder of the run as a fresh extension.
export async function discoverRun({ today, probe, stopAfterEmpty, maxDays }) {
  const probed = [];
  let empty = 0;
  for (let i = 0; i < maxDays && empty < stopAfterEmpty; i++) {
    const r = await probe(isoPlusDays(today, i));
    if (!r) continue;
    probed.push(r);
    empty = r.shows.length ? 0 : empty + 1;
  }
  return probed;
}

// One target against its baseline. Returns the diff, whether to suppress the
// alert (no baseline yet) and the merged snapshot to store.
export async function checkTarget(t, { watchlist, today, prev, getCalendar, getShowtimes, log, verbose }) {
  const cfg = cfgFor(t);
  // With no baseline at all, every date we probe is "new" only because we have
  // never looked. Record it, report it, but don't page anyone.
  const hadBaseline = !!prev;

  let calendar = null;
  try {
    calendar = calendarDates(await getCalendar());
  } catch { /* filter is an optimisation, not a requirement */ }

  const probe = makeProbe({
    calendar, log, verbose,
    fetchShows: async date => matchingShowtimes(await getShowtimes(date), cfg.fandango),
  });
  const w = windowFor(t, watchlist);

  let probed = [];
  if (!hadBaseline) {
    log(`  no baseline — discovering the full run (up to ${w.maxDays} days)`);
    probed = await discoverRun({ today, probe, stopAfterEmpty: w.stopAfterEmpty, maxDays: w.maxDays });
  } else {
    const dates = probePlan({
      today, runEnd: runEndOf(prev), aheadDays: w.aheadDays, recheckDays: w.recheckDays, calendar,
    });
    if (verbose) log(`  probing ${dates.length} date(s): ${dates.join(', ')}`);
    for (const date of dates) {
      const r = await probe(date);
      if (r) probed.push(r);
    }
  }

  const cur = snapshotFromDates(probed);
  return { diff: diffDrops(prev, cur), suppress: !hadBaseline, snapshot: mergeSnapshot(prev, cur) };
}

// The whole run. `api.calendar(browserCfg, budget, t)` and
// `api.showtimes(browserCfg, budget, t, date, log)` return Fandango payloads.
export async function runWatch({
  root, watchlist, env, now, verbose, log,
  ensureChromeReady, makeBudget, api, alert,
}) {
  mkdirSync(path.join(root, 'data', 'drops'), { recursive: true });
  const targets = watchlist.targets || [];
  if (!targets.length) throw new Error('watchlist.json has no targets.');

  const browserCfg = browserCfgFor(watchlist, targets[0]);
  await ensureChromeReady(browserCfg);

  const budget = makeBudget(watchlist.politeness);
  const today = now().toLocaleDateString('sv-SE');
  const webhookUrl = webhookFor(env, watchlist);
  if (!webhookUrl) log('(no Discord webhook configured — terminal only)');

  log(`Drop watch · ${now().toLocaleString()} · ${targets.length} target(s)`);
  let hits = 0;
  for (const t of targets) {
    const movie = t.movieTitle || t.movieTitleMatch;
    log(`\n${t.name} — ${movie} (${t.format})`);
    try {
      const paths = statePaths(root, t);
      const prev = loadBaseline(paths, log);
      const { diff, suppress, snapshot } = await checkTarget(t, {
        watchlist, today, prev, log, verbose,
        getCalendar: () => api.calendar(browserCfg, budget, t),
        getShowtimes: date => api.showtimes(browserCfg, budget, t, date, m => log('  ' + m)),
      });
      writeFileSync(paths.snapPath, JSON.stringify({
        checkedAt: now().toISOString(), target: t, ...snapshot,
      }, null, 1));
      if (suppress) {
        log(`  baseline recorded (run ends ${diff.runEnd || 'unknown'}) — alerts start from the next run`);
        continue;
      }
      await alert({ name: t.name, movie, format: t.format }, diff, { webhookUrl });
      if (diff.supply || diff.returns) hits++;
    } catch (e) {
      log(`  check failed: ${e.message.split('\n')[0]}`);
    }
  }
  log(hits ? `\nDone — ${hits} target(s) had news.` : '\nDone — nothing new.');
  return hits;
}
