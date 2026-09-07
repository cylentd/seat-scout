// Discord bot: tag @Seat Scout with a prompt (or DM it) and it scouts seats
// and replies with the best picks — the report as a rich embed, a screenshot
// of report.html as the embed image, and the report.html file itself on
// request. Runs on the same machine as the scanner so it can drive the real
// Chrome directly. Usage: node src/discord-bot.mjs
//
// Zero dependencies: the gateway is Node's built-in WebSocket (Node 22+), REST
// is fetch. Only the GUILDS / GUILD_MESSAGES / DIRECT_MESSAGES intents are
// used — message content is only visible to bots for DMs and messages that
// @mention them, which is exactly the surface this bot listens on, so no
// privileged intent needs enabling in the developer portal.
//
// Token: SEAT_SCOUT_DISCORD_TOKEN env var, or "discordBotToken" in
// watchlist.json (env wins, same convention as the drop-watch webhook).
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseCommand, helpText, queuedText, progressText, failureText } from './discord-core.mjs';
import { loadReportModel, reportSummary } from './report-load.mjs';
import { reportEmbed } from './notify.mjs';
import { launchChrome, capturePage } from './browser.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API = 'https://discord.com/api/v10';
const REPORT_PATH = path.join(ROOT, 'report.html');
const SHOT_PATH = path.join(ROOT, 'data', 'report-shot.png');
// View Channels + Send Messages + Attach Files + Read Message History.
const INVITE_PERMS = 1024 + 2048 + 32768 + 65536;

const readJson = (p, fallback) => {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }
  catch { return fallback; }
};
const readCfg = () => JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TOKEN = process.env.SEAT_SCOUT_DISCORD_TOKEN ||
  readJson(path.join(ROOT, 'watchlist.json'), {}).discordBotToken || '';
if (!TOKEN) {
  console.error('No bot token. Set SEAT_SCOUT_DISCORD_TOKEN or "discordBotToken" in watchlist.json.');
  console.error('Create one at https://discord.com/developers/applications → your app → Bot → Reset Token.');
  process.exit(1);
}

// ---- REST ------------------------------------------------------------------

async function api(method, route, body = null) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API + route, {
      method,
      headers: { authorization: `Bot ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(((j.retry_after ?? 2) + 0.25) * 1000);
      continue;
    }
    return res;
  }
  throw new Error(`Discord kept rate-limiting ${method} ${route}`);
}

// files: [{ name, data, type }] — multipart when present, plain JSON otherwise.
async function sendMessage(channelId, payload, files = []) {
  const route = `/channels/${channelId}/messages`;
  if (payload.message_reference) payload.message_reference.fail_if_not_exists = false;
  if (!files.length) return api('POST', route, payload);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    ...payload,
    attachments: files.map((f, i) => ({ id: i, filename: f.name })),
  }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API + route, { method: 'POST', headers: { authorization: `Bot ${TOKEN}` }, body: form });
    if (res.status !== 429) return res;
    const j = await res.json().catch(() => ({}));
    await sleep(((j.retry_after ?? 2) + 0.25) * 1000);
  }
  throw new Error('Discord kept rate-limiting the upload');
}

const reply = (msg, payload, files = []) =>
  sendMessage(msg.channel_id, { ...payload, message_reference: { message_id: msg.id } }, files);

// ---- The work --------------------------------------------------------------

const runNode = (script, args, onLog) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', script), ...args], { cwd: ROOT });
  child.stdout.on('data', d => { process.stdout.write(d); onLog(String(d)); });
  child.stderr.on('data', d => { process.stderr.write(d); onLog(String(d)); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)));
});

const targetOf = (cfg) => ({
  movie: cfg.fandango.movieTitle || cfg.fandango.movieTitleMatch,
  format: cfg.fandango.formatFilter,
  theatre: cfg.theatreName,
});

// The report, dressed for Discord: picks embed + report.html screenshot as the
// embed image (best-effort — needs the scan Chrome), + the file when asked.
function reportPayload(attach) {
  const { cfg, scan, model } = loadReportModel(ROOT);
  const embed = reportEmbed(reportSummary(cfg, scan, model));
  const files = [];
  try {
    if (existsSync(REPORT_PATH) && capturePage(cfg, pathToFileURL(REPORT_PATH).href, SHOT_PATH)) {
      files.push({ name: 'report.png', data: readFileSync(SHOT_PATH), type: 'image/png' });
      embed.image = { url: 'attachment://report.png' };
    }
  } catch { /* no screenshot — embed alone still tells the story */ }
  if (attach && existsSync(REPORT_PATH)) {
    files.push({ name: 'report.html', data: readFileSync(REPORT_PATH), type: 'text/html' });
  }
  return { payload: { embeds: [embed] }, files };
}

// One scout at a time, same as the launcher — but concurrent requests aren't
// bounced: they join the in-flight run as followers and everyone gets the
// finished report. One scan serves the whole channel; nobody re-triggers a
// duplicate crawl by tagging the bot while it's busy.
let job = null;   // { startedAt, mode, followers: [{ msg, cmd }] }

async function scout(msg, cmd, cfg, target) {
  job = { startedAt: Date.now(), mode: cmd.mode, followers: [] };
  let logText = '';
  const onLog = (s) => { logText = (logText + s).slice(-20000); };
  const typing = setInterval(() => api('POST', `/channels/${msg.channel_id}/typing`).catch(() => {}), 8000);
  // Everyone waiting on this run, including whoever kicked it off.
  const audience = () => [{ msg, cmd }, ...job.followers];
  try {
    await reply(msg, { content: progressText(cmd.mode, target) });
    await launchChrome(cfg, { log: (l) => onLog(l + '\n') });
    const args = cmd.mode === 'watch' ? ['--watch'] : cmd.mode === 'fresh' ? ['--fresh'] : [];
    await runNode('scan.mjs', args, onLog);
    await runNode('report.mjs', [], onLog);
    const attach = audience().some(a => a.cmd.attach);
    const { payload, files } = reportPayload(attach);
    for (const a of audience()) await reply(a.msg, payload, files).catch(() => {});
  } catch (e) {
    onLog(e.message + '\n');
    for (const a of audience()) await reply(a.msg, { content: failureText(logText) }).catch(() => {});
  } finally {
    clearInterval(typing);
    job = null;
  }
}

async function handleMessage(msg) {
  if (msg.author?.bot) return;
  const isDM = !msg.guild_id;
  const mentioned = (msg.mentions || []).some(u => u.id === botUserId);
  if (!isDM && !mentioned) return;

  const cmd = parseCommand(msg.content);
  const cfg = readCfg();
  const target = targetOf(cfg);

  if (cmd.action === 'help') { await reply(msg, { content: helpText(target) }); return; }
  if (job) {
    // Join the in-flight run instead of bouncing. A "post" while scanning also
    // waits — screenshotting the report would race the scanner's Chrome tab,
    // and the about-to-land report is fresher than the one on disk anyway.
    job.followers.push({ msg, cmd: cmd.action === 'post' ? { ...cmd, attach: true } : cmd });
    await reply(msg, { content: queuedText(Date.now() - job.startedAt, job.mode, cmd.mode) });
    return;
  }
  if (cmd.action === 'post') {
    if (!existsSync(REPORT_PATH)) {
      await reply(msg, { content: 'No report yet — tag me with **scan** and I\'ll make one.' });
      return;
    }
    const { payload, files } = reportPayload(true);
    await reply(msg, payload, files);
    return;
  }
  await scout(msg, cmd, cfg, target);
}

// ---- Gateway ---------------------------------------------------------------
// HELLO → IDENTIFY (or RESUME) → heartbeat forever; reconnect with backoff and
// resume the session when Discord allows it. Fatal close codes (bad token,
// bad intents) exit loudly instead of retrying into a ban.

const INTENTS = 1 | 512 | 4096;   // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES
const FATAL_CLOSES = { 4004: 'authentication failed — check the bot token', 4010: 'invalid shard', 4011: 'sharding required', 4012: 'invalid API version', 4013: 'invalid intents', 4014: 'disallowed intents' };

let ws = null, botUserId = null, seq = null, sessionId = null, resumeUrl = null;
let hbTimer = null, hbAcked = true, reconnectAttempts = 0;

async function gatewayUrl() {
  const res = await api('GET', '/gateway/bot');
  if (!res.ok) throw new Error(`GET /gateway/bot → HTTP ${res.status} — is the bot token valid?`);
  return (await res.json()).url;
}

function startHeartbeat(intervalMs) {
  clearInterval(hbTimer);
  hbAcked = true;
  const beat = () => {
    if (!hbAcked) { try { ws.close(4000); } catch { /* already closing */ } return; }
    hbAcked = false;
    ws.send(JSON.stringify({ op: 1, d: seq }));
  };
  setTimeout(beat, intervalMs * Math.random());
  hbTimer = setInterval(beat, intervalMs);
}

function onPacket(p) {
  if (p.s != null) seq = p.s;
  if (p.op === 10) {                      // HELLO
    startHeartbeat(p.d.heartbeat_interval);
    if (sessionId) {
      ws.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: sessionId, seq } }));
    } else {
      ws.send(JSON.stringify({
        op: 2,
        d: { token: TOKEN, intents: INTENTS, properties: { os: 'windows', browser: 'seat-scout', device: 'seat-scout' } },
      }));
    }
  } else if (p.op === 11) { hbAcked = true; }
  else if (p.op === 1) { ws.send(JSON.stringify({ op: 1, d: seq })); }
  else if (p.op === 7) { try { ws.close(4000); } catch { /* reconnect follows */ } }
  else if (p.op === 9) {                  // invalid session; d = resumable
    if (!p.d) { sessionId = null; seq = null; }
    setTimeout(() => { try { ws.close(4000); } catch { /* reconnect follows */ } }, 1500);
  } else if (p.op === 0) {
    if (p.t === 'READY') {
      botUserId = p.d.user.id;
      sessionId = p.d.session_id;
      resumeUrl = p.d.resume_gateway_url;
      reconnectAttempts = 0;
      const app = p.d.application?.id;
      console.log(`Logged in as ${p.d.user.username} — tag me in a channel or DM me.`);
      if (app) console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${app}&scope=bot&permissions=${INVITE_PERMS}`);
    } else if (p.t === 'RESUMED') {
      reconnectAttempts = 0;
      console.log('Session resumed.');
    } else if (p.t === 'MESSAGE_CREATE') {
      handleMessage(p.d).catch(e => console.error('message handling failed:', e.message));
    }
  }
}

async function connect() {
  const base = sessionId && resumeUrl ? resumeUrl : await gatewayUrl();
  ws = new WebSocket(`${base}${base.includes('?') ? '&' : '?'}v=10&encoding=json`);
  ws.addEventListener('message', (ev) => {
    let p; try { p = JSON.parse(ev.data); } catch { return; }
    try { onPacket(p); } catch (e) { console.error('gateway packet error:', e.message); }
  });
  ws.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    if (FATAL_CLOSES[ev.code]) {
      console.error(`Gateway closed (${ev.code}): ${FATAL_CLOSES[ev.code]}`);
      process.exit(1);
    }
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts++);
    console.log(`Gateway closed (${ev.code || 'network'}) — reconnecting in ${Math.round(delay / 1000)}s…`);
    setTimeout(() => connect().catch(scheduleRetry), delay);
  });
  ws.addEventListener('error', () => { /* the close event carries the retry */ });
}

function scheduleRetry(e) {
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts++);
  console.error(`${e.message} — retrying in ${Math.round(delay / 1000)}s…`);
  setTimeout(() => connect().catch(scheduleRetry), delay);
}

console.log('Seat Scout Discord bot starting…');
connect().catch(scheduleRetry);
