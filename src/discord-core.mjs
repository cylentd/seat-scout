// Pure logic for the Discord bot: turning a mention's free-text prompt into a
// command, and the bot's canned texts. No network, no gateway — unit-testable.

// What a mention means. The philosophy is "any mention is a request to scout"
// so tagging the bot never dead-ends; keywords refine it:
//
//   scout (default)  quick --watch check of the configured target, reply with
//                    the best seats. "full" rescans the whole window with
//                    tiered freshness; "fresh" ignores the cache entirely.
//   post             "report"/"html"/"file" WITHOUT any scan word — just send
//                    the current report, no new scan.
//   help             "help" anywhere wins.
//
// `attach` (send report.html itself) rides along on any action when a file-ish
// word appears — "scan and send the report" scans, replies, and attaches.
const SCAN_WORDS = /\b(scan|check|scout|look|find|search|best|seats?|rescan|refresh|update|fresh|full)\b/;
const FILE_WORDS = /\b(report|html|file|attach|page)\b/;

export function parseCommand(content) {
  const text = String(content || '')
    .replace(/<@[!&]?\d+>/g, ' ')   // user/role mentions (the bot tag itself)
    .replace(/<#\d+>/g, ' ')        // channel mentions
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (/\bhelp\b/.test(text)) return { action: 'help', mode: 'watch', attach: false };

  const attach = FILE_WORDS.test(text);
  if (attach && !SCAN_WORDS.test(text)) return { action: 'post', mode: 'watch', attach: true };

  const mode = /\bfresh\b/.test(text) ? 'fresh' : /\bfull\b/.test(text) ? 'full' : 'watch';
  return { action: 'scout', mode, attach };
}

export function helpText({ movie, format, theatre }) {
  return [
    `I scout **${movie} · ${format}** at **${theatre}** (change the target from the Seat Scout landing page).`,
    '',
    'Tag me with:',
    '· *(anything)* — quick check of the known good showtimes, best seats back here',
    '· **full** — rescan the whole window (a minute or two)',
    '· **fresh** — rescan ignoring every cache (slowest, most thorough)',
    '· **report** — resend the latest report without scanning',
    '· add **html** / **attach** to any of those to get report.html as a file',
  ].join('\n');
}

// A scan is already running: the new request joins it as a follower and gets
// the same results when it lands — no second scan, no silent drop. If the
// follower asked for a deeper mode than what's running, say so honestly
// instead of implying their fresh/full request is what's in flight.
const MODE_RANK = { watch: 0, full: 1, fresh: 2 };
export function queuedText(elapsedMs, runningMode, wantedMode) {
  const secs = Math.round(elapsedMs / 1000);
  const ago = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
  const base = `⏳ Already scouting (started ${ago}) — I'll post the results here for you too.`;
  if (MODE_RANK[wantedMode] > MODE_RANK[runningMode]) {
    const running = runningMode === 'watch' ? 'a quick check' : 'a full scan';
    return `${base} Note: ${running} is what's running — tag me **${wantedMode}** again after it lands if you still want the deeper rescan.`;
  }
  return base;
}

export function progressText(mode, { movie, format, theatre }) {
  const what = mode === 'watch' ? 'Quick-checking' : mode === 'fresh' ? 'Re-scanning from scratch' : 'Scanning';
  const eta = mode === 'watch' ? '~30 s' : '~1–2 min';
  return `⏳ ${what} **${movie} · ${format}** at ${theatre} — ${eta}.`;
}

// Last few log lines for a failure reply, fenced so Discord renders them
// legibly. Kept tiny: the full log lives in the bot's terminal.
export function failureText(log, max = 6) {
  const tail = String(log || '').split(/\r?\n/).filter(Boolean).slice(-max).join('\n');
  return `❌ The scout failed.${tail ? '\n```\n' + tail.slice(0, 1500) + '\n```' : ''}`;
}
