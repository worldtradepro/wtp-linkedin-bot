// One-off diagnostic for stock_photo.mjs: run a batch of real-world-shaped headlines (Infrastructure project
// subsectors newly wired in) through stockPhoto() and report what query/photo each one picked, without
// touching state/stock_used.json's real dedup history (a throwaway id per case) or posting anything.
import { stockPhoto, queriesFor } from './stock_photo.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('stock_test', { recursive: true });
const NOW = Date.now();

// Kept small on purpose: Unsplash's free "demo" app is 50 requests/hour, shared with the real daily pipeline and
// with re-runs of this same diagnostic - a 14-case batch burned the whole hourly quota once already (2026-09-22).
const CASES = [
  { headline: '254 MW Battery Storage Project', sector: 'Energy', subsector: 'Power & Transmission' },
  { headline: 'Callao Terminal Expansion', sector: 'Logistics & Infrastructure', subsector: 'Ports & Terminals' },
];

const report = [];
for (const c of CASES) {
  const id = 'test-' + c.headline.replace(/[^a-z0-9]+/gi, '-').slice(0, 30) + '-' + NOW;
  const logs = [];
  console.log('---', c.headline);
  console.log('  queriesFor:', queriesFor(c));
  const r = await stockPhoto({ id, ...c }, (m) => { console.log('  log:', m); logs.push(m); });
  if (r) {
    writeFileSync(`stock_test/${id}.jpg`, r.jpeg);
    report.push({ headline: c.headline, subsector: c.subsector, query: r.query, photoId: r.photoId, w: r.w, h: r.h, ratio: (Math.max(r.w, r.h) / Math.min(r.w, r.h)).toFixed(2), credit: r.credit, file: id + '.jpg', logs });
  } else {
    report.push({ headline: c.headline, subsector: c.subsector, result: null, logs });
  }
}
writeFileSync('stock_test/report.json', JSON.stringify(report, null, 2));
console.log('DONE');
