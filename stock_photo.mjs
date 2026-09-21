// Stock photo for posts whose source article has no usable lead picture (instead of our own blue card).
// Unsplash API (free "demo" app = 50 requests/hour; we need ~1 per post). Needs env UNSPLASH_ACCESS_KEY - without it this module returns null
// and render.mjs falls back to the themed card. Unsplash API rules followed: hot-link the URL the API returns, ping `download_location`
// when a photo is used, credit the photographer + Unsplash (added to the post text by render.mjs).
//
// Selection is rule based (no AI): headline / sector keywords -> search queries -> first fresh landscape photo. Photos used in the
// last ~200 picks are remembered in state/stock_used.json so the feed does not repeat the same tanker.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state', 'stock_used.json');
const API = process.env.UNSPLASH_API_BASE || 'https://api.unsplash.com';   // override only for the local mock test
const KEY = process.env.UNSPLASH_ACCESS_KEY || '';
const UTM = 'utm_source=world_trade_pro&utm_medium=referral';

// first matching rule wins; each rule lists queries tried in order
const RULES = [
  [/\b(lng|liquefied natural gas|regasification)\b/i, ['lng carrier ship', 'natural gas terminal']],
  [/\b(oil|crude|brent|wti|opec|petroleum|refiner\w*|barrel)\b/i, ['oil tanker sea', 'oil refinery', 'offshore oil platform']],
  [/\b(pipeline|gas)\b/i, ['gas pipeline', 'natural gas plant']],
  [/\b(suez|panama|canal|strait|hormuz|red sea|bab el|houthi)\b/i, ['cargo ship strait', 'container ship ocean']],
  [/\b(container|teu|boxship|liner)\b/i, ['container ship', 'container terminal port']],
  [/\b(port|terminal|berth|harbou?r)\b/i, ['port cranes', 'shipping port aerial']],
  [/\b(bulk|capesize|panamax|iron ore|coal)\b/i, ['bulk carrier ship', 'coal mine']],
  [/\b(grain|wheat|corn|soy\w*|rice|fertili[sz]er|harvest|agri\w*)\b/i, ['wheat field harvest', 'grain silo']],
  [/\b(copper|gold|lithium|nickel|steel|alumin(?:i)?um|mining|mine)\b/i, ['mining excavator', 'open pit mine']],
  [/\b(solar|wind|renewable|hydrogen|battery|offshore wind)\b/i, ['wind turbines', 'solar farm']],
  [/\b(rail|train|truck|logistic\w*|freight|warehouse)\b/i, ['freight train', 'logistics warehouse']],
  [/\b(tariff|sanction\w*|customs|trade war)\b/i, ['cargo containers customs', 'international trade cargo']],
];
const SECTOR_FALLBACK = [
  [/ship|tanker|maritime|container/i, ['cargo ship ocean']],
  [/energy|oil|gas|lng|power/i, ['oil and gas industry']],
  [/metal|mining|mine/i, ['mining industry']],
  [/agri|food|grain/i, ['agriculture farm field']],
  [/logistic|infrastructure|transport|rail|port/i, ['port logistics']],
];

export function queriesFor({ headline = '', sector = '', subsector = '' }) {
  const out = [];
  const hay = `${headline} ${subsector}`;
  for (const [re, qs] of RULES) if (re.test(hay)) { out.push(...qs); break; }
  for (const [re, qs] of SECTOR_FALLBACK) if (re.test(sector)) { out.push(...qs); break; }
  out.push('global trade cargo ship');
  return [...new Set(out)];
}

function loadUsed() { try { return JSON.parse(readFileSync(STATE, 'utf8')).ids || []; } catch { return []; } }
function saveUsed(ids) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ids: ids.slice(-200) }, null, 2));
}
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const headers = () => ({ Authorization: 'Client-ID ' + KEY, 'Accept-Version': 'v1' });

// -> { jpeg: Buffer, url, credit, query, photoId, w, h } | null
export async function stockPhoto(post, log = () => {}) {
  if (!KEY) { log('no UNSPLASH_ACCESS_KEY: stock photo skipped'); return null; }
  const used = new Set(loadUsed());
  for (const query of queriesFor(post)) {
    let data;
    try {
      const r = await fetch(`${API}/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high&per_page=30`, { headers: headers() });
      if (r.status === 403 || r.status === 429) { log('Unsplash rate limit / key rejected (' + r.status + ')'); return null; }
      if (!r.ok) { log('Unsplash search failed ' + r.status); continue; }
      data = await r.json();
    } catch (e) { log('Unsplash unreachable: ' + String(e.message || e).slice(0, 60)); return null; }
    const fresh = (data.results || []).filter((p) => !used.has(p.id) && p.width >= 1600 && p.width / p.height >= 1.3 && p.width / p.height <= 2.1);
    if (!fresh.length) continue;
    const top = fresh.slice(0, 12);
    const pick = top[hash(post.id + new Date().toISOString().slice(0, 10)) % top.length];
    // 1600px wide JPEG, served by Unsplash's own CDN (this exact URL is what Buffer / LinkedIn will fetch)
    const url = pick.urls.raw + (pick.urls.raw.includes('?') ? '&' : '?') + 'w=1600&fit=max&fm=jpg&q=85';
    let jpeg;
    try {
      const img = await fetch(url);
      if (!img.ok) continue;
      jpeg = Buffer.from(await img.arrayBuffer());
      if (jpeg.length < 20000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) continue;
    } catch { continue; }
    // Unsplash API rule: report the download when a photo is actually used
    if (pick.links?.download_location) fetch(pick.links.download_location, { headers: headers() }).catch(() => {});
    used.add(pick.id); saveUsed([...used]);
    const name = pick.user?.name || 'Unsplash photographer';
    // Unsplash API terms (section 9): credit Unsplash + the photographer AND link to the photographer's profile (with our utm tags)
    const profile = pick.user?.links?.html ? pick.user.links.html.split('?')[0] + '?' + UTM : `https://unsplash.com/?${UTM}`;
    return { jpeg, url, query, photoId: pick.id, w: pick.width, h: pick.height, credit: `📷 Photo: ${name} / Unsplash ➡️ ${profile}` };
  }
  return null;
}
