// One-off diagnostic: does UNSPLASH_ACCESS_KEY work, and what would the Yanbu post (2026-09-21, no lead photo)
// have gotten from stockPhoto()? Publishes the picked jpeg + its credit line to branch images/stock-test/.
// Nothing is posted anywhere; this only exercises stock_photo.mjs in isolation.
import { stockPhoto } from './stock_photo.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('stock_test', { recursive: true });
const post = { id: 'test-yanbu-' + Date.now(), headline: 'Yanbu pipeline attack ripples across crude, freight and gas markets', sector: 'Shipping', subsector: '' };
const r = await stockPhoto(post, (m) => console.log('log:', m));
if (!r) { console.log('RESULT: null (no key, or no match, or rate limited - see log above)'); process.exit(0); }
writeFileSync('stock_test/yanbu.jpg', r.jpeg);
writeFileSync('stock_test/yanbu.json', JSON.stringify({ url: r.url, credit: r.credit, query: r.query, photoId: r.photoId, w: r.w, h: r.h }, null, 2));
console.log('RESULT:', JSON.stringify({ credit: r.credit, query: r.query, photoId: r.photoId, w: r.w, h: r.h }, null, 2));
