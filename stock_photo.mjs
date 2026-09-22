// Stock photo for posts whose source article has no usable lead picture (instead of our own blue card).
// Unsplash API (free "demo" app = 50 requests/hour; we need ~1 per post). Needs env UNSPLASH_ACCESS_KEY - without it this module returns null
// and render.mjs falls back to the themed card. Unsplash API rules followed: hot-link the URL the API returns, ping `download_location`
// when a photo is used, credit the photographer + Unsplash (added to the post text by render.mjs).
//
// Selection is rule based (no AI): headline / sector keywords -> search queries -> a photo. Unsplash's search is loose (a "lng carrier
// ship" search mostly returns generic oil tankers, since real LNG-carrier photos are rare there), so for each topic we first look for
// a photo whose OWN caption actually names the topic (e.g. contains "lng") - genuinely on-topic - and only settle for a same-query photo
// that merely LOOKS like a similar ship, then the sector fallback, then a fully generic cargo-ship shot, if nothing on-topic exists.
// Photos used in the last ~200 picks are remembered in state/stock_used.json so the feed does not repeat the same tanker.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'state', 'stock_used.json');
const API = process.env.UNSPLASH_API_BASE || 'https://api.unsplash.com';   // override only for the local mock test
const KEY = process.env.UNSPLASH_ACCESS_KEY || '';
const UTM = 'utm_source=world_trade_pro&utm_medium=referral';

// [topic regex (also used to require it in the PHOTO'S OWN caption for a confident match), queries to try, in order]
const RULES = [
  [/\b(lng|liquefied natural gas|regasification)\b/i, ['lng tanker', 'lng carrier ship', 'natural gas terminal']],
  [/\bairports?\b/i, ['airport runway', 'airport terminal building']],   // before the port/terminal rule below ("airport terminal" would otherwise match "terminal")
  [/\b(oil|crude|brent|wti|opec|petroleum|refiner\w*|barrel)\b/i, ['oil tanker', 'oil refinery', 'offshore oil platform']],
  [/\b(pipeline|gas)\b/i, ['gas pipeline', 'natural gas plant']],
  [/\bsuez\b/i, ['suez canal ship', 'cargo ship strait']],
  [/\bpanama\b/i, ['panama canal ship', 'cargo ship strait']],
  [/\b(hormuz|persian gulf|arabian gulf)\b/i, ['oil tanker gulf', 'cargo ship strait']],
  [/\b(red sea|bab el|houthi|mandeb)\b/i, ['cargo ship red sea', 'container ship ocean']],
  [/\b(strait|canal)\b/i, ['cargo ship strait', 'container ship ocean']],
  [/\b(container|teu|boxship|liner)\b/i, ['container ship', 'container terminal port']],
  [/\b(port|terminal|berth|harbou?r)\b/i, ['port cranes', 'shipping port aerial']],
  [/\b(highway|motorway|road construction|roads?\s*(&|and)?\s*transport)\b/i, ['highway construction', 'road construction']],
  [/\b(hydropower|pumped hydro|hydroelectric)\b/i, ['hydroelectric dam', 'hydropower plant']],
  // battery/BESS BEFORE the "Power & Transmission" rule below: that is the subsector bucket's own generic name
  // (real data files battery-storage projects under it too), so it would otherwise always outrank "battery" in the headline.
  [/\b(battery storage|bess|energy storage|battery)\b/i, ['battery storage facility', 'battery energy storage system']],
  [/\b(substation|transmission line|power grid|power\s*(&|and)?\s*transmission|electricity grid)\b/i, ['power transmission lines', 'electricity pylon']],
  [/\b(fertili[sz]er|urea|ammonia)\b/i, ['fertilizer plant', 'chemical plant']],
  [/\b(smelt(?:er|ing)|furnace|dri|direct reduced iron)\b/i, ['steel mill furnace', 'metal smelting plant']],
  [/\b(desalination|irrigation|water treatment|reservoir)\b/i, ['water treatment plant', 'irrigation canal']],
  [/\b(bulk|capesize|panamax|iron ore|coal)\b/i, ['bulk carrier ship', 'coal mine']],
  [/\b(grain|wheat|corn|soy\w*|rice|harvest|agri\w*)\b/i, ['wheat field harvest', 'grain silo']],
  [/\b(copper|gold|lithium|nickel|steel|alumin(?:i)?um|mining|mine)\b/i, ['mining excavator', 'open pit mine']],
  [/\b(solar|wind|renewable|hydrogen|offshore wind)\b/i, ['wind turbines', 'solar farm']],   // "battery"/"ammonia"/"fertilizer" moved to their own rules above (a battery-storage or fertiliser-plant story got a wind-turbine photo otherwise)
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
const GENERIC = 'global trade cargo ship';

// Ordered attempts: [{ queries, filter }], filter = null means "any photo of the right shape", a regex means "must be
// named as such in the photo's own caption". The topic rule is tried confidently-filtered first, then relaxed.
function plan({ headline = '', sector = '', subsector = '' }) {
  const hay = `${headline} ${subsector}`;
  const steps = [];
  const topic = RULES.find(([re]) => re.test(hay));
  if (topic) { steps.push({ queries: topic[1], filter: topic[0] }); steps.push({ queries: topic[1], filter: null }); }
  const sec = SECTOR_FALLBACK.find(([re]) => re.test(sector));
  if (sec) steps.push({ queries: sec[1], filter: null });
  steps.push({ queries: [GENERIC], filter: null });
  return steps;
}
export function queriesFor(post) { return [...new Set(plan(post).flatMap((s) => s.queries))]; }   // kept for logging/diagnostics

function loadUsed() { try { return JSON.parse(readFileSync(STATE, 'utf8')).ids || []; } catch { return []; } }
function saveUsed(ids) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ids: ids.slice(-200) }, null, 2));
}
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const headers = () => ({ Authorization: 'Client-ID ' + KEY, 'Accept-Version': 'v1' });
const captionOf = (p) => `${p.description || ''} ${p.alt_description || ''}`;

// -> { jpeg: Buffer, url, credit, query, photoId, w, h } | null
export async function stockPhoto(post, log = () => {}) {
  if (!KEY) { log('no UNSPLASH_ACCESS_KEY: stock photo skipped'); return null; }
  const used = new Set(loadUsed());
  const searched = new Map();   // query -> raw results (a query repeated across steps is only fetched once)
  for (const step of plan(post)) {
    let candidates = [];
    for (const query of step.queries) {
      if (!searched.has(query)) {
        let data;
        try {
          const r = await fetch(`${API}/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high&per_page=30`, { headers: headers() });
          if (r.status === 403 || r.status === 429) { log('Unsplash rate limit / key rejected (' + r.status + ')'); return null; }
          data = r.ok ? await r.json() : { results: [] };
          if (!r.ok) log('Unsplash search failed ' + r.status + ' for "' + query + '"');
        } catch (e) { log('Unsplash unreachable: ' + String(e.message || e).slice(0, 60)); return null; }
        searched.set(query, (data.results || []).map((p) => ({ ...p, __query: query })));
      }
      candidates.push(...searched.get(query));
    }
    let fresh = candidates.filter((p) => !used.has(p.id) && p.width >= 1600 && p.width / p.height >= 1.3 && p.width / p.height <= 2.1);
    if (step.filter) fresh = fresh.filter((p) => step.filter.test(captionOf(p)));
    if (!fresh.length) continue;
    const top = fresh.slice(0, 12);
    const pick = top[hash(post.id + new Date().toISOString().slice(0, 10)) % top.length];
    log((step.filter ? 'on-topic match' : 'same-query, untitled') + ' for "' + pick.__query + '": ' + (captionOf(pick).trim() || '(no caption)'));
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
    return { jpeg, url, query: pick.__query, photoId: pick.id, w: pick.width, h: pick.height, credit: `📷 Photo: ${name} / Unsplash ➡️ ${profile}` };
  }
  return null;
}
