// Picks the MOST RELEVANT picture for a post, not only the article's own lead photo (user decision 2026-09-26: relevance first,
// credit the picture's source in the post). Candidates:
//   - the article's lead photo (scored by its alt text / caption; with none it gets a flat "probably generic" score),
//   - Bing Images results for the headline's key words (scored by how many key words their page title / URL carry).
// The best one that downloads and passes the shape / "is a photo" checks wins. Rule-based only - no AI.

import { createHash } from 'node:crypto';

const STOP = new Set(('the a an and or of for with from that this into over amid after their than have will says said its are was has new more your as at by on in to up out off ' +
  'is be it after before could would may might can how why what who when where which while about against despite under amid set sets see sees seen ' +
  'report reports reported says week weeks month year years day days first last next near nearly record high higher low lower rise rises rising fall falls ' +
  'falling surge surges soar soars soaring slump drop drops cut cuts hit hits closes close closing restores restore restart restarts ' +
  'expected expects expect double doubles triple plan plans planned warn warns warned likely amid face faces faced boost boosts boosted make makes most').split(' '));
// words that describe WHAT is in a picture: count them even when lower-case
const THINGS = /^(pipeline|pipelines|tanker|tankers|refinery|refineries|lng|lpg|port|ports|terminal|terminals|strait|canal|vessel|vessels|ship|ships|shipping|container|containers|oil|crude|gas|diesel|coal|copper|iron|steel|aluminium|aluminum|lithium|gold|wheat|corn|soybean|soybeans|rice|sugar|coffee|cocoa|fertilizer|ammonia|hydrogen|solar|wind|turbine|turbines|offshore|rig|rigs|mine|mines|mining|smelter|railway|rail|airport|bridge|dam|hydropower|nuclear|reactor|grid|substation|battery|storage|warehouse|truck|trucks|freight|cargo|drone|drones|missile|attack|strike|strikes|sanctions|tariff|tariffs|export|exports|import|imports|harvest|drought|flood|storm|hurricane|typhoon|wildfire|protest|pulse|pulses|lentil|lentils|chickpea|chickpeas|grain|grains|palm|cotton|cattle|beef|pork|dairy|fish|timber|cement|nickel|cobalt|uranium|bauxite|potash|urea|ethanol|biofuel|fuel|jet|bunker|chemical|chemicals|plastics|semiconductor|chips|car|cars|auto|automotive|train|highway|road|tunnel|pier|quay|dock|crane|cranes|barge|barges|bulk|bulker|carrier|carriers|factory|plant|plants|warship|navy|convoy)$/;

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// country names (+ demonyms-free short forms) always count as names, even at the start of a sentence
const REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRIES = new Set();
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { try { const n = REGIONS.of(String.fromCharCode(a, b)); if (n && !/^[A-Z]{2}$/.test(n)) COUNTRIES.add(n.toLowerCase()); } catch { /* not a region */ } }
for (const x of ['saudi', 'uae', 'emirates', 'korea', 'hormuz', 'suez', 'panama', 'red sea', 'gulf', 'europe', 'asia', 'africa']) COUNTRIES.add(x);

// Key words of a headline with weights: names (Aramco, Yanbu, East-West) 2, picture words (pipeline, tanker) 1.5, the rest 0.5.
// Headlines are often Title Case, so a name is a word that is also capitalised mid-sentence in the article text (context), or an acronym.
export function keyTerms(headline, context = '') {
  const words = clean(headline).replace(/[‘’“”"(),:;!?|]/g, ' ').split(' ').filter(Boolean);
  const names = new Set();
  for (const sent of clean(context).split(/(?<=[.!?])\s+/)) {
    sent.split(' ').slice(1).forEach((x) => { const w = x.replace(/^[^A-Za-z]+|[^A-Za-z-]+$/g, '').replace(/[’']s$/, ''); if (/^[A-Z]/.test(w)) names.add(w.toLowerCase()); });
  }
  const caps = words.filter((w) => w.length > 3 && /^[A-Z]/.test(w)).length / Math.max(1, words.filter((w) => w.length > 3).length);
  const titleCase = caps > 0.6;
  const out = new Map();
  words.forEach((raw, i) => {
    const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').replace(/[’']s$/, '');
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP.has(lw) || /^\d+$/.test(lw)) return;
    const acronym = /^[A-Z]{2,}[a-z]?$/.test(w) || /[A-Z].*[A-Z]/.test(w.slice(1));
    const proper = !THINGS.test(lw) && (acronym || names.has(lw) || COUNTRIES.has(lw) || (/^[A-Z]/.test(w) && (/-/.test(w) || (!titleCase && i > 0) || (titleCase && !context && i > 0))));
    const weight = proper ? 2 : THINGS.test(lw) ? 1.5 : 0.5;
    out.set(lw, Math.max(out.get(lw) || 0, weight));
  });
  return [...out].map(([w, weight]) => ({ w, weight }));
}

const norm = (s) => ' ' + (s || '').toLowerCase().replace(/%20|[_+]/g, ' ').replace(/[^a-z0-9]+/g, ' ') + ' ';
// share of the headline's key-word weight that appears in text (0..1). "east-west" matches "east west" / "eastwest".
export function relevance(text, terms) {
  const t = norm(text), squashed = t.replace(/ /g, '');
  let got = 0, all = 0;
  for (const { w, weight } of terms) {
    all += weight;
    const n = norm(w).trim();
    if (!n) continue;
    if (t.includes(' ' + n + ' ') || t.includes(' ' + n + 's ') || (n.includes(' ') && squashed.includes(n.replace(/ /g, '')))) got += weight;
  }
  return all ? got / all : 0;
}

export function searchQuery(terms) {
  const strong = [...terms].sort((a, b) => b.weight - a.weight).filter((t) => t.weight >= 1.5).slice(0, 6);
  const extra = strong.length >= 3 ? [] : terms.filter((t) => t.weight < 1.5).slice(0, 3 - strong.length);   // short headline: add the next words in order
  return [...strong, ...extra].map((t) => t.w).join(' ');
}

// hosts whose pictures are screenshots / thumbnails with text, watermarked stock, or social posts
const SKIP_HOST = /(^|\.)(linkedin\.com|licdn\.com|x\.com|twitter\.com|twimg\.com|facebook\.com|fbcdn\.net|instagram\.com|pinterest\.[a-z.]+|pinimg\.com|youtube\.com|ytimg\.com|tiktok\.com|reddit\.com|redd\.it|threadreaderapp\.com|gettyimages\.[a-z.]+|shutterstock\.com|alamy\.com|istockphoto\.com|dreamstime\.com|123rf\.com|depositphotos\.com|stock\.adobe\.com|adobestock\.com|freepik\.com|vecteezy\.com|worldtradepro\.com|scribd\.com|slideshare\.net|researchgate\.net|wikipedia\.org)$/i;
const DATA_HOST = /(statista|indexbox|chartforest|tradingeconomics|ceicdata|macrotrends|ycharts|visualcapitalist|ourworldindata|worldbank|imf\.org|oec\.world|tridge|volza|zauba|seair|exportgenius|marketresearch|mordorintelligence|researchandmarkets|slideshare|scribd)/i;
const BAD_URL = /logo|favicon|sprite|avatar|icon|placeholder|banner|\.svg(\?|$)|\.gif(\?|$)/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Other outlets' articles on the same story (Bing News RSS - plain HTTP; Bing IMAGES serves junk to GitHub's data-centre IPs,
// checked 2026-09-26), each with its own lead photo (og:image). Returns [{ url, page, title, date }].
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const unxml = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
async function getText(url, ms = 15000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml' }, redirect: 'follow', signal: ac.signal }); return r.ok ? { url: r.url, text: await r.text() } : null; }
  catch { return null; } finally { clearTimeout(t); }
}
export async function newsArticles(query, log = () => {}) {
  const rss = await getText('https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss&mkt=en-US');
  if (!rss) { log('Bing News RSS unreachable'); return []; }
  return [...rss.text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (n) => unxml((m[1].match(new RegExp('<' + n + '>([\\s\\S]*?)</' + n + '>')) || [])[1]);
    let link = tag('link'); try { const u = new URL(link).searchParams.get('url'); if (u) link = u; } catch { /* keep */ }
    return { title: tag('title'), link, date: tag('pubDate') };
  }).filter((x) => x.title && x.link);
}
async function ogImageOf(ctx, link) {
  // a real browser page: many news sites answer plain HTTP clients with 403
  const page = await ctx.newPage();
  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const m = (n) => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '';
      return { img: m('og:image') || m('og:image:url') || m('twitter:image'), page: location.href };
    });
    if (!r.img) return null;
    const img = new URL(r.img, r.page);
    // MSN re-publishes with small thumbnails (w=688&h=500): its image server resizes on request
    if (/msn\.com$|akamaized\.net$/.test(img.hostname) && img.searchParams.get('w')) {
      const w = +img.searchParams.get('w'), h = +img.searchParams.get('h') || 0;
      if (w && w < 1200) { img.searchParams.set('w', '1200'); if (h) img.searchParams.set('h', String(Math.round(h * 1200 / w))); }
    }
    return { img: img.href, page: r.page };
  } catch { return null; } finally { await page.close().catch(() => {}); }
}

// Download + check one picture: real photo (not a flat logo), big enough, shape inside [minR, maxR] (width / height). Returns a JPEG buffer.
export let lastLoadFail = '';
export async function loadPhoto(ctx, url, referer, { minR = 1.0, maxR = 2.4, minW = 600, minH = 315 } = {}) {
  lastLoadFail = '';
  const rq = ctx.request;
  let body = null;
  try { const resp = await rq.get(url, { timeout: 15000, headers: referer ? { referer } : {} }); if (resp.ok()) body = await resp.body(); else lastLoadFail = 'HTTP ' + resp.status(); }
  catch (e) { lastLoadFail = 'download: ' + String(e.message).slice(0, 50); }
  if (!body) {   // some image servers refuse non-browser clients: open the picture in a real page instead
    const pg = await ctx.newPage();
    try { const r = await pg.goto(url, { timeout: 20000, referer }); if (r && r.ok()) body = await r.body(); else lastLoadFail = 'HTTP ' + (r ? r.status() : '?') + ' (browser)'; }
    catch (e) { lastLoadFail = 'browser download: ' + String(e.message).slice(0, 50); } finally { await pg.close().catch(() => {}); }
  }
  if (!body) return null;
  if (body.length < 20000) { lastLoadFail = 'small file ' + body.length; return null; }
  const head4 = body.subarray(0, 4).toString('hex');   // trust the magic bytes: some CDNs send application/octet-stream
  const mime = body[0] === 0xff && body[1] === 0xd8 ? 'image/jpeg' : head4 === '89504e47' ? 'image/png' : (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') ? 'image/webp' : '';
  if (!mime) { lastLoadFail = 'not jpeg/png/webp (' + body.subarray(0, 12).toString('hex') + ')'; return null; }
  const tmp = await ctx.newPage();
  try {
    const res = await tmp.evaluate(async ({ b64, mime, minR, maxR, minW, minH }) => {
      const img = new Image(); img.src = 'data:' + mime + ';base64,' + b64;
      try { await img.decode(); } catch { return null; }
      const w = img.naturalWidth, h = img.naturalHeight, r = w / h;
      if (w < minW || h < minH || r < minR || r > maxR) return { ok: false, why: `shape ${w}x${h}` };
      const k = document.createElement('canvas'); k.width = 64; k.height = 36;
      const kg = k.getContext('2d'); kg.drawImage(img, 0, 0, 64, 36);
      const d = kg.getImageData(0, 0, 64, 36).data, seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
      if (seen.size < 45) return { ok: false, why: 'flat graphic' };   // few colours = a logo / text banner, not a photo
      let white = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232) white++;
      if (white / (d.length / 4) > 0.3) return { ok: false, why: 'mostly white (chart / infographic / cut-out)' };   // few colours = a logo / text banner, not a photo
      const s = Math.min(1, 1600 / Math.max(w, h)), c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      return { ok: true, w: c.width, h: c.height, data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
    }, { b64: body.toString('base64'), mime, minR, maxR, minW, minH });
    if (!res || !res.ok) lastLoadFail = res?.why || 'decode failed';
    return res && res.ok ? { url, w: res.w, h: res.h, jpeg: Buffer.from(res.data, 'base64'), mime } : null;
  } finally { await tmp.close().catch(() => {}); }
}

export const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

// lead = { photo (from loadPhoto), alt } or null; seen(url, jpeg) -> truthy when the picture was used recently.
// Returns { url, jpeg, w, h, mime, credit, source: 'article'|'search', score, note } or null (caller falls back to Unsplash / own card).
export async function bestImage(ctx, { headline, context = '', articleUrl, lead, seen = () => false, minScore = 0.62 }, log = () => {}) {
  const terms = keyTerms(headline, context);
  const cands = [];
  if (lead && lead.photo && !seen(lead.photo.url, lead.photo.jpeg)) {
    // the editor chose it for this story, but many outlets use file photos: without a caption it only beats weak search results
    const r = lead.alt ? relevance(lead.alt, terms) : 0;
    cands.push({ kind: 'article', score: 0.5 + 0.5 * r, photo: lead.photo, host: hostOf(articleUrl), note: `article photo (caption match ${r.toFixed(2)})` });
  }
  const names = terms.filter((t) => t.weight >= 2);
  const hasName = (title) => !names.length || relevance(title, names) > 0;
  const q = searchQuery(terms);
  if (q.split(' ').length >= 2) {
    const since = Date.now() - 21 * 864e5;   // older coverage is another event ("2019 attack"), not this one
    const own = hostOf(articleUrl);
    const rows = (await newsArticles(q, log)).map((m, i) => ({ ...m, i, r: relevance(m.title, terms) }))
      .filter((m) => (!m.date || Date.parse(m.date) >= since) && ((m.r >= 0.35 && hasName(m.title)) || m.r >= 0.55))   // same story: a shared name (East-West, Yanbu) + enough key words, or most key words
      .sort((a, b) => b.r - a.r || a.i - b.i).slice(0, 8);
    if (!rows.length) log('no matching news articles for "' + q + '"');
    for (const m of rows.slice(0, 5)) {
      const og = await ogImageOf(ctx, m.link);
      if (!og) { log('  no og:image: ' + m.link.slice(0, 80)); continue; }
      const host = hostOf(og.page), ihost = hostOf(og.img);
      if (!host || host === own || SKIP_HOST.test(host) || SKIP_HOST.test(ihost) || DATA_HOST.test(host) || BAD_URL.test(og.img)) { log('  skipped host/url: ' + host + ' ' + og.img.slice(-50)); continue; }
      // another outlet's photo of the SAME story beats a caption-less file photo
      cands.push({ kind: 'search', score: 0.55 + 0.45 * m.r - 0.01 * m.i, url: og.img, page: og.page, host, title: m.title, note: `news photo "${q}" #${m.i + 1} match ${m.r.toFixed(2)} "${m.title.slice(0, 60)}"` });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 10)) {
    if (c.kind === 'search' && c.score < minScore) continue;   // a search result must be clearly on topic to replace the article's own photo
    if (c.kind === 'article') return { ...c.photo, credit: c.host, source: 'article', score: c.score, note: c.note };
    if (seen(c.url)) continue;
    const ph = await loadPhoto(ctx, c.url, c.page, { minR: 0.75, maxR: 2.1, minW: 700, minH: 450 });
    if (!ph) { log('  image skipped (' + lastLoadFail + '): ' + c.note + ' ' + c.url.slice(-60)); continue; }
    if (seen(c.url, ph.jpeg)) continue;
    return { ...ph, credit: c.host, pageUrl: c.page, source: 'search', score: c.score, note: c.note };
  }
  return null;
}
