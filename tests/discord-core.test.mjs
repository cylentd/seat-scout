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
