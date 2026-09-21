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
const isFlow = !format.startsWith('projects');   // flash | weekly (Trade Flow)  /  projects | projects-weekly (Infrastructure)
const WEEKLY = format === 'projects-weekly';
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
  swap("title: 'New Infrastructure Projects', globe: 540", "title: window.__WTP_WEEKLY ? 'Weekly Infrastructure Update' : 'New Infrastructure Projects', globe: 680");
  // weekly variant (format "projects-weekly"): same card, own title / heading, plus a country-hotspot line
  swap("bodyHeading(ctx, 'TOP PICKS', y - 8);", "bodyHeading(ctx, window.__WTP_WEEKLY ? 'LARGEST PROJECTS THIS WEEK' : 'TOP PICKS', y - 8);");
  swap('sectors: sectors, picks: picks };', 'sectors: sectors, picks: picks, byCountry: byCountry };');
  swap('y + 22 + pd.picks.length * 74 + 14);', "y + 22 + pd.picks.length * 74 + 14); if (window.__WTP_WEEKLY) { var hs = Object.keys(pd.byCountry).sort(function(a, b) { return pd.byCountry[b] - pd.byCountry[a]; }).slice(0, 4).map(function(c) { return countryName(c) + ' ' + pd.byCountry[c]; }); ctx.fillText(fitText(ctx, 'Hotspots  ' + hs.join('  ·  '), 960), 60, y + 22 + pd.picks.length * 74 + 48); }");
  return body;
}

// Daily flash: remember which stories the card names (window.__WTP_FLASH), so generate.mjs keeps them out of the day's news posts.
// It also adds the affected trade lanes (Critical / Elevated signals on the map's own lanes) to the card and the caption:
// the globe is drawn a little smaller to make room for up to 3 lane rows, exactly like the weekly card's lane list.
function patchFlash(body) {
  const swap = (from, to) => {
    const n = body.split(from).length - 1;
    if (n !== 1) throw new Error(`map code changed: expected 1x "${from}", found ${n} - update patchFlash()`);
    body = body.replace(from, () => to);
  };
  swap('function flashData() {',
    'function flashLanes() { var st = computeLaneStates(allItems.filter(isFlow)); var ls = TRADE_LANES.map(function(l) { return st[l.id]; }).filter(function(s) { return s && (s.counts.crit + s.counts.elev) > 0; }); ls.sort(function(a, b) { return (b.counts.crit * 100 + b.counts.elev * 10 + b.counts.watch) - (a.counts.crit * 100 + a.counts.elev * 10 + a.counts.watch); }); return ls.slice(0, 3); }\n        function flashData() {');
  swap('tiers: tierCounts(pool), picks: picks };',
    'tiers: tierCounts(pool), lanes: flashLanes(), picks: (window.__WTP_FLASH = picks.map(function(it) { return { url: it.source_url, title: it.project_name }; }), picks) };');
  swap("title: 'Trade Flow · Daily Flash', globe: 600,", "title: 'Trade Flow · Daily Flash', globe: (fd.lanes && fd.lanes.length ? 600 - (32 + fd.lanes.length * 42) : 600),");
  swap('fd.picks.forEach(function(it, i) {',
    "var LO = 0; if (fd.lanes && fd.lanes.length) { LO = 32 + fd.lanes.length * 42; bodyHeading(ctx, 'AFFECTED TRADE LANES  ·  LAST 7 DAYS', y - 8); fd.lanes.forEach(function(s, i) { var ly = y + 34 + i * 42; ctx.beginPath(); ctx.arc(72, ly - 9, 9, 0, Math.PI * 2); ctx.fillStyle = LANE_COLORS[s.tier] || '#a9bdd8'; ctx.fill(); ctx.fillStyle = '#ffffff'; ctx.font = cardFont(700, 29); ctx.textAlign = 'left'; ctx.fillText(fitText(ctx, s.lane.name, 560), 96, ly); ctx.fillStyle = '#cfd9ea'; ctx.font = cardFont(600, 24); ctx.textAlign = 'right'; ctx.fillText(laneCountsText(s.counts), 1020, ly); ctx.textAlign = 'left'; }); }\n                        fd.picks.forEach(function(it, i) {");
  swap('var by = y + i * 132, tier = flowTier(it);', 'var by = y + LO + i * 132, tier = flowTier(it);');
  swap("L.push(fd.count + ' signals tracked '",
    "if (fd.lanes && fd.lanes.length) { L.push('Trade lanes under pressure (last 7 days): ' + fd.lanes.map(function(s) { return s.lane.name + ' (' + laneCountsText(s.counts) + ')'; }).join(' · ')); L.push(''); }\n            L.push(fd.count + ' signals tracked '");
  return body;
}

// Trade Flow cards: expose the map's globe (window.__WTP_WORLD) so the lit trade lanes can be drawn bold before the capture.
function exposeWorld(body) {
  const from = 'var world = Globe()(globeWrapEl)';
  const n = body.split(from).length - 1;
  if (n !== 1) throw new Error(`map code changed: expected 1x "${from}", found ${n} - update exposeWorld()`);
  return body.replace(from, () => 'var world = window.__WTP_WORLD = Globe()(globeWrapEl)');
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
  if (isFlow) body = exposeWorld(body);
  if (format === 'flash') body = patchFlash(body);
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
await page.addInitScript(({ p, w }) => { window.__WTP_PICK = p; window.__WTP_WEEKLY = w; }, { p: PICKS, w: WEEKLY });
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
    await page.locator('[data-role="range"] button[data-v="7"]').evaluate((el) => el.click());
    await page.waitForTimeout(9000);
  }

  if (isFlow) {   // affected lanes: thick, solid, only the lit ones, camera turned onto them (the site's thin animated dashes vanish once the globe is shrunk onto a card)
    await page.evaluate(() => {
      const w = window.__WTP_WORLD; if (!w) return;
      const lit = (w.pathsData() || []).filter((d) => d.tier);
      w.pathsData(lit);
      w.pathStroke((d) => (d.tier === 'crit' ? 6 : d.tier === 'elev' ? 5 : 4)).pathDashLength(1).pathDashGap(0).pathDashAnimateTime(0);
      try { w.controls().autoRotate = false; } catch (e) {}   // the globe drifts while idle: freeze it so the camera stays on the lanes
      const worst = lit.filter((d) => d.tier === 'crit');   // centre on the most affected lanes when there are any
      const pts = (worst.length ? worst : lit).flatMap((d) => d.pts);
      if (pts.length) {   // frame the most affected lanes: their mean position, moderately close
        const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length, lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        w.pointOfView({ lat, lng: lng + 8, altitude: 1.4 }, 0);
      }
    });
    await page.waitForTimeout(2500);
  }
  await shareBtn.evaluate((el) => el.click());   // JS click: Playwright's own click waits for a stable, unobstructed target and timed out once while the WebGL page was busy
  if (format === 'weekly') {
    await page.locator(`.wim-share-pills button[data-fmt="${format}"]`).evaluate((el) => el.click());
  }
  await page.locator('.wim-share-img img, .wim-share-err').first().waitFor({ timeout: 30000 });

  const res = await page.evaluate(() => ({
    flashPicks: window.__WTP_FLASH || [],
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
  fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ format, file: path.basename(file), caption, link: mapLink, errors: res.errors, flashPicks: res.flashPicks }, null, 2));
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
