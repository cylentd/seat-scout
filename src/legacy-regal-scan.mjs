// Scans every on-sale date for matching showtimes and captures each one's seat plan.
// Each Regal API call is its own short in-page eval (long evals trip the CLI's read
// timeout), with Cloudflare-challenge recovery between calls.
// Usage: node src/scan.mjs [--fresh]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evalInChrome, ensureChromeReady, tryClearChallenge, reloadPage } from './browser.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const sleep = ms => new Promise(res => setTimeout(res, ms));

function fmtDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${m}-${d}-${y}`; // Regal API format
}

// One fetch per eval — fast enough to never hit the CLI read timeout.
function tryFetch(url) {
  try {
    const res = evalInChrome(cfg, `
(async () => {
  const r = await fetch(${JSON.stringify(url)}, {credentials: 'include'});
  if (!r.ok) return { httpStatus: r.status };
  return { httpStatus: 200, data: await r.json() };
})()`);
    return res;
  } catch (e) {
    return { httpStatus: 0, error: e.message.split('\n')[0] };
  }
}

// Cloudflare's WAF rate-flags this endpoint after bursts, and only a *human* click
// on the Turnstile checkbox reliably restores clearance. On a 403, try one automated
// clear, then park and wait for the user to click (polling until access returns).
async function apiGet(url) {
  let res = tryFetch(url);
  if (res.httpStatus === 200) return res.data;

  if (tryClearChallenge(cfg)) process.stdout.write('[challenge auto-clicked] ');
  await sleep(8000);
  res = tryFetch(url);
  if (res.httpStatus === 200) return res.data;

  // Flagged. Do NOT poll aggressively — repeated hits keep the WAF flag hot.
  // Go quiet, then probe at a gentle cadence. If a challenge checkbox renders,
  // a human click clears it; otherwise the flag just needs cool-down time.
  console.log('\n*** RATE-FLAGGED: pausing. If a "Verify you are human" checkbox appears in Chrome, click it. ***');
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(120000); // 2 min of silence per probe
    tryClearChallenge(cfg);
    res = tryFetch(url);
    if (res.httpStatus === 200) {
      console.log('*** Access restored, resuming scan ***');
      return res.data;
    }
    if (res.httpStatus === 0) reloadPage(cfg);
  }
  throw new Error(`${res.error || 'HTTP ' + res.httpStatus} for ${url}`);
}

async function getFilmDays() {
  const days = new Set();
  for (const code of Object.keys(cfg.movieCodes)) {
    try {
      const entries = await apiGet(`/api/GetTheatreFilmDays?theatreCode=${cfg.theatreCode}&hoCode=${code}`);
      for (const entry of entries) for (const d of entry.days || []) days.add(d);
    } catch (e) {
      console.log(`  (film days for ${code}: ${e.message.split(' for ')[0]})`);
    }
  }
  return [...days].sort();
}

async function getPerformances(dateIso) {
  const codes = Object.keys(cfg.movieCodes);
  const patterns = cfg.formatFilter.mustMatchAttrs.map(p => new RegExp(p, 'i'));
  const j = await apiGet(`/api/getShowtimes?theatres=${cfg.theatreCode}&date=${fmtDate(dateIso)}&hoCode=&ignoreCache=false&moviesOnly=false`);
  const days = Array.isArray(j) ? j : (j.shows || []);
  const perfs = [];
  for (const day of days) {
    for (const film of day.Film || []) {
      if (!codes.includes(film.MasterMovieCode)) continue;
      for (const p of film.Performances || []) {
        const attrStr = (p.PerformanceAttributes || []).join(' ');
        if (patterns.every(re => re.test(attrStr))) {
          perfs.push({ movieCode: film.MasterMovieCode, title: film.Title, id: p.PerformanceId,
                       time: p.CalendarShowTime, auditorium: p.Auditorium,
                       attrs: p.PerformanceAttributes, stopSales: !!p.StopSales });
        }
      }
    }
  }
  return perfs;
}

async function getSeatRows(perfId) {
  const sp = await apiGet(`/api/GetSeatPlan?theatreCode=${cfg.theatreCode}&sessionId=${perfId}`);
  const rows = [];
  for (const area of sp.SeatLayoutData?.Areas || []) {
    for (const row of area.Rows || []) {
      if (!row.Seats?.length) continue;
      rows.push({ row: row.PhysicalName, rowIndex: row.RowIndexZeroBased,
                  seats: row.Seats.map(s => [s.Id, s.Position.ColumnIndex, s.Status]) });
    }
  }
  return rows;
}

function dateIsClean(res) {
  return res && !res.errors?.length && res.shows.every(s => s.rows && !s.error);
}

async function main() {
  const fresh = process.argv.includes('--fresh');
  await ensureChromeReady(cfg);
  if (tryClearChallenge(cfg)) console.log('Cleared a pending Cloudflare challenge.');

  console.log('Fetching on-sale dates...');
  const days = await getFilmDays();
  console.log(`${days.length} dates on sale: ${days[0]?.slice(0, 10)} -> ${days.at(-1)?.slice(0, 10)}`);

  const outPath = path.join(ROOT, 'data', 'scan-latest.json');
  const prev = !fresh && existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
  const prevByDate = new Map((prev?.results || []).map(r => [r.date, r]));

  // Seed with clean cached dates so an interrupted rerun never loses them.
  const resultsByDate = new Map();
  for (const day of days) {
    const cached = prevByDate.get(day.slice(0, 10));
    if (cached && dateIsClean(cached)) resultsByDate.set(day.slice(0, 10), cached);
  }
  const save = () => {
    const results = days.map(d => resultsByDate.get(d.slice(0, 10))).filter(Boolean);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), config: cfg, results }, null, 1));
    return results;
  };

  for (const day of days) {
    const label = day.slice(0, 10);
    if (resultsByDate.has(label)) {
      console.log(`${label}: using previous result (${resultsByDate.get(label).shows.length} shows)`);
      continue;
    }
    process.stdout.write(`${label}: `);
    const out = { date: label, shows: [], errors: [] };
    try {
      const perfs = await getPerformances(day);
      for (const perf of perfs) {
        // human-ish pacing: jittered delay so requests don't land on a metronome
        await sleep(cfg.throttleMs * (0.7 + Math.random() * 0.6));
        try {
          out.shows.push({ ...perf, rows: await getSeatRows(perf.id) });
          process.stdout.write('■');
        } catch (e) {
          out.shows.push({ ...perf, error: e.message.split(' for ')[0] });
          process.stdout.write('✗');
        }
      }
      console.log(` ${out.shows.length} show(s)`);
    } catch (e) {
      out.errors.push(e.message);
      console.log(`ERROR: ${e.message.split('\n')[0]}`);
    }
    resultsByDate.set(label, out);
    save(); // persist incrementally so an interrupted scan still resumes
  }

  const results = save();
  const total = results.reduce((n, r) => n + r.shows.length, 0);
  const failedShows = results.reduce((n, r) => n + r.shows.filter(s => s.error).length, 0);
  const failedDates = results.filter(r => r.errors.length).length;
  console.log(`\nDone. ${total} showtimes captured -> ${outPath}`);
  if (failedShows || failedDates) {
    console.log(`Incomplete: ${failedShows} show(s) / ${failedDates} date(s) failed — re-run "node src/scan.mjs" to fill gaps.`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
