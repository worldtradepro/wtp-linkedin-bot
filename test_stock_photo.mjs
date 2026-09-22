// One-off diagnostic for stock_photo.mjs: run a batch of real-world-shaped headlines (Infrastructure project
// subsectors newly wired in) through stockPhoto() and report what query/photo each one picked, without
// touching state/stock_used.json's real dedup history (a throwaway id per case) or posting anything.
import { stockPhoto, queriesFor } from './stock_photo.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('stock_test', { recursive: true });
const NOW = Date.now();

const CASES = [
  { headline: 'Yanbu pipeline attack ripples across crude, freight and gas markets', sector: 'Shipping', subsector: '' },
  { headline: 'Hormuz Sees More LNG Traffic', sector: 'Energy', subsector: '' },
  { headline: 'First Al-Khail Road Scheme', sector: 'Logistics & Infrastructure', subsector: 'Roads & Transport' },
  { headline: 'Callao Terminal Expansion', sector: 'Logistics & Infrastructure', subsector: 'Ports & Terminals' },
  { headline: 'New Runway and Terminal Building Project', sector: 'Logistics & Infrastructure', subsector: 'Airports' },
  { headline: '254 MW Battery Storage Project', sector: 'Energy', subsector: 'Power & Transmission' },
  { headline: 'North Macedonia BESS Project', sector: 'Energy', subsector: 'Power & Transmission' },
  { headline: 'SAN-7 Fertilizer Plant', sector: 'Agriculture', subsector: 'Fertilizer Plants' },
  { headline: 'Ammonia-Urea Expansion', sector: 'Agriculture', subsector: 'Fertilizer Plants' },
  { headline: 'DRI Smelting Furnace Plant', sector: 'Mining & Metals', subsector: 'Processing & Smelting' },
  { headline: 'Slovakia Hydropower Plant Modernization', sector: 'Energy', subsector: 'Hydropower' },
  { headline: 'Regional Desalination and Water Treatment Scheme', sector: 'Agriculture', subsector: 'Irrigation & Water' },
  { headline: 'Crawford Nickel Project Fleet Purchase', sector: 'Mining & Metals', subsector: 'Mine Development' },
  { headline: 'Oaklands Solar Park', sector: 'Energy', subsector: 'Renewables' },
];

const report = [];
for (const c of CASES) {
  const id = 'test-' + c.headline.replace(/[^a-z0-9]+/gi, '-').slice(0, 30) + '-' + NOW;
  console.log('---', c.headline);
  console.log('  queriesFor:', queriesFor(c));
  const r = await stockPhoto({ id, ...c }, (m) => console.log('  log:', m));
  if (r) {
    writeFileSync(`stock_test/${id}.jpg`, r.jpeg);
    report.push({ headline: c.headline, subsector: c.subsector, query: r.query, photoId: r.photoId, credit: r.credit, file: id + '.jpg' });
  } else {
    report.push({ headline: c.headline, subsector: c.subsector, result: null });
  }
}
writeFileSync('stock_test/report.json', JSON.stringify(report, null, 2));
console.log('DONE');
