// Shared data helpers for the WTP bots (LinkedIn daily queue, weekly newsletter).
// Trade lanes: keep in sync with TRADE_LANES in the site's map snippet (id 51) and wtp_lane_defs() in snippet 38.

// The site sits behind Cloudflare, which sometimes answers a datacentre IP (GitHub runner) with a 403/503 challenge page.
// siteFetch retries those with backoff and adds the x-wtp-bot header when WTP_CF_BYPASS is set (the owner's Cloudflare custom rule "Allow LinkedIn bot"
// skips the challenge for requests carrying it). Every bot call to worldtradepro.com should go through this.
export async function siteFetch(url, init = {}, tries = 5) {
  const headers = { 'user-agent': 'wtp-linkedin-bot/1.0 (+https://worldtradepro.com)', ...(process.env.WTP_CF_BYPASS ? { 'x-wtp-bot': process.env.WTP_CF_BYPASS } : {}), ...(init.headers || {}) };
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers });
      if (![403, 429, 503, 520, 521, 522, 523, 524].includes(r.status)) return r;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) { last = e; }
    if (i < tries) { const wait = 8000 * i; console.log(`site ${init.method || 'GET'} ${new URL(url).pathname}: ${last.message} - retry ${i}/${tries - 1} in ${wait / 1000}s`); await new Promise((r) => setTimeout(r, wait)); }
  }
  throw last;
}
export const dayShift = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

// The shared host sometimes answers with a transient 503 or an HTML error/challenge page instead of JSON
// (2026-09-26 08:33 UTC run died that way). Back off 5s, 15s, 45s, 90s (~2.5 min) before giving up.
export async function fetchJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0', accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      try { return JSON.parse(body); } catch { throw new Error('not JSON (HTTP ' + r.status + '): ' + body.slice(0, 80).replace(/\s+/g, ' ')); }
    } catch (e) {
      if (i === tries - 1) throw e;
      const wait = [5, 15, 45, 90][i] || 90;
      console.warn(`fetchJson: ${e.message} - retry ${i + 1}/${tries - 1} in ${wait}s`);
      await new Promise((res) => setTimeout(res, wait * 1000));
    }
  }
}

// ---------------------------------------------------------------- lookups
export const ISO = { 'United States':'US','USA':'US','US':'US','China':'CN','India':'IN','Iran':'IR','Yemen':'YE','Saudi Arabia':'SA','Qatar':'QA','United Arab Emirates':'AE','UAE':'AE','Oman':'OM','Kuwait':'KW','Iraq':'IQ','Egypt':'EG','Israel':'IL','Turkey':'TR','Russia':'RU','Ukraine':'UA','Japan':'JP','South Korea':'KR','Korea':'KR','Taiwan':'TW','Singapore':'SG','Malaysia':'MY','Indonesia':'ID','Vietnam':'VN','Thailand':'TH','Philippines':'PH','Australia':'AU','New Zealand':'NZ','United Kingdom':'GB','UK':'GB','Germany':'DE','France':'FR','Italy':'IT','Spain':'ES','Netherlands':'NL','Norway':'NO','Denmark':'DK','Poland':'PL','Greece':'GR','Brazil':'BR','Argentina':'AR','Chile':'CL','Mexico':'MX','Canada':'CA','Panama':'PA','Colombia':'CO','Peru':'PE','South Africa':'ZA','Nigeria':'NG','Kenya':'KE','Ethiopia':'ET','Morocco':'MA','Algeria':'DZ','Mozambique':'MZ','Tanzania':'TZ','Ghana':'GH','Angola':'AO','Senegal':'SN','Pakistan':'PK','Bangladesh':'BD','Sri Lanka':'LK','Kazakhstan':'KZ','Uzbekistan':'UZ','Cyprus':'CY','Romania':'RO' };
export const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
// Infrastructure items carry ISO-2 codes (RO, SA) while Trade Flow items carry names: normalise both.
// every English country name Intl knows -> ISO-2, for names missing from ISO above (Cameroon, Mauritania ...)
const NAME_TO_ISO = (() => { const m = {}; for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) { const c = String.fromCharCode(a, b); try { const n = regionNames.of(c); if (n && n !== c) m[n.toLowerCase()] = c; } catch {} } return m; })();
export const isoOf = (c) => { const s = (c || '').trim(); return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : (ISO[s] || NAME_TO_ISO[s.toLowerCase()] || ''); };
export const flagOf = (c) => { const i = isoOf(c); return i ? String.fromCodePoint(0x1F1E6 + i.charCodeAt(0) - 65, 0x1F1E6 + i.charCodeAt(1) - 65) : ''; };
export const countryName = (c) => { const s = (c || '').trim(); if (/^[A-Za-z]{2}$/.test(s)) { try { return regionNames.of(s.toUpperCase()) || s; } catch { return s; } } return s; };

export const SECTOR_EMOJI = { Shipping: '\u{1F6A2}', Energy: '⚡', Metals: '⛏️', 'Mining & Metals': '⛏️', Agriculture: '\u{1F33E}', Policy: '\u{1F4DC}', 'Logistics & Infrastructure': '\u{1F3D7}️' };
export const emojiOf = (s) => SECTOR_EMOJI[s] || '\u{1F4CC}';

// Trade lanes: keep in sync with TRADE_LANES in the site's map snippet (id 51) and wtp_lane_defs() in snippet 38.
export const LANES = [
  { id: 'hormuz', name: 'Strait of Hormuz', flow: 'Gulf crude, LNG & products → Asia', tag: 'Hormuz', re: /\b(strait of hormuz|hormuz|persian gulf|arabian gulf|gulf of oman)\b/i },
  { id: 'malacca', name: 'Strait of Malacca', flow: 'Indian Ocean → East Asia', tag: 'Malacca', re: /\b(malacca|strait of singapore|singapore strait)\b/i },
  { id: 'scs', name: 'South China Sea / Taiwan Strait', flow: 'Singapore → China, Japan & Korea', tag: 'SouthChinaSea', re: /\b(south china sea|taiwan strait|spratly|paracel)\b/i },
  { id: 'adenbab', name: 'Gulf of Aden / Bab el-Mandeb', flow: 'Arabian Sea → Red Sea (Asia → Europe)', tag: 'RedSea', re: /\b(bab[ -]el[ -]mandeb|bab al[ -]mandab|gulf of aden|perim|houthis?)\b/i },
  { id: 'redsuez', name: 'Red Sea & Suez Canal', flow: 'Asia → Mediterranean & Europe', tag: 'SuezCanal', re: /\b(red sea|suez( canal)?)\b/i },
  { id: 'med', name: 'Mediterranean, Gibraltar & N. Europe', flow: 'Suez → Rotterdam', tag: 'Mediterranean', re: /\b(mediterranean|gibraltar|strait of sicily|english channel|dover strait)\b/i },
  { id: 'blacksea', name: 'Black Sea & Turkish Straits', flow: 'Black Sea grain, oil & metals → Mediterranean', tag: 'BlackSea', re: /\b(black sea|bosphorus|bosporus|dardanelles|turkish straits|odesa|odessa|novorossiysk)\b/i },
  { id: 'panama', name: 'Panama Canal', flow: 'Atlantic → Pacific (US Gulf LNG & grain → Asia)', tag: 'PanamaCanal', re: /\b(panama canal|panama)\b/i },
  { id: 'cape', name: 'Cape of Good Hope route', flow: 'Indian Ocean → Atlantic (Suez / Red Sea diversion)', tag: 'CapeRoute', re: /\b(cape of good hope|cape route|around the cape)\b/i },
];
// A signal is on a lane when the headline matches, or when headline + description mention it 2+ times.
export function laneOf(it) {
  for (const l of LANES) {
    const g = new RegExp(l.re.source, 'gi');
    const title = it.project_name || '', desc = it.description || '';
    if (l.re.test(title)) return l;
    if ((title.match(g) || []).length + (desc.match(g) || []).length >= 2) return l;
  }
  return null;
}

// ---------------------------------------------------------------- text helpers
export const clean = (s) => (s || '').replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The pipeline stores a description cut at 255 chars, often mid-sentence: keep only whole sentences.
export function summaryOf(desc, max) {
  const t = clean(desc);
  if (!t) return '';
  // split only at punctuation followed by a space, so "$1.3B" and "U.S." stay in one piece; drop a trailing fragment without end punctuation
  const sentences = t.split(/(?<=[.!?])(?<!\b[A-Z]\.)(?<!\b(?:Mr|Mrs|Dr|St|No|vs|Inc|Co|Corp|Ltd|Jr)\.)\s+/).filter((x) => /[.!?]$/.test(x));
  let out = '';
  for (const s of sentences) { if ((out + ' ' + s).trim().length > max) break; out = (out + ' ' + s).trim(); }
  return out;
}
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const STOP = new Set('the and for with from that this into over amid after their than have will says said its are was has new more your'.split(' '));
export const tokens = (s) => new Set(clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
export function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.5;   // overlap coefficient: catches "same story, different outlet"
}
export const score = (it) => parseInt(it.confidence, 10) || 0;

// ---------------------------------------------------------------- tenders & awards by industry
// (Daily Project Scan slides, EPC Project Leads Weekly e-mail). Industries in display order: the map's sectors, else "Other".
export const INDUSTRIES = ['Energy', 'Mining & Metals', 'Agriculture', 'Logistics & Infrastructure', 'Chemicals', 'Other'];
export const industryOf = (it) => (INDUSTRIES.includes(it.sector) ? it.sector : 'Other');
// public-service buys the upstream CPV/keyword rules let through: not commodity EPC leads for this audience
// ("railroad", "cross-border interconnector" must survive: whole words only)
export const NOT_EPC = /hospital|\bhealth\b|klinik|spital|\bclinic|\bschools?\b|\bpolice\b|politi(ei|a)\b|\bpatrol|coast ?guard|border (police|guard)|military|prison|\bhousing\b|\bstreets?\b|\broads?\b|\bbridges?\b|highway|motorway|detention|\bjail|immigration|weapons?|ammunition|missile/i;
export const money = (usd) => (!usd ? '' : usd >= 1e9 ? `US$${(usd / 1e9).toFixed(1)}bn` : usd >= 1e6 ? `US$${Math.round(usd / 1e6)}m` : `US$${Math.round(usd / 1e3)}k`);
const titleCase = (s) => (/[a-z]/.test(s) || s.length <= 5 ? s : s.toLowerCase().replace(/(^|[\s(\/&-])(\p{L})/gu, (m, a, c) => a + c.toUpperCase()));
// value, buyer and winner are only in the description the official-source modules write:
//   "EU open tender by BUYER (est. US$1,134.4M): TITLE" · "EU contract US$2,218.8M awarded to WINNER (Canada) by BUYER: TITLE"
//   "World Bank-financed contract US$8.8M awarded to WINNER (Türkiye): TITLE" · news items: company_name
const stageNo = (s) => parseInt(String(s || '').slice(1, 2), 10) || 0;   // 'S4-Tender' -> 4
export function dealOf(it) {
  const d = String(it.description || '');
  const m = /US\$([\d,.]+)\s*([MBK])?/i.exec(d);
  const usd = m ? parseFloat(m[1].replace(/,/g, '')) * ({ B: 1e9, M: 1e6, K: 1e3 }[(m[2] || '').toUpperCase()] || 1) : 0;
  // the winner is known only from an official award notice; a news item's company can be the owner or the contractor
  const winner = (/awarded to (.+?)(?: \([^)]*\))? by /.exec(d) || /awarded to (.+?)(?: \([^)]*\))?: /.exec(d) || [])[1] || '';
  // "(est. US$60M, deadline 2026-11-17)" / "(deadline 2026-11-17)" after the buyer
  const buyer = (/(?:tender|procurement|notice) by (.+?)(?: \([^()]*(?:est\.|deadline|US\$)[^()]*\))?: /.exec(d) || [])[1] || '';
  const dl = /deadline (\d{4}-\d{2}-\d{2})/.exec(d)?.[1] || '';
  const deadline = dl && dl >= it.report_date ? new Date(dl + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  // TED titles start with the CPV label and the buyer's file number: "Gas pipelines – 24/006 - The Provision of ..."
  const name = clean(it.project_name).replace(/^[^–]{3,45} – (?=.{15})/, '').replace(/^[\w./-]*\d[\w./-]*\s*[-/:]\s+/, '').replace(/^(construction work for|construction work|works for|supply of)\s*[–-]?\s*/i, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  const role = stageNo(it.stage) === 5 ? (winner ? 'winner' : '') : (buyer ? 'buyer' : '');
  const who = clean(stageNo(it.stage) === 5 ? winner || it.company_name : buyer || it.company_name).replace(/^(asociere|consorzio|consortium|groupement|ute|arge)\s*:?\s*/i, '');
  return { id: String(it.id), name, role, country: countryName(it.country), industry: industryOf(it), usd, value: money(usd), deadline,
    who: /^(n\/?a|unknown|none|-)$/i.test(who) ? '' : titleCase(who).replace(/\s+/g, ' ').slice(0, 70), date: it.report_date, url: it.source_url || '' };
}
