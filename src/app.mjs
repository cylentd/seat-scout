// Local launcher: serves the landing page on 127.0.0.1, takes one form
// submission, updates config.json, runs scan -> report as child processes, and
// serves the finished report.html. Loopback only — this is a local tool, not a
// hosted site. Usage: node src/app.mjs [--no-open]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderLanding } from './landing.mjs';
import { applyScoutRequest, upsertProfile } from './app-core.mjs';
import { sameTarget, targetKey, listMovies } from './scan-core.mjs';
import { parseLocationQuery, locationKey, theatresNearPath, parseNearbyTheatres, annotateForTarget } from './theatres-core.mjs';
import { evalInChrome, ensureChromeReady, launchChrome } from './browser.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8737;
const CFG_PATH = path.join(ROOT, 'config.json');
const SCAN_PATH = path.join(ROOT, 'data', 'scan-latest.json');
const REPORT_PATH = path.join(ROOT, 'report.html');

const PROFILES_PATH = path.join(ROOT, 'data', 'profiles.json');

const readCfg = () => JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const readJson = (p, fallback) => {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }
  catch { return fallback; }
};

// One job at a time; the landing page polls /status.
const job = { state: 'idle', log: '', startedAt: null };
const logLines = () => job.log.split(/\r?\n/).filter(Boolean).slice(-40);
const append = (chunk) => { job.log = (job.log + chunk).slice(-20000); };

function landingInfo(cfg) {
  // Per-target cache first; scan-latest.json covers pre-per-target scans.
  const targetPath = path.join(ROOT, 'data', 'scans', `${targetKey(cfg)}.json`);
  let prev = readJson(targetPath, null);
  if (!prev) {
    const latest = readJson(SCAN_PATH, null);
    if (latest && sameTarget(latest.config, cfg)) prev = latest;
  }
  return {
    hasReport: existsSync(REPORT_PATH),
    lastScannedAt: prev?.scannedAt || null,
    canWatch: !!prev,
  };
}

// Cached slate for the very first paint — read straight off disk, never launches
// Chrome or hits Fandango. The client still calls /suggest to refresh when the
// scanner's Chrome is up, or when the cache is empty.
function cachedSlate(cfg) {
  const cachePath = path.join(ROOT, 'data', `suggest-${cfg.fandango.theaterId}.json`);
  return readJson(cachePath, null)?.movies || [];
}

// "Playing now" for the landing page: one cached showtimes call, and only when
// the scanner's Chrome is already up — loading the landing page never launches
// a browser or hits Fandango cold.
const SUGGEST_TTL = 6 * 3600_000;

// Both on-demand Fandango lookups (/suggest, /theatres) refuse to launch a
// browser themselves — they only ride a Chrome the scanner already has up.
async function requireScanChrome(cfg, what) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`);
    if (!r.ok) throw new Error();
  } catch { throw new Error(`Chrome is not running — ${what} once a scan Chrome is up.`); }
  await ensureChromeReady(cfg);
}

async function suggestions(cfg) {
  const cachePath = path.join(ROOT, 'data', `suggest-${cfg.fandango.theaterId}.json`);
  const cached = readJson(cachePath, null);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < SUGGEST_TTL) return cached;
  await requireScanChrome(cfg, 'suggestions appear');
  const today = new Date().toLocaleDateString('sv-SE');
  const fd = cfg.fandango;
  const res = evalInChrome(cfg, `
(async () => {
  const r = await fetch(${JSON.stringify(`/napi/theaterMovieShowtimes/${fd.theaterId}?chainCode=${fd.chainCode}&startDate=${today}&isdesktop=true&partnerRestrictedTicketing=`)}, {credentials:'include'});
  if (!r.ok) return { httpStatus: r.status };
  return { httpStatus: 200, data: await r.json() };
})()`);
  if (res.httpStatus !== 200) throw new Error(`Fandango returned ${res.httpStatus}`);
  const out = { fetchedAt: new Date().toISOString(), movies: listMovies(res.data) };
  writeFileSync(cachePath, JSON.stringify(out, null, 1));
  return out;
}

// Nearby theatres for a parsed location — one theaterswithshowtimes call,
// cached per location. The payload's movie list is for the requested date, so
// a cache from yesterday would badge yesterday's slate: the date is part of
// the freshness check, not just age.
const THEATRES_TTL = 12 * 3600_000;
async function theatresNear(cfg, loc) {
  const today = new Date().toLocaleDateString('sv-SE');
  const cachePath = path.join(ROOT, 'data', `theatres-${locationKey(loc)}.json`);
  const cached = readJson(cachePath, null);
  if (cached && cached.date === today &&
      Date.now() - new Date(cached.fetchedAt).getTime() < THEATRES_TTL) return cached;
  await requireScanChrome(cfg, 'the theatre finder works');
  const res = evalInChrome(cfg, `
(async () => {
  const r = await fetch(${JSON.stringify(theatresNearPath(loc, today))}, {credentials:'include'});
  if (!r.ok) return { httpStatus: r.status };
  return { httpStatus: 200, data: await r.json() };
})()`);
  if (res.httpStatus !== 200) throw new Error(`Fandango returned ${res.httpStatus}`);
  const out = { fetchedAt: new Date().toISOString(), date: today, theatres: parseNearbyTheatres(res.data) };
  writeFileSync(cachePath, JSON.stringify(out, null, 1));
  return out;
}

const runNode = (script, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', script), ...args], { cwd: ROOT });
  child.stdout.on('data', d => append(String(d)));
  child.stderr.on('data', d => append(String(d)));
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)));
});

async function runJob(mode) {
  job.state = 'scanning'; job.log = ''; job.startedAt = new Date().toISOString();
  try {
    await launchChrome(readCfg(), { log: (m) => append(m + '\n') });
    await runNode('scan.mjs', mode === 'watch' ? ['--watch'] : []);
    job.state = 'reporting';
    await runNode('report.mjs');
    job.state = 'done';
  } catch (e) {
    append(`\n${e.message}\n`);
    job.state = 'error';
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const cfg = readCfg();
    return send(res, 200, renderLanding(cfg, landingInfo(cfg), readJson(PROFILES_PATH, []), cachedSlate(cfg)), 'text/html');
  }
  if (req.method === 'GET' && url.pathname === '/suggest') {
    try { return send(res, 200, JSON.stringify(await suggestions(readCfg()))); }
    catch (e) { return send(res, 503, JSON.stringify({ errors: [e.message] })); }
  }
  if (req.method === 'GET' && url.pathname === '/theatres') {
    const loc = parseLocationQuery(url.searchParams.get('near') || '');
    if (!loc) return send(res, 400, JSON.stringify({ errors: ['Enter a 5-digit ZIP or "City, ST".'] }));
    try {
      const data = await theatresNear(readCfg(), loc);
      const theatres = annotateForTarget(data.theatres,
        url.searchParams.get('movie') || '', url.searchParams.get('format') || '');
      return send(res, 200, JSON.stringify({ ...data, theatres }));
    } catch (e) { return send(res, 503, JSON.stringify({ errors: [e.message] })); }
  }
  if (req.method === 'GET' && url.pathname === '/report') {
    if (!existsSync(REPORT_PATH)) return send(res, 404, '<h1>No report yet</h1><p><a href="/">Run a scout first.</a></p>', 'text/html');
    return send(res, 200, readFileSync(REPORT_PATH, 'utf8'), 'text/html');
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    return send(res, 200, JSON.stringify({ state: job.state, startedAt: job.startedAt, log: logLines() }));
  }
  if (req.method === 'POST' && url.pathname === '/scout') {
    if (job.state === 'scanning' || job.state === 'reporting') {
      return send(res, 409, JSON.stringify({ errors: ['A scan is already running.'] }));
    }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(res, 400, JSON.stringify({ errors: ['Bad request body.'] })); }
      const cfg = readCfg();
      const { cfg: next, targetChanged, errors } = applyScoutRequest(cfg, parsed);
      if (errors.length) return send(res, 400, JSON.stringify({ errors }));
      const mode = parsed.mode === 'watch' && !targetChanged ? 'watch' : 'scan';
      writeFileSync(CFG_PATH, JSON.stringify(next, null, 2) + '\n');
      writeFileSync(PROFILES_PATH, JSON.stringify(
        upsertProfile(readJson(PROFILES_PATH, []), next, new Date().toISOString()), null, 1));
      runJob(mode); // fire and forget; client polls /status
      send(res, 200, JSON.stringify({ ok: true, mode, targetChanged }));
    });
    return;
  }
  send(res, 404, JSON.stringify({ errors: ['Not found'] }));
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`Seat Scout launcher -> ${url}  (Ctrl+C to stop)`);
  if (!process.argv.includes('--no-open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});
