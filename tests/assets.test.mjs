import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styles, clientScript } from '../src/report/assets.mjs';
import { ACCENT } from '../src/report/theme.mjs';

test('stylesheet defines the design-critical selectors', () => {
  const css = styles();
  for (const sel of [
    ':root', '.pick.best', '.dayhead', '.wkd', '.tier.center', '.tier.none',
    '.bar .c', '.bar .m', '.bar .f', '.pico', '.worktag', '.seg .ind',
    '.show-body', '@keyframes pulse', '@media (prefers-reduced-motion: reduce)',
  ]) {
    assert.ok(css.includes(sel), `missing ${sel}`);
  }
  assert.ok(css.includes(ACCENT), 'accent colour must come from the theme');
});

test('composition bar is right-anchored so the dark side fills up', () => {
  const bar = styles().split('.bar {')[1].split('}')[0];
  assert.match(bar, /justify-content:flex-end/);
});

test('stylesheet braces are balanced (cheap malformed-CSS guard)', () => {
  const css = styles();
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('client script is syntactically valid JavaScript', () => {
  // Parses without executing — catches template-literal slips in the generator.
  assert.doesNotThrow(() => new Function(clientScript()));
});

test('client script keeps the interactive machinery', () => {
  const js = clientScript();
  for (const marker of [
    'class PanZoom', 'function jumpTo', 'function moveInd', 'function setCount',
    "state = { quality:'pairs', part:'all' }", 'prefers-reduced-motion',
  ]) {
    assert.ok(js.includes(marker), `missing ${marker}`);
  }
});
