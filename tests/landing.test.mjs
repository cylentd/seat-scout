import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLanding } from '../src/landing.mjs';
import { profileFromCfg } from '../src/app-core.mjs';
import { cfg } from './helpers.mjs';

const info = { hasReport: true, lastScannedAt: '2026-07-19T12:00:00.000Z', canWatch: true };

test('landing prefills the form from config', () => {
  const html = renderLanding(cfg, info);
  assert.match(html, /value="The Odyssey"/);      // movie (display-name special case)
  assert.match(html, /value="IMAX 70MM"/);        // format
  assert.match(html, /<output id="party">2</);    // party size
  assert.match(html, /Test Theatre/);             // theatre summary
  assert.match(html, /value="TEST1"/);            // theatre id
  assert.match(html, /<a class="report-link"/);   // specific labelled report link
  assert.match(html, /id="quick"/);               // canWatch => quick check button
  assert.match(html, /id="t-near"/);              // theatre finder: location input…
  assert.match(html, /id="t-find"/);              // …its search button…
  assert.match(html, /id="t-results"/);           // …and the results container
});

test('quick check and report link hide when unavailable', () => {
  const html = renderLanding(cfg, { hasReport: false, lastScannedAt: null, canWatch: false });
  assert.ok(!html.includes('id="quick"'));
  assert.ok(!html.includes('<a class="report-link"'));
});

test('slate JSON payload cannot break out of the script tag', () => {
  // The now-playing slate is embedded as JSON for the carousel; a hostile title
  // must not close the <script> or inject markup.
  const slate = [{ title: '</script><script>alert(1)', formats: [] }];
  const html = renderLanding(cfg, info, [], slate);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.match(html, /\\u003c\/script/);
});

test('landing HTML-escapes config strings', () => {
  const spicy = structuredClone(cfg);
  spicy.theatreName = "O'Brien & Sons <hall>";
  const html = renderLanding(spicy, info);
  assert.match(html, /O&#39;Brien &amp; Sons &lt;hall&gt;/);
});
