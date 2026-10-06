import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, helpText, progressText, queuedText, failureText } from '../src/discord-core.mjs';
import { reportEmbed } from '../src/notify.mjs';

test('a bare mention defaults to a quick scout', () => {
  assert.deepEqual(parseCommand('<@123456789>'), { action: 'scout', mode: 'watch', attach: false });
  assert.deepEqual(parseCommand('<@!123> best seat for me'), { action: 'scout', mode: 'watch', attach: false });
  assert.deepEqual(parseCommand(''), { action: 'scout', mode: 'watch', attach: false });
});

test('full and fresh escalate the scan mode', () => {
  assert.equal(parseCommand('<@1> full scan please').mode, 'full');
  assert.equal(parseCommand('<@1> fresh check').mode, 'fresh');
  assert.equal(parseCommand('<@1> check seats').mode, 'watch');
});

test('report without a scan word just posts, with the file', () => {
  assert.deepEqual(parseCommand('<@1> report'), { action: 'post', mode: 'watch', attach: true });
  assert.deepEqual(parseCommand('<@1> send me the html'), { action: 'post', mode: 'watch', attach: true });
});

test('scan + file words scout AND attach', () => {
  const c = parseCommand('<@1> full scan and send the report');
  assert.equal(c.action, 'scout');
  assert.equal(c.mode, 'full');
  assert.equal(c.attach, true);
});

test('help wins over everything', () => {
  assert.equal(parseCommand('<@1> help me scan a report').action, 'help');
});

test('canned texts carry the target', () => {
  const target = { movie: 'The Odyssey', format: 'IMAX 70MM', theatre: 'Regal Hacienda Crossings' };
  assert.match(helpText(target), /The Odyssey · IMAX 70MM/);
  assert.match(progressText('watch', target), /Quick-checking/);
  assert.match(progressText('full', target), /Scanning \*\*The Odyssey/);
});

test('queuedText joins the running scan and shows elapsed time', () => {
  assert.match(queuedText(30_000, 'watch', 'watch'), /started 30s ago/);
  assert.match(queuedText(150_000, 'full', 'watch'), /started 3 min ago/);
  assert.match(queuedText(5_000, 'full', 'full'), /results here for you too/);
});

test('queuedText flags when the follower wanted a deeper mode', () => {
  assert.match(queuedText(5_000, 'watch', 'full'), /quick check is what's running/);
  assert.match(queuedText(5_000, 'full', 'fresh'), /full scan is what's running/);
  // Same or shallower mode: no caveat.
  assert.ok(!queuedText(5_000, 'fresh', 'watch').includes('Note:'));
  assert.ok(!queuedText(5_000, 'full', 'full').includes('Note:'));
});

test('failureText fences the log tail and stays bounded', () => {
  const t = failureText('a\nb\nc\nd\ne\nf\ng\nh');
  assert.match(t, /```/);
  assert.ok(!t.includes('a\n'));          // only the tail survives
  assert.ok(t.includes('h'));
  assert.equal(failureText(''), '❌ The scout failed.');
});

test('reportEmbed renders picks as booking links and survives none', () => {
  const e = reportEmbed({
    title: 'T', statsLine: '**3/9** ok',
    picks: [{ dayLabel: 'Sat Aug 1', timeLabel: '7:00p', bookingUrl: 'https://x', badges: [{ count: 2, label: 'center pairs' }] }],
    footer: 'f',
  });
  assert.match(e.description, /\[Sat Aug 1 · 7:00p\]\(https:\/\/x\)/);
  assert.match(e.description, /2 center pairs/);
  assert.equal(reportEmbed({}).description, 'No showtimes found.');
});

// ---- mutation-driven additions ----------------------------------------------
// Oracle: README "Discord bot" prompt table (any mention scouts; full/fresh deepen
// it; report/html alone only re-posts; help wins). Message texts are pinned from code.
const target = { movie: 'Dune', format: 'IMAX', theatre: 'Regal X' };
const QUEUED = "⏳ Already scouting (started 30s ago) — I'll post the results here for you too.";

test('help replies with the exact cheat sheet for the configured target', () => {
  assert.equal(helpText(target), [
    'I scout **Dune · IMAX** at **Regal X** (change the target from the Seat Scout landing page).',
    '',
    'Tag me with:',
    '· *(anything)* — quick check of the known good showtimes, best seats back here',
    '· **full** — rescan the whole window (a minute or two)',
    '· **fresh** — rescan ignoring every cache (slowest, most thorough)',
    '· **report** — resend the latest report without scanning',
    '· add **html** / **attach** to any of those to get report.html as a file',
  ].join('\n'));
});

test('help is a help action with no scan mode and no attachment', () => {
  assert.deepEqual(parseCommand('<@1> help'), { action: 'help', mode: 'watch', attach: false });
  assert.deepEqual(parseCommand('<@1> HELP me with the full report'), { action: 'help', mode: 'watch', attach: false });
});

test('every scan word keeps a report request a scout, and attaches the file', () => {
  for (const w of ['scan', 'check', 'scout', 'look', 'find', 'search', 'best', 'seat', 'seats', 'rescan', 'refresh', 'update', 'fresh', 'full']) {
    const c = parseCommand(`<@1> report ${w}`);
    assert.equal(c.action, 'scout', w);
    assert.equal(c.attach, true, w);
  }
});

test('every file word alone just posts the current report', () => {
  for (const w of ['report', 'html', 'file', 'attach', 'page']) {
    assert.deepEqual(parseCommand(`<@1> ${w}`), { action: 'post', mode: 'watch', attach: true }, w);
  }
});

test('keywords match whole words only', () => {
  assert.deepEqual(parseCommand('<@1> reporting'), { action: 'scout', mode: 'watch', attach: false });
  assert.equal(parseCommand('<@1> helpful').action, 'scout');
  assert.equal(parseCommand('<@1> fullest').mode, 'watch');
  assert.equal(parseCommand('<@1> freshly').mode, 'watch');
  assert.equal(parseCommand('<@1> report scanner').action, 'post'); // "scanner" is not "scan"
});

test('a plain scan word scouts without attaching anything', () => {
  assert.deepEqual(parseCommand('<@1> look at seats'), { action: 'scout', mode: 'watch', attach: false });
});

test('mode: fresh beats full, either way round', () => {
  assert.equal(parseCommand('<@1> fresh full').mode, 'fresh');
  assert.equal(parseCommand('<@1> full fresh').mode, 'fresh');
  assert.equal(parseCommand('<@1> full').mode, 'full');
  assert.equal(parseCommand('<@1> full report').mode, 'full');
});

test('parsing ignores case, mentions, channel tags and spacing', () => {
  assert.equal(parseCommand('<@!1> FULL SCAN').mode, 'full');
  assert.deepEqual(parseCommand('<#123456789> <@&99> REPORT'), { action: 'post', mode: 'watch', attach: true });
  assert.equal(parseCommand('<@1>\n\n  check \t\n full  ').mode, 'full');
  assert.equal(parseCommand('check<@1>full').mode, 'full');       // a mention separates words
  assert.equal(parseCommand('check<#42>fresh').mode, 'fresh');
  assert.deepEqual(parseCommand(null), { action: 'scout', mode: 'watch', attach: false });
  assert.deepEqual(parseCommand(undefined), { action: 'scout', mode: 'watch', attach: false });
});

test('queued reply: exact text for a same-depth request', () => {
  assert.equal(queuedText(30_000, 'watch', 'watch'), QUEUED);
  assert.equal(queuedText(30_000, 'fresh', 'fresh'), QUEUED);
  assert.equal(queuedText(30_000, 'full', 'watch'), QUEUED);   // shallower request: no caveat
  assert.equal(queuedText(30_000, 'fresh', 'full'), QUEUED);
});

test('queued reply rounds elapsed time to the second, then to the minute from 60 s', () => {
  assert.match(queuedText(0, 'watch', 'watch'), /started 0s ago/);
  assert.match(queuedText(59_499, 'watch', 'watch'), /started 59s ago/);
  assert.match(queuedText(59_500, 'watch', 'watch'), /started 1 min ago/);   // rounds to 60 s
  assert.match(queuedText(60_000, 'watch', 'watch'), /started 1 min ago/);
  assert.match(queuedText(89_000, 'watch', 'watch'), /started 1 min ago/);   // 1.48 min
  assert.match(queuedText(90_000, 'watch', 'watch'), /started 2 min ago/);   // 1.5 min rounds up
});

test('queued reply names what is running when the follower wanted more', () => {
  const note = (running, mode) => ` Note: ${running} is what's running — tag me **${mode}** again after it lands if you still want the deeper rescan.`;
  assert.equal(queuedText(30_000, 'watch', 'full'), QUEUED + note('a quick check', 'full'));
  assert.equal(queuedText(30_000, 'watch', 'fresh'), QUEUED + note('a quick check', 'fresh'));
  assert.equal(queuedText(30_000, 'full', 'fresh'), QUEUED + note('a full scan', 'fresh'));
});

test('progress text per mode: label and expected wait', () => {
  assert.equal(progressText('watch', target), '⏳ Quick-checking **Dune · IMAX** at Regal X — ~30 s.');
  assert.equal(progressText('full', target), '⏳ Scanning **Dune · IMAX** at Regal X — ~1–2 min.');
  assert.equal(progressText('fresh', target), '⏳ Re-scanning from scratch **Dune · IMAX** at Regal X — ~1–2 min.');
});

test('failure text: the last 6 log lines in a fence', () => {
  const log = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
  assert.equal(failureText(log), '❌ The scout failed.\n```\nl2\nl3\nl4\nl5\nl6\nl7\n```');
  assert.equal(failureText('l1\nl2\nl3\nl4\nl5\nl6'), '❌ The scout failed.\n```\nl1\nl2\nl3\nl4\nl5\nl6\n```'); // exactly 6: all kept
});

test('failure text: a custom line count, blank lines and CRLF handled', () => {
  assert.equal(failureText('a\nb\nc\nd', 2), '❌ The scout failed.\n```\nc\nd\n```');
  assert.equal(failureText('a\r\n\r\nb\r\n'), '❌ The scout failed.\n```\na\nb\n```');
});

test('failure text: the fenced tail is cut at 1500 characters', () => {
  assert.equal(failureText('x'.repeat(2000)), '❌ The scout failed.\n```\n' + 'x'.repeat(1500) + '\n```');
});

test('failure text with nothing to show has no fence', () => {
  for (const log of ['', '\n\n', null, undefined]) assert.equal(failureText(log), '❌ The scout failed.', String(log));
});
