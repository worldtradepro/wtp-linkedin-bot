// Official project photo (owner 2026-10-24): like Hydrogen Insight ("Photo: OMV"), an Infrastructure project post may show the picture that
// a party of the project (owner, contractor, financier) published itself on its OWN website, unedited, credited "Photo: <company>".
// Nothing from news sites, even when the picture was originally a company handout. No usable official picture -> the caller draws the fact card.
// Rules:
//   - the page is on the party's official domain (host label = company name / its acronym), never a news or aggregator site;
//   - the picture is that page's own share image (og:image), not the site-wide default banner;
//   - companies whose media terms forbid re-use (RED list in linkedin_video/photo_whitelist.md, checked 2026-09-27) are skipped;
//   - the usual photo checks (real photo, landscape, big enough, no text baked in) from image_search.mjs loadPhoto.
import { loadPhoto } from './image_search.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// RED: media terms require a written request, or no public media library (photo_whitelist.md). Rio Tinto forbids crops / text: treated as RED.
const RED = /exxon|totalenergies|\badnoc\b|qatarenergy|petronas|^bp\b|\bbp (plc|p\.l\.c)|larsen|\bl ?& ?t\b|saipem|samsung|mcdermott|\bkbr\b|worley|hyundai|doosan|dangote|acwa|masdar|technipfmc|\bedf\b|ge vernova|maersk|cma cgm|cosco|\bbhp\b|glencore|dp world|trafigura|vitol|golar|rio tinto/i;
const LEGAL = /\b(ltd|limited|plc|inc|co|corp|corporation|company|group|holdings?|s\.?a|ag|se|spa|s\.p\.a|n\.?v|b\.?v|gmbh|llc|berhad|bhd|jsc|pjsc|asa|ab|oyj|pte|pty|sarl|srl|as|a\/s|kk|k\.k)\b\.?/gi;
// first words that say nothing about which company it is ("China National Chemical ..." must not match china.com)
const GENERIC = /^(china|chinese|national|saudi|arabian|international|global|general|united|new|green|energy|power|group|first|the|state|public|royal|central|eastern|western|northern|southern|asia|africa|europe|american|indian|japan|korea|gulf|middle)$/i;
// host labels that are never a company's own site
const NEWSY = /news|times|journal|review|magazine|insight|daily|post|wire|report|today|herald|tribune|gazette|online|world|business|market|monitor|digest|media|press|tv|radio/i;
const TLDISH = /^(www|com|co|org|net|gov|edu|ac|int|biz|info|[a-z]{2})$/i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// "China National Chemical Engineering (CNCEC)" -> { credit: 'CNCEC', keys: ['cncec', 'chinanationalchemicalengineering', ...] }
export function companyKeys(name) {
  const paren = (/\(([A-Za-z0-9&.\- ]{2,12})\)/.exec(name) || [])[1];
  const shown = name.replace(/\([^)]*\)/g, ' ').replace(LEGAL, ' ').replace(/[\s,.]+$/g, '').replace(/\s+/g, ' ').trim();   // credit keeps accents: "Höegh Evi"
  const base = shown.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();   // keys: hoegh
  const words = base.split(' ').filter(Boolean);
  const keys = new Set();
  if (paren) keys.add(paren.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (words.length) keys.add(words.join('').toLowerCase().replace(/&/g, ''));
  if (words.length >= 2) keys.add(words.map((w) => w[0]).join('').toLowerCase());   // initials: China Tianchen Engineering -> cte
  if (words[0] && words[0].length >= 4 && !GENERIC.test(words[0])) keys.add(words[0].toLowerCase());
  if (words.length >= 2 && !GENERIC.test(words[0])) keys.add((words[0] + words[1]).toLowerCase());
  return { credit: paren && paren.length <= 8 ? paren : shown || name, keys: [...keys].filter((k) => k.length >= 3) };
}
// The party whose official site this host is, or null. omv.com, group.vattenfall.com, engie.com.au, investors.kbr.com
export function officialParty(host, parties) {
  const labels = host.split('.').filter((l) => !TLDISH.test(l));
  if (!labels.length || labels.some((l) => NEWSY.test(l) && labels.length === 1)) return null;
  for (const p of parties) {
    if (!p.name || RED.test(p.name)) continue;
    const { keys, credit } = companyKeys(p.name);
    if (labels.some((l) => keys.some((k) => l.replace(/-/g, '') === k || (k.length >= 5 && l.replace(/-/g, '').startsWith(k) && l.length <= k.length + 6)))) return { ...p, credit };
  }
  return null;
}

async function ogImage(ctx, url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(800);
    return await page.evaluate(() => {
      const m = (n) => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '';
      const img = m('og:image') || m('og:image:url') || m('twitter:image');
      return { img: img ? new URL(img, location.href).href : '', page: location.href, title: document.title || '' };
    });
  } catch { return null; } finally { await page.close().catch(() => {}); }
}
// 2026-11-06: two site graphics got through as "project photos" - princetondg.com Web-Banner_800x450.jpg (a blurred green swirl for a green-loan
// post) and virya-energy.com Open_Graph_Image_1200x630 (logo + slogan on solar panels, for a wind farm). Both are site/brand graphics, not the project.
export const BANNER_NAME = /banner|open[\s_-]?graph|og[\s_-]?image|social[\s_-]?(share|image)|share[\s_-]?image|logo|placeholder|default|background|hero[\s_-]?bg|pattern|texture|wallpaper/i;
// Mean brightness change between neighbouring pixels (x100, at 96x54): real scenes measured 3.3-6.6, the blurred banner 1.16.
export const MIN_DETAIL = 2;
export async function detailOf(ctx, jpeg) {
  const page = await ctx.newPage();
  try {
    return await page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
      const W = 96, H = 54, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data, L = [];
      for (let i = 0; i < d.length; i += 4) L.push((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255);
      let e = 0;
      for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) e += Math.abs(L[y * W + x] - L[y * W + x - 1]);
      for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) e += Math.abs(L[y * W + x] - L[(y - 1) * W + x]);
      return +((e / (W * H * 2)) * 100).toFixed(2);
    }, jpeg.toString('base64'));
  } catch { return 99; } finally { await page.close().catch(() => {}); }   // measuring failed: do not block on it
}
// A company's own site can carry a picture it licensed from a stock library (drax.com AdobeStock_1107050519, 2026-11-04): that licence covers the
// company, not us. Skip it when the file name or the picture's embedded IPTC / XMP rights text names a stock library.
export const STOCK = /adobe ?stock|shutterstock|getty ?images|istock|alamy|dreamstime|123rf|depositphotos|bigstock|envato|stocksy|pond5/i;
async function stockMark(ctx, url) {
  if (STOCK.test(decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || ''))) return 'file name';
  try { const r = await ctx.request.get(url, { timeout: 15000 }); if (r.ok()) { const head = (await r.body()).subarray(0, 196608).toString('latin1'); const m = STOCK.exec(head); if (m) return 'embedded rights text (' + m[0] + ')'; } } catch { /* the photo check downloads it again */ }
  return '';
}
async function homeImage(ctx, url) {   // the site-wide default share picture: never "this project's" photo
  try { const r = await ogImage(ctx, new URL(url).origin + '/'); return r?.img || ''; } catch { return ''; }
}
// Brave Search API (secret BRAVE_API_KEY, the key radar-enrich already uses): reliable from CI. DuckDuckGo without a key returned
// nothing at all after a few queries in the 2026-10-25 test, so it is only the fallback when no key is set.
async function brave(query) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(query), { headers: { accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }, signal: ac.signal });
    if (!r.ok) return [];
    return ((await r.json()).web?.results || []).map((x) => ({ url: x.url, title: x.title || '' }));
  } catch { return []; } finally { clearTimeout(t); }
}
const webSearch = (query) => (process.env.BRAVE_API_KEY ? brave(query) : ddg(query));
// one DuckDuckGo query (plain HTML endpoint, no key). Best effort: it rate-limits, and an empty answer just means "use the fact card".
async function ddg(query) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'user-agent': UA }, signal: ac.signal });
    if (!r.ok) return [];
    const html = await r.text();
    return [...html.matchAll(/result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
      let u = m[1].replace(/&amp;/g, '&'); const q = /[?&]uddg=([^&]+)/.exec(u); if (q) u = decodeURIComponent(q[1]);
      return { url: u, title: m[2].replace(/<[^>]+>/g, '').trim() };
    }).slice(0, 8);
  } catch { return []; } finally { clearTimeout(t); }
}
const STOPW = /^(project|projects|plant|phase|one|two|the|and|for|with|new|order|contract|epc|limited|company|expansion|development|construction|facility|scheme)$/i;
const projectTerms = (name, parties) => {
  const co = new Set(parties.flatMap((p) => p.name.toLowerCase().split(/[^a-z0-9]+/)));
  return [...new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPW.test(w) && !co.has(w)))];
};

// facts = fact_card.mjs factsOf(); seen(url, jpeg) -> truthy when used recently. Returns a loadPhoto() result + { credit, page, source: 'official', note } or null.
// Hard time limit: a page or picture download that never answers must not hold up the day's posts (a local test hung for hours, 2026-10-25).
export async function officialPhoto(ctx, facts, opts = {}, log = () => {}) {
  let timer;
  const limit = new Promise((res) => { timer = setTimeout(() => { log(`official photo lookup stopped after ${(opts.timeoutMs || 120000) / 1000} s`); res(null); }, opts.timeoutMs || 120000); });
  try { return await Promise.race([findOfficial(ctx, facts, opts, log), limit]); } finally { clearTimeout(timer); }
}
async function findOfficial(ctx, facts, { seen = () => false, search = true } = {}, log = () => {}) {
  const parties = facts.parties || [];
  if (!parties.length) return null;
  const tried = new Set();
  const attempt = async (url, needTerms) => {
    const host = hostOf(url);
    if (!host || tried.has(url) || /\.pdf(\?|$)/i.test(url)) return null;
    tried.add(url);
    const party = officialParty(host, parties);
    if (!party) return null;
    const og = await ogImage(ctx, url);
    if (!og?.img) { log(`official page ${host}: no share picture`); return null; }
    if (needTerms) {   // a search hit must be about this project, not just any page of the company
      const terms = projectTerms(facts.name, parties), hay = (og.title + ' ' + og.page).toLowerCase();
      if (terms.length && !terms.some((t) => hay.includes(t))) { log(`official page ${host}: not about "${facts.name}"`); return null; }
    }
    if (og.img === (await homeImage(ctx, og.page))) { log(`official page ${host}: only the site's default banner`); return null; }
    if (BANNER_NAME.test(decodeURIComponent(og.img.split(/[?#]/)[0].split('/').pop() || ''))) { log(`official picture on ${host}: a site banner / share graphic (file name)`); return null; }
    const stock = await stockMark(ctx, og.img);
    if (stock) { log(`official picture on ${host}: licensed stock photo (${stock})`); return null; }
    const ph = await loadPhoto(ctx, og.img, og.page);
    if (!ph) { log(`official picture on ${host} rejected`); return null; }
    const detail = await detailOf(ctx, ph.jpeg);
    if (detail < MIN_DETAIL) { log(`official picture on ${host}: abstract / blurred graphic (detail ${detail})`); return null; }
    if (seen(ph.url, ph.jpeg)) { log(`official picture on ${host} already used`); return null; }
    return { ...ph, credit: party.credit, page: og.page, source: 'official', note: `official photo (${party.role}: ${party.credit}, ${host})` };
  };
  for (const u of facts.links || []) { const r = await attempt(u, false); if (r) return r; }
  if (!search) return null;
  const who = parties.find((p) => p.role === 'owner' && !RED.test(p.name)) || parties.find((p) => !RED.test(p.name));
  if (!who) return null;
  const hits = await webSearch(`${companyKeys(who.name).credit} ${facts.name}`);
  log(`official photo search: ${hits.length} results`);
  for (const h of hits) { const r = await attempt(h.url, true); if (r) return r; }
  if (hits.length && !hits.some((h) => officialParty(hostOf(h.url), parties))) log(`search: ${hits.length} results, none on a project party's own website`);
  return null;
}
