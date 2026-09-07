// Post the current report.html to Discord.
//
// Run after report.mjs — it reads the same inputs to write the summary, so an
// out-of-date report.html would be described with fresh numbers. Guarded below.
//
// Usage: node src/share-report.mjs [--attach]
//   --attach also uploads report.html. Off by default: Discord previews an
//   .html attachment as raw syntax-highlighted source, which buries the embed.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadReportModel, reportSummary } from './report-load.mjs';
import { postReport } from './notify.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const attach = process.argv.includes('--attach');
  const webhookUrl = process.env.SEAT_SCOUT_DISCORD_WEBHOOK;
  if (!webhookUrl) {
    console.error('No SEAT_SCOUT_DISCORD_WEBHOOK set — nothing to post to.');
    console.error('(setx sets it for FUTURE shells; open a new terminal after setting it.)');
    process.exit(1);
  }

  const reportPath = path.join(ROOT, 'report.html');
  if (!existsSync(reportPath)) {
    console.error('No report.html yet — run "node src/report.mjs" first.');
    process.exit(1);
  }

  const { cfg, scan, model } = loadReportModel(ROOT);

  // Describing a stale file with fresh stats would be a quiet lie, so say so.
  const scanAt = scan.scannedAt ? new Date(scan.scannedAt).getTime() : 0;
  if (scanAt && statSync(reportPath).mtimeMs < scanAt) {
    console.log('Warning: report.html is older than the latest scan — rebuild with "node src/report.mjs" first.');
  }

  const r = await postReport(webhookUrl, {
    ...reportSummary(cfg, scan, model),
    filePath: attach ? reportPath : null,
  });

  if (r.sent) console.log(`Posted to Discord${r.bytes ? ` with report.html (${(r.bytes / 1024).toFixed(0)} KB)` : ''}.`);
  else { console.error(`Failed to post: ${r.reason || 'HTTP ' + r.status}`); process.exit(1); }
}

main().catch(e => { console.error(e.message); process.exit(1); });
