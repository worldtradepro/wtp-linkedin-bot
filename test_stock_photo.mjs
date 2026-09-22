// One-off diagnostic for stock_photo.mjs. Two things:
//  1. inspect(query) - what does Unsplash actually return for a query? (id, description, alt text, size) - to judge
//     whether a query is specific enough, without touching the used-photos dedup state.
//  2. stockPhoto() for a couple of real headlines, to see what would actually be picked and its credit line.
// Nothing is posted anywhere; the picked jpegs + a report go to branch images/stock-test/.
import { stockPhoto, queriesFor } from './stock_photo.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.UNSPLASH_ACCESS_KEY || '';
mkdirSync('stock_test', { recursive: true });
const headers = () => ({ Authorization: 'Client-ID ' + KEY, 'Accept-Version': 'v1' });

async function inspect(query) {
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high&per_page=15`, { headers: headers() });
  if (!r.ok) return { query, error: 'HTTP ' + r.status };
  const data = await r.json();
  return { query, total: data.total, results: (data.results || []).map((p) => ({ id: p.id, desc: p.description || p.alt_description || '', w: p.width, h: p.height })) };
}

const CASES = [
  { id: 'test-hormuz-' + Date.now(), headline: 'Hormuz Sees More LNG Traffic', sector: 'Energy', subsector: '' },
  { id: 'test-yanbu2-' + Date.now(), headline: 'Yanbu pipeline attack ripples across crude, freight and gas markets', sector: 'Shipping', subsector: '' },
];

const report = { queries: {}, picks: [] };
for (const q of ['lng carrier ship', 'natural gas terminal', 'lng tanker', 'liquefied natural gas ship']) {
  report.queries[q] = await inspect(q);
  console.log(q, '->', JSON.stringify(report.queries[q].results?.map((r) => r.desc || '(no description)')));
}
for (const c of CASES) {
  console.log('queriesFor:', c.headline, '->', queriesFor(c));
  const r = await stockPhoto(c, (m) => console.log('  log:', m));
  if (r) {
    writeFileSync(`stock_test/${c.id}.jpg`, r.jpeg);
    report.picks.push({ headline: c.headline, query: r.query, photoId: r.photoId, credit: r.credit, w: r.w, h: r.h, file: c.id + '.jpg' });
  } else {
    report.picks.push({ headline: c.headline, result: null });
  }
}
writeFileSync('stock_test/report.json', JSON.stringify(report, null, 2));
console.log('DONE');
