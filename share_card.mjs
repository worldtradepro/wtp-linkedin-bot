// Makes the Intelligence Map's own Share card (image + caption) without touching the live web page:
// Cloudflare's Bot Fight Mode shows a human check to CI browsers, so the page is rebuilt locally from
// the map's code (map/snippet_51.txt = copy of Code Snippets #51) and only the DATA comes from the
// site's public API, fetched by Node (which is not challenged). Then we click the map's own "Share" button.
//   node share_card.mjs                  -> Trade Flow daily flash
//   node share_card.mjs weekly           -> Trade Flow weekly update
//   node share_card.mjs projects         -> Infrastructure (needs WTP_BOT_SECRET for the fresh, paid week)
// KEEP map/snippet_51.txt IN SYNC with the live snippet whenever the map is redeployed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const format = process.argv[2] || 'flash';
const isFlow = format !== 'projects';
const SITE = process.env.SITE || 'https://worldtradepro.com';
const SECRET = process.env.WTP_BOT_SECRET || '';
const SNIPPET = process.env.MAP_SNIPPET || 'map/snippet_51.txt';
const outDir = process.env.OUT_DIR || 'share_test';
fs.mkdirSync(outDir, { recursive: true });
const NL = String.fromCharCode(10);

// ---- rebuild the map page from the snippet source (same extraction as wtp-local/preview_harness) ----
function centroidsJson(src) {
  const a = src.indexOf('function wtp_map_country_centroids()');
  const body = src.slice(a, src.indexOf(');', a));
  const out = {};
  const re = /'([^']+)'=>\[(-?[\d.]+),(-?[\d.]+)\]/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = [parseFloat(m[2]), parseFloat(m[3])];
  return out;
}
// Infrastructure card, bot-side tweaks (the live map stays untouched): show exactly the projects the daily post names
// (window.__WTP_PICK = their source URLs, set below) instead of the map's own 5 picks, and close up the layout.
// Each tweak asserts that its anchor exists, so a map change that breaks it fails loudly instead of posting a broken card.
function patchProjects(body) {
  const swap = (from, to, times = 1) => {
    const n = body.split(from).length - 1;
    if (n !== times) throw new Error(`map code changed: expected ${times}x "${from}", found ${n} - update patchProjects()`);
    body = body.split(from).join(to);
  };
  swap('picks.length < 5', 'picks.length < 3', 2);   // never more than 3 projects on the card (paywall rule); the list is then overridden by the daily post's own 3
  swap('var sectors = Object.keys(bySector)', 'if (window.__WTP_PICK && window.__WTP_PICK.length) { var only = ranked.filter(function(it) { return window.__WTP_PICK.indexOf(it.source_url) >= 0; }); if (only.length) picks = only; }\n            var sectors = Object.keys(bySector)');
  swap('y + 22 + 5 * 74 + 14', 'y + 22 + pd.picks.length * 74 + 14');
  swap("title: 'New Infrastructure Projects', globe: 540", "title: 'New Infrastructure Projects', globe: 680");
  return body;
}

function buildPage() {
  const src = fs.readFileSync(SNIPPET, 'utf8');
  const start = src.indexOf('<script src="https://unpkg.com/globe.gl');
  const end = src.lastIndexOf('<?php');
  let body = src.slice(start, end);
  body = body.replace(/<\?php echo wp_json_encode\(\$api_base\); \?>/, JSON.stringify(SITE + '/wp-json/wtp/v1/opportunities'));
  body = body.replace(/<\?php echo \$centroids_json; \?>/, JSON.stringify(centroidsJson(src)));
  if (/<\?php|\?>/.test(body)) throw new Error('unreplaced PHP left in snippet body');
  if (!isFlow) body = patchProjects(body);
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Intelligence Map</title>' +
    '<style>html,body{margin:0;background:#eef2f7;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}#wtp-imap-root{height:100vh}</style></head><body>' +
    '<div id="wtp-imap-root" data-report-type="both"></div>' + body + '</body></html>';
}

async function proxyApi(route) {
  let url = route.request().url();
  if (!isFlow && SECRET && !url.includes('secret=')) url += (url.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(SECRET);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } });
      const text = await r.text();
      if (r.status === 503 && i < 2) { await new Promise((res) => setTimeout(res, 1200 * (i + 1))); continue; }
      return route.fulfill({ status: r.status, contentType: r.headers.get('content-type') || 'application/json', body: text });
    } catch (e) {
      if (i === 2) return route.abort();
    }
  }
}

const browser = await chromium.launch({
  headless: true,
  // no GPU on CI runners: force software WebGL so the globe can be drawn and captured
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const logs = [];
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); logs.push('[pageerror] ' + e.message); });
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
page.on('requestfailed', (r) => logs.push('[requestfailed] ' + r.url() + ' ' + (r.failure() || {}).errorText));

// Our own host: the page itself is served from the local rebuild, the API through Node, everything else refused
// (so the browser never hits Cloudflare's human check).
const siteHost = new URL(SITE).hostname;
const html = buildPage();
const PICKS = process.env.PICK_FILE ? JSON.parse(fs.readFileSync(process.env.PICK_FILE, 'utf8')) : [];
await page.addInitScript((p) => { window.__WTP_PICK = p; }, PICKS);
await page.route((u) => u.hostname === siteHost, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  if (u.pathname.startsWith('/wp-json/')) return proxyApi(route);
  return route.abort();
});

try {
  const url = `${SITE}/?view=${isFlow ? 'flows' : 'infrastructure'}`;
  console.log('open', url, '(local rebuild)');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const shareBtn = page.locator('[data-role="tlshare"]');
  await shareBtn.waitFor({ state: 'visible', timeout: 60000 });
  // let the data load and the globe render before capturing it
  await page.waitForTimeout(12000);
  if (!isFlow && (process.env.INFRA_RANGE || '7') === '7') {   // Infrastructure opens on the free 7-15 day window; the fresh week is the "Last 7d" button (data comes with the pipeline secret)
    await page.locator('[data-role="range"] button[data-v="7"]').click();
    await page.waitForTimeout(9000);
  }

  await shareBtn.click();
  if (format !== 'flash' && format !== 'projects') {
    await page.locator(`.wim-share-pills button[data-fmt="${format}"]`).click();
  }
  await page.locator('.wim-share-img img, .wim-share-err').first().waitFor({ timeout: 30000 });

  const res = await page.evaluate(() => ({
    src: (document.querySelector('.wim-share-img img') || {}).src || '',
    caption: (document.querySelector('[data-role="sharecaption"]') || {}).value || '',
    errors: [...document.querySelectorAll('.wim-share-err, .wim-share-warn')].map((e) => e.textContent.trim()),
    filename: (document.querySelector('[data-role="sharedl"]') || {}).download || '',
  }));

  if (!res.src.startsWith('data:image/png')) { console.error('no image produced', res.errors); await page.screenshot({ path: path.join(outDir, 'debug.png') }); process.exit(2); }
  if (res.errors.some((e) => /globe could not be captured/i.test(e))) { console.error('globe missing from card:', res.errors); process.exit(3); }
  const file = path.join(outDir, res.filename || `${format}.png`);
  fs.writeFileSync(file, Buffer.from(res.src.split(',')[1], 'base64'));
  // Buffer Free has no first comment: the map's "link in the first comment" lines become a link in the post body.
  const today = new Date().toISOString().slice(0, 10);
  const mapLink = `${SITE}/?view=${isFlow ? 'flows' : 'infrastructure'}&utm_source=linkedin&utm_medium=social&utm_campaign=${format}-${today.replace(/-/g, '')}`;
  let caption = res.caption
    .replace(/Live map in the first comment\./, `Live map ➡️ ${mapLink}`)
    .replace(/Live map link in the first comment\./, `Live map ➡️ ${mapLink}`);
  if (isFlow && !caption.includes(mapLink)) caption = caption.replace(/\n\n(#\S+(?: #\S+)*)\s*$/, `\n\nLive map ➡️ ${mapLink}\n\n$1`);
  fs.writeFileSync(file.replace(/\.png$/, '.txt'), caption);
  fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ format, file: path.basename(file), caption, link: mapLink, errors: res.errors }, null, 2));
  console.log('saved', file);
  console.log('warnings:', res.errors);
  console.log('--- caption ---' + NL + caption);
} catch (e) {
  console.error('FAILED:', e.message);
  fs.writeFileSync(path.join(outDir, 'error.txt'), [e.stack, '', logs.join(NL)].join(NL));
  try { await page.screenshot({ path: path.join(outDir, 'debug.png') }); } catch (_) {}
  try {
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); return g ? g.getParameter(g.VERSION) : 'NO WEBGL'; });
    fs.appendFileSync(path.join(outDir, 'error.txt'), NL + NL + 'WEBGL: ' + gl);
  } catch (_) {}
  await browser.close();
  process.exit(1);
}
await browser.close();
