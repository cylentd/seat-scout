// Smoke test against the real scan data and config, when present. Asserts
// invariants (not exact numbers) so it stays green as the data changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildReportModel } from '../src/report/viewmodel.mjs';
import { renderPage } from '../src/report/view.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scanPath = path.join(ROOT, 'data', 'scan-latest.json');
const cfgPath = path.join(ROOT, 'config.json');
const available = existsSync(scanPath) && existsSync(cfgPath);

test('real scan data builds a coherent model and page', { skip: !available && 'no data/scan-latest.json' }, () => {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
  const model = buildReportModel(cfg, scan);

  const { stats } = model;
  assert.ok(stats.total > 0);
  assert.ok(stats.withPairs <= stats.total);
  assert.ok(stats.doablePairs <= stats.withPairs);
  assert.ok(stats.available + stats.soldOut <= stats.total);
  assert.ok(model.topPicks.length <= 3);
  if (stats.withPairs > 0) assert.ok(stats.bestPick, 'pairs exist so a best pick must too');

  // Every day is chronological and every show sits under its own date.
  const dates = model.days.map(d => d.dateISO);
  assert.deepEqual(dates, [...dates].sort());
  for (const day of model.days) {
    for (const show of day.shows) assert.equal(show.dateISO, day.dateISO);
    const times = day.shows.map(s => s.ticketingDate);
    assert.deepEqual(times, [...times].sort(), `shows out of order on ${day.dateISO}`);
  }

  // Seat payload contract the browser renderer depends on.
  for (const p of Object.values(model.seatPayloads)) {
    assert.ok(Array.isArray(p.s) && p.s.length > 0);
    for (const t of p.s) assert.equal(t.length, 6);
  }

  const html = renderPage(model);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal(html.split('<section class="day">').length - 1, model.days.length);
  assert.ok(html.includes('window.__SHOWS__='));
  // The page inlines everything — no external network references.
  assert.ok(!/(src|href)="https?:\/\//.test(html.replace(/<a [^>]*href="https?:\/\/[^"]*"/g, '')));
});
