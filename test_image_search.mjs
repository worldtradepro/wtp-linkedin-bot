// Diagnostic for image_search.mjs on the GitHub runner (Bing News RSS + browser): runs bestImage() for a few
// headlines with no article photo and writes what it picked to image_test/ (published to branch images/image-test/). Posts nothing.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { bestImage, keyTerms, searchQuery, newsArticles } from './image_search.mjs';

mkdirSync('image_test', { recursive: true });
const CASES = [
  { headline: 'Aramco Restores East-West Pipeline as War Risk Closes In on Yanbu', context: 'Saudi Aramco has restarted its East-West pipeline (Petroline). Tanker loadings at Yanbu have restarted.' },
  { headline: 'India expected to double pulse imports', context: 'India could import twice as many pulses. Canada and Australia supply most.' },
];
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', locale: 'en-US' });
const report = [];
for (const [k, c] of CASES.entries()) {
  const logs = [];
  const raw = await newsArticles(searchQuery(keyTerms(c.headline, c.context)), (m) => logs.push(m));
  logs.push('raw rows: ' + raw.length, ...raw.slice(0, 6).map((x) => x.title.slice(0, 70) + ' | ' + x.link.slice(0, 60) + ' | ' + x.date));
  const r = await bestImage(ctx, { ...c, articleUrl: '', lead: null }, (m) => { console.log(m); logs.push(m); });
  if (r) writeFileSync(`image_test/case-${k}.jpg`, r.jpeg);
  report.push({ headline: c.headline, query: searchQuery(keyTerms(c.headline, c.context)), pick: r ? { url: r.url, credit: r.credit, note: r.note, w: r.w, h: r.h } : null, logs });
  console.log(c.headline, '->', r ? r.note : 'nothing');
}
await browser.close();
writeFileSync('image_test/report.json', JSON.stringify(report, null, 2));
