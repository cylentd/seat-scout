// Rendered-HTML regression tests: these pin the design decisions (pills, hot
// threshold, weekend dots, legend placement, escaping) so refactors can't
// silently undo them. They assert on markers, not exact markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/report/view.mjs';
import { buildReportModel } from '../src/report/viewmodel.mjs';
import { cfg, makeScan } from './helpers.mjs';

const count = (html, needle) => html.split(needle).length - 1;
const render = (mutate) => {
  const m = buildReportModel(cfg, makeScan());
  if (mutate) mutate(m);
  return renderPage(m);
};

test('page skeleton: doctype, title, embedded data and script', () => {
  const html = render();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<title>Seat Scout — The Odyssey · IMAX 70MM<\/title>/);
  assert.match(html, /window\.__SHOWS__=/);
  assert.match(html, /No showtimes match these filters\./);
});

test('hero merges the podium: #1 carries the pill CTA, runners-up get text links', () => {
  const html = render();
  assert.equal(count(html, 'pick best'), 1);
  assert.match(html, /#1 · Top pick for 2 together/);
  assert.equal(count(html, 'class="mapjump"'), 2); // one per pick
  // The showtime itself is never a link — booking is always a named route.
  assert.ok(!/class="when" href/.test(html));
});

test('stats render as two key numbers plus a context line', () => {
  const html = render();
  assert.match(html, /<b>2<\/b><span>showtimes with 2 seats together<\/span>/);
  assert.match(html, /<b>1<\/b><span>on weekends or after 5 PM<\/span>/);
  assert.match(html, /3 of 4 showtimes still purchasable · 1 fully sold out/);
});

test('poster renders only when meta.poster is set', () => {
  // (the stylesheet always mentions .poster-wrap — assert on the element)
  assert.ok(!render().includes('<div class="poster-wrap">'));
  const withPoster = render(m => { m.meta.poster = 'data:image/jpeg;base64,QUJD'; });
  assert.equal(count(withPoster, '<div class="poster-wrap">'), 1);
  assert.match(withPoster, /alt="The Odyssey poster"/);
});

test('weekend day headers get the accent dot, weekdays do not', () => {
  const html = render();
  assert.equal(count(html, 'class="wkd"'), 1); // Sat Aug 1 only
  assert.match(html, /Sat Aug 1</);
  assert.match(html, /Mon Aug 3</);
});

test('day header meta leads with pairs and mutes the count', () => {
  const html = render();
  assert.match(html, /<span class="withpairs">1 with pairs<\/span><span class="n">· 3 showtimes<\/span>/);
});

test('tier pills: colour only for bookable pairs, plain text otherwise', () => {
  const html = render();
  assert.match(html, /class="tier center"[^>]*>Center ×2</);
  assert.match(html, /class="tier flexible"[^>]*>Flexible ×1</);
  assert.match(html, /class="tier none">Singles \/ front only</);
  assert.match(html, /class="tier none">Sold out</);
});

test('work-hours tag appears only on work-hours shows', () => {
  const html = render();
  assert.equal(count(html, 'class="worktag"'), 1); // show 4 row (picks use plain text)
});

test('daypart icons sit inside the time cell with accessible labels', () => {
  const html = render();
  assert.equal(count(html, 'class="pico"'), 4); // every row, including sold-out
  assert.match(html, /aria-label="Evening"/);
  assert.match(html, /aria-label="Afternoon"/);
});

test('composition bar: usable-seat segments and party-size hot threshold', () => {
  const html = render();
  // Hot when usable < partySize*3 = 6: show 1 (4 usable) and show 2 (1 usable)
  // are hot; show 4 (6 usable) sits exactly on the boundary and stays quiet.
  assert.equal(count(html, 'class="bar hot"'), 2);
  assert.match(html, />4 left</);
  assert.match(html, />1 left</);
  assert.match(html, />6 left</);
  // Segment classes by tier, widths as % of the house.
  assert.match(html, /class="c" style="width:/);
  assert.match(html, /class="f" style="width:/);
  // Bar tooltip explains the split.
  assert.match(html, /4 open outside the front rows \(4 center, 0 mid-back, 0 flexible\)/);
});

test('legend lives inside expanded bodies, not as a standalone section', () => {
  const html = render();
  const firstLegend = html.indexOf('class="legend"');
  const firstBody = html.indexOf('class="show-body"');
  assert.ok(firstLegend > firstBody, 'legend must come after a show body opens');
  assert.equal(count(html, 'class="legend"'), 3); // one per mapped show
});

test('filters have sliding indicators and both segments', () => {
  const html = render();
  assert.equal(count(html, '<div class="ind">'), 2);
  assert.match(html, /data-filter="quality"/);
  assert.match(html, /data-filter="part"/);
});

test('rows carry the data attributes the client filter reads', () => {
  const html = render();
  assert.match(html, /data-id="1" data-part="evening" data-pairs="2" data-rank="0" data-sold="0"/);
  assert.match(html, /data-id="3" data-part="late" data-pairs="0" data-rank="99" data-sold="1"/);
});

test('sold-out and unmapped rows are static (no bar, no chevron)', () => {
  const html = render();
  assert.equal(count(html, 'class="show static"'), 1);
  assert.equal(count(html, 'class="chev"'), 3); // only mapped rows expand
});

test('HTML-escapes untrusted strings from config and data', () => {
  const html = render(m => {
    m.meta.movie = 'R&B <Movie> "quoted"';
    m.meta.theatre = "O'Brien & Sons <hall>";
  });
  assert.match(html, /R&amp;B &lt;Movie&gt; &quot;quoted&quot;/);
  assert.match(html, /O&#39;Brien &amp; Sons &lt;hall&gt;/);
  assert.ok(!html.includes('<Movie>'));
});

test('party sizes other than 2 say "group of N", never "pair"', () => {
  const m = buildReportModel({ ...cfg, partySize: 4 }, makeScan());
  const html = renderPage(m);
  // Visible copy only: CSS/JS carry internal 'pairs' tokens, and data-pairs is
  // an attribute — neither is something a reader sees.
  const visible = html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.ok(!/(?<!data-)(?<!data-value=")\bpairs?\b/i.test(visible), 'no "pair" wording for a party of 4');
  assert.match(visible, /groups of 4/);
  assert.match(visible, /Any group/);
});

test('direct booking: both routes named by brand, no monogram', () => {
  const direct = { label: 'Regal', url: 'https://www.regmovies.com/theatres/x-0347' };
  const html = renderPage(buildReportModel({ ...cfg, directBooking: direct }, makeScan()));
  assert.ok(!html.includes('fchip'));      // the decode-me monogram is gone entirely
  assert.ok(!html.includes('Book direct'));
  assert.match(html, /Regal ↗/);
  assert.match(html, /Fandango ↗/);
  // Fandango keeps the exact-showtime deep link everywhere it appears.
  assert.match(html, /href="https:\/\/tickets\.fandango\.com[^"]*"[^>]*>Fandango ↗/);
  assert.match(html, /convenience fee/);   // fee caveat in the tooltip
  assert.match(html, /href="https:\/\/www\.regmovies\.com\/theatres\/x-0347"/);
});

test('without direct booking, Fandango is the only route', () => {
  const html = render();
  assert.match(html, /Fandango ↗/);
  assert.ok(!html.includes('Regal ↗'));
});

test('trend renders: hero line, was-N deltas, New tags, just-opened days', () => {
  const history = [
    { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 1, u: 2 }, 2: { p: 1, u: 4 }, 3: { p: 1, u: 2 } } },
    { at: '2026-07-19T12:00:00Z', kind: 'watch', shows: { 1: { p: 2, u: 4 } } },
  ];
  const html = renderPage(buildReportModel(cfg, makeScan(), history));
  assert.match(html, /class="trend">Since .*sold out of pairs/);          // hero decomposition (label is local-time)
  assert.match(html, /<b class="down">2 of 3<\/b>/);
  assert.match(html, /\+1<\/b> new showtime opened \(1 with pairs\)/);
  assert.match(html, /class="was down"[^>]*>was 4</);                     // show 2: 4 -> 1 usable
  assert.match(html, /class="was"[^>]*>was 2</);                          // show 1: 2 -> 4 usable (quiet)
  assert.equal(count(html, 'class="newtag"'), 1);                         // show 4 only
  assert.equal(count(html, 'class="opened"'), 1);                         // Mon Aug 3 just opened
});

test('no history renders no trend artifacts', () => {
  const html = render();
  assert.ok(!html.includes('class="trend"'));
  assert.ok(!html.includes('class="newtag"'));
  assert.ok(!html.includes('class="opened"'));
  assert.ok(!html.includes('class="was'));
});

test('no-picks fallback renders when nothing has pairs', () => {
  const html = render(m => { m.topPicks = []; });
  assert.match(html, /No showtime currently has 2 good seats together/);
  assert.ok(!html.includes('pick best'));
});
