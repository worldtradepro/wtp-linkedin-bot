// Diagnostic: which picture sources give sensible results FROM THE GITHUB RUNNER (Bing Images served junk there on 2026-09-26).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('image_test', { recursive: true });
const Q = 'aramco east-west yanbu pipeline';
const out = {};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
const page = await ctx.newPage();
const titles = async () => page.evaluate(() => [...document.querySelectorAll('a.iusc')].slice(0, 6).map((a) => { try { const m = JSON.parse(a.getAttribute('m')); return m.t + ' | ' + m.purl; } catch { return '?'; } }));
try { await page.goto('https://www.bing.com/images/search?q=' + encodeURIComponent(Q) + '&mkt=en-US&setlang=en&first=1', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); out.bingMkt = await titles(); } catch (e) { out.bingMkt = String(e); }
try {
  await page.goto('https://www.bing.com/?mkt=en-US', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
  await page.goto('https://www.bing.com/images/search?q=' + encodeURIComponent(Q) + '&form=HDRSC2', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); out.bingWarm = await titles();
} catch (e) { out.bingWarm = String(e); }
for (const [k, u] of [['bingNewsRss', 'https://www.bing.com/news/search?q=' + encodeURIComponent(Q) + '&format=rss&mkt=en-US'],
  ['googleNewsRss', 'https://news.google.com/rss/search?q=' + encodeURIComponent(Q) + '&hl=en-US&gl=US&ceid=US:en'],
  ['commons', 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=' + encodeURIComponent('Yanbu') + '&prop=imageinfo&iiprop=url|size|extmetadata']]) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': k === 'commons' ? 'wtp-linkedin-bot/1.0 (contact@worldtradepro.com)' : UA } });
    const t = await r.text();
    out[k] = k === 'commons' ? Object.values(JSON.parse(t).query?.pages || {}).map((p) => p.title + ' ' + p.imageinfo?.[0]?.width + 'x' + p.imageinfo?.[0]?.height)
      : [...t.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => m[1].slice(0, 80) + ' | ' + m[2].slice(0, 90) + (/<News:Image>|media:content|enclosure/i.test(m[3]) ? ' [has image]' : ''));
    out[k + 'Status'] = r.status;
  } catch (e) { out[k] = String(e); }
}
await browser.close();
writeFileSync('image_test/sources.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
