// Alert delivery for drop-watch. Terminal always; Discord when a webhook URL is
// configured. Discord is a plain webhook POST — no OAuth, no bot, no gateway —
// so unlike the Fandango calls it needs no browser.
//
// Supply (run extensions) and returns (seats freed on a sold-out show) are
// rendered as separate embeds with different colors and urgency, because they
// call for different actions: one is "pick great seats at your leisure", the
// other is "buy in the next few minutes or it's gone".

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const GREEN = 0x2ecc71; // supply — new dates / extra screenings
const BLUE = 0x3498db;  // returns — seats came back on a sold-out show
const PURPLE = 0x9b59b6; // a freshly built report

const ansi = (code, s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = s => ansi('1', s);
const green = s => ansi('32', s);
const cyan = s => ansi('36', s);
const dim = s => ansi('2', s);

const pretty = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric' });

const listTimes = ts => (ts.length ? ts.join(', ') : '—');

// One target's diff -> { supplyLines, returnLines }. Shared by both sinks so the
// terminal and Discord can never drift out of sync.
export function describe(target, diff) {
  const supply = [], returns = [];
  for (const d of diff.newDates) {
    supply.push(`**${pretty(d.date)}** — ${d.count} showtime${d.count === 1 ? '' : 's'}: ${listTimes(d.times)}`);
  }
  for (const s of diff.newShows) {
    supply.push(`**${pretty(s.date)}** — added screening at ${s.time || 'unknown time'}`);
  }
  for (const f of diff.freed) {
    returns.push(`**${pretty(f.date)}** ${f.time || ''} — was sold out, seats available now`);
  }
  return { supply, returns };
}

export function toTerminal(target, diff, { supply, returns }) {
  const head = `${target.name} · ${target.movie} · ${target.format}`;
  if (!supply.length && !returns.length) {
    console.log(dim(`  ${head}: no change (run ends ${diff.runEnd || 'unknown'})`));
    return;
  }
  console.log(bold(`\n  ${head}`));
  if (supply.length) {
    console.log(green(bold('  ▲ RUN EXTENDED')) + (diff.prevRunEnd && diff.extended ? green(`  ${diff.prevRunEnd} → ${diff.runEnd}`) : ''));
    for (const l of supply) console.log('    ' + l.replace(/\*\*/g, ''));
  }
  if (returns.length) {
    console.log(cyan(bold('  ● SEATS RETURNED')) + dim('  (goes fast)'));
    for (const l of returns) console.log('    ' + l.replace(/\*\*/g, ''));
  }
  if (diff.lost.length) console.log(dim(`  ${diff.lost.length} showtime(s) sold out since last check`));
}

// Discord caps embed description at 4096 chars; we cap far lower and say how
// many were omitted rather than letting the POST fail with a 400.
function embed(title, color, lines, footer) {
  const MAX = 12;
  const shown = lines.slice(0, MAX);
  if (lines.length > MAX) shown.push(`…and ${lines.length - MAX} more`);
  return { title, color, description: shown.join('\n').slice(0, 4000), footer: footer ? { text: footer } : undefined };
}

export async function toDiscord(webhookUrl, target, diff, { supply, returns }) {
  if (!webhookUrl || (!supply.length && !returns.length)) return { sent: false };
  const where = `${target.name} · ${target.movie} · ${target.format}`;
  const embeds = [];
  if (supply.length) {
    const range = diff.extended ? `run now ends ${diff.runEnd} (was ${diff.prevRunEnd})` : `run ends ${diff.runEnd}`;
    embeds.push(embed(`▲ Run extended — ${where}`, GREEN, supply, range));
  }
  if (returns.length) {
    embeds.push(embed(`● Seats returned — ${where}`, BLUE, returns, 'Returned seats usually disappear within minutes'));
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Seat Scout', embeds }),
  });
  if (res.status === 429) {
    // Discord rate limit — retry once after the advertised wait.
    const retry = Number(res.headers.get('retry-after')) || 2;
    await new Promise(r => setTimeout(r, retry * 1000));
    const again = await fetch(webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Seat Scout', embeds }),
    });
    return { sent: again.ok, status: again.status };
  }
  return { sent: res.ok, status: res.status };
}

// Post a scan summary to Discord: the top picks, each a direct Fandango link.
//
// Attaching report.html is OFF by default. Discord renders an .html attachment
// as a syntax-highlighted source preview — a wall of `<!doctype html>` that
// dwarfs the embed and tells you nothing. The links below are what you actually
// act on; the local report.html is still the place to browse seat maps.
// The report embed itself, shared by the webhook path below and the Discord
// bot's replies so the two can never describe the same report differently.
export function reportEmbed({ title, statsLine, picks = [], footer } = {}) {
  const lines = [];
  if (statsLine) lines.push(statsLine);
  if (picks.length) {
    lines.push('');
    picks.forEach((p, i) => {
      const what = p.badges?.length ? p.badges.map(b => `${b.count} ${b.label}`).join(', ') : 'no adjacent pair';
      // Markdown links render in embed descriptions (not in titles), so each
      // pick is one tap from the actual purchase page.
      const label = `${p.dayLabel} · ${p.timeLabel}`;
      lines.push(`**${i + 1}.** ${p.bookingUrl ? `[${label}](${p.bookingUrl})` : label} — ${what}`);
    });
  }
  return {
    title,
    color: PURPLE,
    description: lines.join('\n').slice(0, 4000) || 'No showtimes found.',
    footer: { text: footer || 'Tap a showtime to book' },
  };
}

export async function postReport(webhookUrl, { title, statsLine, picks = [], footer, filePath = null } = {}) {
  if (!webhookUrl) return { sent: false, reason: 'no webhook' };
  const embed = reportEmbed({ title, statsLine, picks, footer });

  const payload = { username: 'Seat Scout', embeds: [embed] };
  if (!filePath) {
    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { sent: res.ok, status: res.status };
  }

  const bytes = statSync(filePath).size;
  // Discord's attachment ceiling has moved over the years and varies by server
  // boost tier, so don't hard-code it — refuse only the obviously hopeless and
  // let Discord reject anything borderline.
  if (bytes > 24 * 1024 * 1024) {
    return { sent: false, reason: `report is ${(bytes / 1048576).toFixed(1)} MB — too large to attach` };
  }
  const name = path.basename(filePath);
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    ...payload,
    attachments: [{ id: 0, filename: name, description: 'Interactive seat report' }],
  }));
  form.append('files[0]', new Blob([readFileSync(filePath)], { type: 'text/html' }), name);

  const res = await fetch(webhookUrl, { method: 'POST', body: form });
  return { sent: res.ok, status: res.status, bytes };
}

// Deliver to every configured sink. Never throws: a failed webhook must not
// lose the terminal output or abort the remaining targets.
export async function alert(target, diff, { webhookUrl = null } = {}) {
  const parts = describe(target, diff);
  toTerminal(target, diff, parts);
  if (!webhookUrl) return;
  try {
    const r = await toDiscord(webhookUrl, target, diff, parts);
    if (r.sent === false && r.status) console.log(`  (discord POST failed: HTTP ${r.status})`);
  } catch (e) {
    console.log(`  (discord POST failed: ${e.message})`);
  }
}
