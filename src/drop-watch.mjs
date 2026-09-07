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
// Usage: node src/drop-watch.mjs [--once] [--verbose]
//   reads watchlist.json; --once is the default and only mode (scheduling is
//   the OS's job — see README), --verbose prints every probed date.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureChromeReady } from './browser.mjs';
import { PolitenessBudget } from './polite.mjs';
import { apiGet, showtimesPath, calendarPath } from './fandango-api.mjs';
import {
  matchingShowtimes, calendarDates, snapshotFromDates, runEndOf,
  diffDrops, mergeSnapshot, probePlan, targetKey, isoPlusDays,
} from './scan-core.mjs';
import { alert } from './notify.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.argv.includes('--verbose');

const watchlist = JSON.parse(readFileSync(path.join(ROOT, 'watchlist.json'), 'utf8'));
const snapDir = path.join(ROOT, 'data', 'drops');
mkdirSync(snapDir, { recursive: true });

const readJson = (p, fallback) => {
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

// First run for a target: seed from an existing scan rather than alerting on
// the entire known run as though it just dropped.
function bootstrapSnapshot(key) {
  const scan = readJson(path.join(ROOT, 'data', 'scans', `${key}.json`), null);
  if (!scan?.results?.length) return null;
  return snapshotFromDates(scan.results.map(r => ({ date: r.date, shows: r.shows })));
}

async function checkTarget(t, browserCfg, budget, today) {
  const cfg = cfgFor(t);
  const key = targetKey(cfg);
  const snapPath = path.join(snapDir, `${key}.json`);

  let prev = readJson(snapPath, null);
  if (!prev) {
    prev = bootstrapSnapshot(key);
    if (prev) console.log(`  seeded from previous scan (run ends ${runEndOf(prev)})`);
  }
  // With no baseline at all, every date we probe is "new" only because we have
  // never looked. Record it, report it, but don't page anyone.
  const hadBaseline = !!prev;

  // Cheap negative filter: dates the venue has no showtimes at all can't have ours.
  let calendar = null;
  try {
    calendar = calendarDates(await apiGet(browserCfg, budget, calendarPath(t.theaterId, t.chainCode)));
  } catch { /* filter is an optimisation, not a requirement */ }

  const calSet = calendar?.length ? new Set(calendar) : null;

  // Returns { date, shows } on success, null when the request failed. A failed
  // probe is UNKNOWN, not empty — dropping it keeps the diff from reading an
  // outage as "the showtimes vanished".
  const probeOne = async (date) => {
    if (calSet && !calSet.has(date)) {
      if (VERBOSE) console.log(`    ${date}: no theatre showtimes (skipped, no request)`);
      return { date, shows: [] };
    }
    try {
      const st = await apiGet(browserCfg, budget, showtimesPath(t.theaterId, t.chainCode, date),
        { log: m => console.log('  ' + m) });
      const shows = matchingShowtimes(st, cfg.fandango);
      if (VERBOSE) console.log(`    ${date}: ${shows.length} show(s)`);
      return { date, shows };
    } catch (e) {
      console.log(`    ${date}: probe failed (${e.message.split('\n')[0]}) — skipped`);
      return null;
    }
  };

  const probed = [];
  if (!hadBaseline) {
    // Cold start: walk forward until the run demonstrably ends, rather than
    // stopping at an arbitrary window edge. Otherwise the recorded run end is
    // just "as far as we happened to look", and every later run would report
    // the untouched remainder of the run as a fresh extension.
    const stopAfterEmpty = watchlist.stopAfterEmptyDays ?? 4;
    const maxDays = watchlist.maxDiscoverDays ?? 60;
    console.log(`  no baseline — discovering the full run (up to ${maxDays} days)`);
    let empty = 0;
    for (let i = 0; i < maxDays && empty < stopAfterEmpty; i++) {
      const r = await probeOne(isoPlusDays(today, i));
      if (!r) continue;
      probed.push(r);
      empty = r.shows.length ? 0 : empty + 1;
    }
  } else {
    const dates = probePlan({
      today,
      runEnd: runEndOf(prev),
      aheadDays: t.aheadDays ?? watchlist.aheadDays ?? 10,
      recheckDays: t.recheckDays ?? watchlist.recheckDays ?? 4,
      calendar,
    });
    if (VERBOSE) console.log(`  probing ${dates.length} date(s): ${dates.join(', ')}`);
    for (const date of dates) {
      const r = await probeOne(date);
      if (r) probed.push(r);
    }
  }

  const cur = snapshotFromDates(probed);
  const diff = diffDrops(prev, cur);
  writeFileSync(snapPath, JSON.stringify({
    checkedAt: new Date().toISOString(), target: t, ...mergeSnapshot(prev, cur),
  }, null, 1));

  return { diff, suppress: !hadBaseline };
}

async function main() {
  const targets = watchlist.targets || [];
  if (!targets.length) throw new Error('watchlist.json has no targets.');

  const browserCfg = {
    browserSession: watchlist.browserSession ?? 'real',
    cdpPort: watchlist.cdpPort ?? 9222,
    fandango: { theaterId: targets[0].theaterId, theaterSlug: targets[0].theaterSlug },
  };
  await ensureChromeReady(browserCfg);

  const budget = new PolitenessBudget(watchlist.politeness);
  const today = new Date().toLocaleDateString('sv-SE');
  const webhookUrl = process.env.SEAT_SCOUT_DISCORD_WEBHOOK || watchlist.discordWebhook || null;
  if (!webhookUrl) console.log('(no Discord webhook configured — terminal only)');

  console.log(`Drop watch · ${new Date().toLocaleString()} · ${targets.length} target(s)`);
  let hits = 0;
  for (const t of targets) {
    console.log(`\n${t.name} — ${t.movieTitle || t.movieTitleMatch} (${t.format})`);
    try {
      const { diff, suppress } = await checkTarget(t, browserCfg, budget, today);
      if (suppress) {
        console.log(`  baseline recorded (run ends ${diff.runEnd || 'unknown'}) — alerts start from the next run`);
        continue;
      }
      await alert({ name: t.name, movie: t.movieTitle || t.movieTitleMatch, format: t.format }, diff, { webhookUrl });
      if (diff.supply || diff.returns) hits++;
    } catch (e) {
      console.log(`  check failed: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(hits ? `\nDone — ${hits} target(s) had news.` : '\nDone — nothing new.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
