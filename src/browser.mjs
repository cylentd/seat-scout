// Runs JavaScript inside the user's real Chrome (launched with --remote-debugging-port)
// via the agent-browser CLI. All Regal API calls happen in-page on regmovies.com so
// they carry real-browser credentials and pass Cloudflare.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function evalInChrome(cfg, script) {
  const args = ['--session', cfg.browserSession, '--cdp', String(cfg.cdpPort), 'eval', '--stdin'];
  const r = spawnSync('agent-browser', args, {
    input: script,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`agent-browser eval failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  const out = r.stdout.trim();
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`Could not parse eval output as JSON: ${out.slice(0, 300)}`);
  }
}

// Cloudflare sometimes interposes a Turnstile challenge mid-scan; the page then hangs
// all evals. Find the "Verify you are human" checkbox in the snapshot and click it.
export function tryClearChallenge(cfg) {
  const snap = runCli(cfg, ['snapshot', '-i', '-c']);
  const text = snap.stdout + snap.stderr;
  const m = text.match(/checkbox "Verify you are human" \[[^\]]*ref=(e\d+)/);
  if (!m) return false;
  runCli(cfg, ['click', '@' + m[1]]);
  runCli(cfg, ['wait', '4000']);
  return true;
}

export function reloadPage(cfg) {
  runCli(cfg, ['reload']);
  runCli(cfg, ['wait', '4000']);
}

function runCli(cfg, cliArgs) {
  const args = ['--session', cfg.browserSession, '--cdp', String(cfg.cdpPort), ...cliArgs];
  const r = spawnSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, shell: true });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Launch a debug-port Chrome if none is listening — the scanner's prerequisite.
// Shared by the launcher server and the Discord bot (which runs unattended and
// must be able to bring its own browser up). `log` is injected for progress.
export async function launchChrome(cfg, { log = () => {} } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`);
    if (r.ok) return;
  } catch { /* not listening — launch below */ }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find(existsSync);
  if (!exe) throw new Error('Chrome not found — install Google Chrome or start one with --remote-debugging-port=' + cfg.cdpPort);
  log('Launching Chrome with remote debugging…');
  spawn(exe, [
    `--remote-debugging-port=${cfg.cdpPort}`,
    `--user-data-dir=${path.join(process.env.LOCALAPPDATA || process.cwd(), 'seat-scout', 'chrome-profile')}`,
    'https://www.fandango.com',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { if ((await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`)).ok) return; } catch { /* keep waiting */ }
  }
  throw new Error('Chrome did not come up on the debug port.');
}

// Screenshot a page in a throwaway tab — used to give Discord a visual of
// report.html (whose raw-source attachment preview is useless). Best-effort:
// returns true only when the screenshot file was actually written, and always
// closes its tab so the scanner's Fandango tab stays the active one.
export function capturePage(cfg, url, outPath) {
  const opened = runCli(cfg, ['tab', 'new', url]);
  if (opened.status !== 0) return false;
  try {
    runCli(cfg, ['wait', '2500']);
    const shot = runCli(cfg, ['screenshot', outPath]);
    return shot.status === 0 && existsSync(outPath);
  } finally {
    runCli(cfg, ['tab', 'close']);
  }
}

export async function ensureChromeReady(cfg) {
  // 1. Is Chrome listening on the CDP port at all?
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    throw new Error(
      `No Chrome found on CDP port ${cfg.cdpPort}.\n` +
      `Launch one with (PowerShell):\n` +
      `  Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ` +
      `-ArgumentList '--remote-debugging-port=${cfg.cdpPort}','--user-data-dir=C:\\Users\\David\\AppData\\Local\\Temp\\claude\\chrome-scan-profile' ` +
      `,'https://www.fandango.com'`
    );
  }

  // 2. Make sure the active tab is on fandango.com so in-page fetches are same-origin.
  const urlRes = runCli(cfg, ['get', 'url']);
  if (!urlRes.stdout.includes('fandango.com')) {
    // Any fandango.com page makes in-page fetches same-origin; prefer the
    // configured theatre's own page, and fall back to the homepage when no slug
    // is set (drop-watch spans several theatres and has no single "the" slug).
    const slug = cfg.fandango?.theaterSlug;
    runCli(cfg, ['open', slug
      ? `https://www.fandango.com/${slug}/theater-page`
      : 'https://www.fandango.com']);
    runCli(cfg, ['wait', '5000']);
  }
}
