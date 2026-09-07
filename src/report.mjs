// Report entry point — orchestration only. Load inputs, build the view model,
// render, write. All logic lives in ./report/* and ./classify.mjs.
// Usage: node src/report.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadReportModel } from './report-load.mjs';
import { renderPage } from './report/view.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function main() {
  const { model } = loadReportModel(ROOT);

  const outPath = path.join(ROOT, 'report.html');
  writeFileSync(outPath, renderPage(model));

  console.log(`Report written -> ${outPath}`);
  console.log(`${model.stats.withPairs}/${model.stats.total} showtimes have an acceptable adjacent pair.`);
  if (model.stats.bestPick) {
    const p = model.stats.bestPick;
    console.log(`Best pick: ${p.dayLabel} ${p.timeLabel} (${p.badges.map(b => `${b.count} ${b.label}`).join(', ')}).`);
  }
}

main();
