// Prototype: drive the live Intelligence Map in a headless browser, click "Share ↗" and save the
// image + caption the map itself builds (so the bot's card = the map's own share card).
//   node share_card.mjs                  -> Trade Flow daily flash
//   node share_card.mjs weekly           -> Trade Flow weekly update
//   node share_card.mjs projects         -> Infrastructure (needs WTP_BOT_SECRET for the fresh, paid week)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const format = process.argv[2] || 'flash';
const isFlow = format !== 'projects';
const SITE = process.env.SITE || 'https://worldtradepro.com';
const outDir = process.env.OUT_DIR || 'share_test';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  // no GPU on CI runners: force software WebGL so the globe can be drawn and captured
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// Infrastructure's newest 7 days are paid: give the map's own data request the pipeline secret.
if (!isFlow && process.env.WTP_BOT_SECRET) {
  await page.route('**/wtp/v1/**', (route) => route.continue({ headers: { ...route.request().headers(), 'X-WTP-Secret': process.env.WTP_BOT_SECRET } }));
}

const url = `${SITE}/?view=${isFlow ? 'flows' : 'infrastructure'}`;
console.log('open', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

const shareBtn = page.locator('[data-role="tlshare"]');
await shareBtn.waitFor({ state: 'visible', timeout: 60000 });
// let the data load and the globe render before capturing it
await page.waitForTimeout(12000);

await shareBtn.click();
if (format !== 'flash' && format !== 'projects') {
  await page.locator(`.wim-share-pills button[data-fmt="${format}"]`).click();
}
await page.locator('.wim-share-img img, .wim-share-err').first().waitFor({ timeout: 30000 });

const res = await page.evaluate(() => ({
  src: (document.querySelector('.wim-share-img img') || {}).src || '',
  caption: (document.querySelector('[data-role="sharecaption"]') || {}).value || '',
  link: '',
  errors: [...document.querySelectorAll('.wim-share-err, .wim-share-warn')].map((e) => e.textContent.trim()),
  filename: (document.querySelector('[data-role="sharedl"]') || {}).download || '',
}));

if (!res.src.startsWith('data:image/png')) { console.error('no image produced', res.errors); await page.screenshot({ path: path.join(outDir, 'debug.png') }); process.exit(2); }
const file = path.join(outDir, res.filename || `${format}.png`);
fs.writeFileSync(file, Buffer.from(res.src.split(',')[1], 'base64'));
fs.writeFileSync(file.replace(/\.png$/, '.txt'), res.caption);
console.log('saved', file);
console.log('warnings:', res.errors);
console.log('--- caption ---\n' + res.caption);
await browser.close();
