// Rendered-HTML regression tests: these pin the design decisions (pills, hot
// threshold, weekend dots, legend placement, escaping) so refactors can't
// silently undo them. They assert on markers, not exact markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/report/view.mjs';
import { buildReportModel } from '../src/report/viewmodel.mjs';
import { cfg, makeScan, makeShow, auditorium } from './helpers.mjs';

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

// --- picks, pills and trend wording ---------------------------------------
const inner = (html, open, close) => {
  const start = html.indexOf(open);
  assert.ok(start >= 0, `missing ${open}`);
  const end = html.indexOf(close, start + open.length);
  return html.slice(start, end < 0 ? undefined : end);
};
const text = (s) => s.replace(/<[^>]*>/g, '');
const heroOf = (html) => inner(html, '<header class="hero">', '</header>');
const oneDay = (shows) => ({
  scannedAt: '2026-07-19T12:00:00.000Z',
  results: [{ date: '2026-08-01', shows, errors: [] }],
});
const renderScan = (scan, c = cfg, history = null) => renderPage(buildReportModel(c, scan, history));

test('the #1 pick is the best show; #2 is a smaller text-link card', () => {
  const html = render();
  const best = inner(html, '<div class="pick best">', '<div class="pick">');
  assert.match(best, /<div class="when">Sat Aug 1 · 7:05 PM<\/div>/);
  assert.match(best, /<div class="detail">2 center pairs · evening<\/div>/);
  assert.match(best, /class="btn"/);
  assert.ok(!best.includes('tlink'));
  const second = inner(html, '<div class="pick">', 'class="stats"');
  assert.match(second, /<div class="rank">#2<\/div>/);
  assert.match(second, /<div class="when">Mon Aug 3 · 1:00 PM<\/div>/);
  assert.match(second, /<div class="detail">1 flexible pair · work hrs<\/div>/);
  assert.match(second, /class="tlink"/);
  assert.ok(!second.includes('class="btn"'));
});

test('the #1 pick also says "work hrs" when it starts in work hours', () => {
  // Monday 1 PM is the only show with a pair, so it is #1.
  const scan = oneDay([makeShow({ id: 1, ticketingDate: '2026-08-03+13:00', seats: auditorium({ E: [8, 9] }) })]);
  const best = inner(renderScan(scan), '<div class="pick best">', 'class="stats"');
  assert.match(best, /<div class="detail">1 center pair · afternoon · work hrs<\/div>/);
});

test('a pick with two tiers lists each tier count, comma-separated', () => {
  const scan = oneDay([makeShow({
    id: 1, ticketingDate: '2026-08-01+19:00', seats: auditorium({ E: [8, 9], H: [8, 9] }),
  })]);
  assert.match(renderScan(scan), /<div class="detail">1 center, 1 mid-back pairs · evening<\/div>/);
});

test('tier pill tooltip says "1 pair" for one and "N separate pairs" for more', () => {
  const html = render();
  assert.match(html, /title="2 separate pairs of 2 adjacent seats in the Center zone \(non-overlapping\)"/);
  assert.match(html, /title="1 pair of 2 adjacent seats in the Flexible zone \(non-overlapping\)"/);
});

test('a show with no seat map and not sold out says "No seat data"', () => {
  const scan = oneDay([makeShow({ id: 1, ticketingDate: '2026-08-01+15:00', type: 'unavailable' })]);
  const html = renderScan(scan);
  assert.equal(count(html, '<span class="tier none">No seat data</span>'), 1);
  assert.equal(count(html, 'class="show static"'), 1);
});

test('a mapped show with no open seat at all says "Sold out", not "Singles"', () => {
  const html = renderScan(oneDay([makeShow({ id: 1, ticketingDate: '2026-08-01+15:00', seats: auditorium() })]));
  assert.equal(count(html, '<span class="tier none">Sold out</span>'), 1);
  assert.ok(!html.includes('Singles / front only'));
});

test('composition bar: each tier gets its own class and a width as % of the house', () => {
  const html = render();
  // 189 seats: show 1 has 4 centre (2.1%), show 2 one mid-back (0.5%),
  // show 4 two mid-back (1.1%) and four flexible (2.1%).
  assert.equal(count(html, 'class="c" style="width:2.1%"'), 1);
  assert.equal(count(html, 'class="m" style="width:0.5%"'), 1);
  assert.equal(count(html, 'class="m" style="width:1.1%"'), 1);
  assert.equal(count(html, 'class="f" style="width:2.1%"'), 1);
});

test('expanded footer counts usable, front, accessible, taken and percent full', () => {
  const html = render();
  assert.match(html, /<span>4 usable · 0 front · 0 accessible · 185 taken · 98% full<\/span>/);
  assert.match(html, /<span>6 usable · 0 front · 0 accessible · 183 taken · 97% full<\/span>/);
  assert.match(html, /4 center, 0 mid-back, 0 flexible\) · 0 front · 0 accessible · 98% of all seats sold/);
});

test('day header: singular showtime, and a day with no pairs says so', () => {
  const scan = oneDay([
    makeShow({ id: 1, ticketingDate: '2026-08-01+15:00', type: 'unavailable' }),
    makeShow({ id: 2, ticketingDate: '2026-08-02+15:00', seats: auditorium({ E: [8, 9] }) }),
  ]);
  const html = renderScan(scan);
  assert.match(html, /<span class="n solo">1 showtime · no pairs<\/span>/);
  assert.match(html, /<span class="withpairs">1 with pairs<\/span><span class="n">· 1 showtime<\/span>/);
});

test('Saturday and Sunday headers get the weekend dot, Wednesday does not', () => {
  const scan = {
    scannedAt: '2026-07-19T12:00:00.000Z',
    results: [{ date: '2026-08-01', errors: [], shows: [
      makeShow({ id: 1, ticketingDate: '2026-08-01+15:00', type: 'soldout' }),   // Sat
      makeShow({ id: 2, ticketingDate: '2026-08-02+15:00', type: 'soldout' }),   // Sun
      makeShow({ id: 3, ticketingDate: '2026-08-05+15:00', type: 'soldout' }),   // Wed
    ] }],
  };
  const html = renderScan(scan);
  assert.equal(count(html, 'class="wkd"'), 2);
  assert.match(html, /Sun Aug 2</);
  assert.match(html, /Wed Aug 5</);
});

test('hero and footer name the party size and the run rule', () => {
  const html = render();
  assert.match(html, /Test Theatre — showtimes with 2 adjacent seats outside the front rows/);
  assert.match(html, /a run of 4 open seats counts as 2/);
  const three = renderScan(makeScan(), { ...cfg, partySize: 3 });
  assert.match(three, /a run of 6 open seats counts as 2/);
});

test('footer: scan source, and the direct-booking fee note only when set', () => {
  const html = render();
  assert.match(html, /Scanned [^<]* via fandango · one polite, human-paced session\./);
  assert.ok(!html.includes('Booking direct skips'));
  const direct = renderScan(makeScan(), { ...cfg, directBooking: { label: 'Regal', url: 'https://r.example/x' } });
  assert.match(direct, /Booking direct skips Fandango’s per-ticket convenience fee/);
});

test('filter buttons: the first option of each filter starts pressed', () => {
  // (the client script also mentions aria-pressed, so look at the markup only)
  const html = inner(render(), '<div class="filters">', 'id="count-note"');
  assert.equal(count(html, 'aria-pressed="true"'), 2);
  assert.equal(count(html, 'aria-pressed="false"'), 7); // 3 + 4 others
  assert.match(html, /<button data-value="pairs" aria-pressed="true">Any pair<\/button>/);
  assert.match(html, /<button data-value="late" aria-pressed="false">Late<\/button>/);
});

const trendOf = (summary, label = 'Fri 5 PM') => (m) => {
  m.trend = { baselineAt: '2026-07-17T17:00:00Z', baselineLabel: label, summary };
};
const zero = { hadPairs: 0, lostPairs: 0, retained: 0, passed: 0, newShows: 0, newWithPairs: 0 };

test('trend line: the README example reads as one decomposed sentence', () => {
  // README "Sell-rate trend": 7 of 15 sold out of pairs, 8 remain, +21 new showtimes.
  const html = render(trendOf({ ...zero, hadPairs: 15, lostPairs: 7, retained: 8, newShows: 21 }));
  const line = inner(html, '<div class="trend">', '</div>');
  assert.equal(text(line),
    'Since Fri 5 PM: 7 of 15 showtimes sold out of pairs · 8 remain · +21 new showtimes opened');
  assert.match(line, /<b class="down">7 of 15<\/b>/);
  assert.match(line, /<b>8<\/b> remain/);
  assert.match(line, /<b class="fresh">\+21<\/b>/);
});

test('trend line: when no pair was lost it says all still have them', () => {
  const line = inner(render(trendOf({ ...zero, hadPairs: 3, retained: 3 })), '<div class="trend">', '</div>');
  assert.equal(text(line), 'Since Fri 5 PM: all 3 showtimes with pairs still have them');
  assert.ok(!line.includes('remain'));
});

test('trend line: dates passed are singular for one, plural for more', () => {
  const one = inner(render(trendOf({ ...zero, passed: 1 })), '<div class="trend">', '</div>');
  assert.equal(text(one), 'Since Fri 5 PM: 1 date passed');
  const two = inner(render(trendOf({ ...zero, passed: 2 })), '<div class="trend">', '</div>');
  assert.equal(text(two), 'Since Fri 5 PM: 2 dates passed');
});

test('trend line: one new showtime is singular; new-with-pairs shows in brackets', () => {
  const one = inner(render(trendOf({ ...zero, newShows: 1 })), '<div class="trend">', '</div>');
  assert.equal(text(one), 'Since Fri 5 PM: +1 new showtime opened');
  const some = inner(render(trendOf({ ...zero, newShows: 3, newWithPairs: 2 })), '<div class="trend">', '</div>');
  assert.equal(text(some), 'Since Fri 5 PM: +3 new showtimes opened (2 with pairs)');
});

test('trend line: dated parts are joined with a middle dot, in order', () => {
  const html = render(trendOf({ hadPairs: 4, lostPairs: 1, retained: 2, passed: 1, newShows: 2, newWithPairs: 1 }));
  assert.equal(text(inner(html, '<div class="trend">', '</div>')),
    'Since Fri 5 PM: 1 of 4 showtimes sold out of pairs · 2 remain · 1 date passed · +2 new showtimes opened (1 with pairs)');
});

test('trend line: an all-zero summary renders nothing, not the word null', () => {
  const html = render(trendOf(zero));
  assert.ok(!html.includes('class="trend"'));
  assert.ok(!heroOf(html).includes('null'));
});

test('without a trend the hero prints nothing in its place, not the word null', () => {
  const hero = heroOf(render());
  assert.ok(!hero.includes('null'));
  assert.ok(!hero.includes('undefined'));
});

test('trend baseline label is HTML-escaped', () => {
  const html = render(trendOf({ ...zero, passed: 1 }, 'Fri <5> & "PM"'));
  assert.match(html, /Since Fri &lt;5&gt; &amp; &quot;PM&quot;: /);
});

const staleHistory = [
  { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 2, u: 4 }, 2: { p: 1, u: 1 }, 4: { p: 1, u: 6 } } },
  { at: '2026-07-19T12:00:00Z', kind: 'scan', shows: {} },
];

test('was-N tag is absent when the usable count has not changed', () => {
  // Baseline equals today for shows 1, 2 and 4 (4 / 1 / 6 usable): nothing to say.
  assert.ok(!renderScan(makeScan(), cfg, staleHistory).includes('class="was'));
});

test('was-N tag title names the baseline, or "at the last scan" without one', () => {
  const h = [
    { at: '2026-07-18T00:00:00Z', kind: 'scan', shows: { 1: { p: 2, u: 9 } } },
    { at: '2026-07-19T12:00:00Z', kind: 'scan', shows: { 1: { p: 2, u: 4 } } },
  ];
  const m = buildReportModel(cfg, makeScan(), h);
  const label = m.meta.trendBaseline;
  assert.ok(renderPage(m).includes(`class="was down" title="9 usable ${label}">was 9<`));
  m.meta.trendBaseline = null;
  assert.match(renderPage(m), /class="was down" title="9 usable at the last scan">was 9</);
});

test('a new sold-out show gets no New tag', () => {
  // Show 3 (sold out) is in no earlier observation, so it is new, but stays untagged.
  const html = renderScan(makeScan(), cfg, staleHistory);
  assert.equal(count(html, 'class="newtag"'), 0);
});

test('no-picks fallback renders when nothing has pairs', () => {
  const html = render(m => { m.topPicks = []; });
  assert.match(html, /No showtime currently has 2 good seats together/);
  assert.ok(!html.includes('pick best'));
});
