// Shared data helpers for the WTP bots (LinkedIn daily queue, weekly newsletter).
// Trade lanes: keep in sync with TRADE_LANES in the site's map snippet (id 51) and wtp_lane_defs() in snippet 38.

export const dayShift = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

export async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1200 * (i + 1)));  // the shared host sometimes answers a burst with a transient 503
    }
  }
}

// ---------------------------------------------------------------- lookups
export const ISO = { 'United States':'US','USA':'US','US':'US','China':'CN','India':'IN','Iran':'IR','Yemen':'YE','Saudi Arabia':'SA','Qatar':'QA','United Arab Emirates':'AE','UAE':'AE','Oman':'OM','Kuwait':'KW','Iraq':'IQ','Egypt':'EG','Israel':'IL','Turkey':'TR','Russia':'RU','Ukraine':'UA','Japan':'JP','South Korea':'KR','Korea':'KR','Taiwan':'TW','Singapore':'SG','Malaysia':'MY','Indonesia':'ID','Vietnam':'VN','Thailand':'TH','Philippines':'PH','Australia':'AU','New Zealand':'NZ','United Kingdom':'GB','UK':'GB','Germany':'DE','France':'FR','Italy':'IT','Spain':'ES','Netherlands':'NL','Norway':'NO','Denmark':'DK','Poland':'PL','Greece':'GR','Brazil':'BR','Argentina':'AR','Chile':'CL','Mexico':'MX','Canada':'CA','Panama':'PA','Colombia':'CO','Peru':'PE','South Africa':'ZA','Nigeria':'NG','Kenya':'KE','Ethiopia':'ET','Morocco':'MA','Algeria':'DZ','Mozambique':'MZ','Tanzania':'TZ','Ghana':'GH','Angola':'AO','Senegal':'SN','Pakistan':'PK','Bangladesh':'BD','Sri Lanka':'LK','Kazakhstan':'KZ','Uzbekistan':'UZ','Cyprus':'CY','Romania':'RO' };
export const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
// Infrastructure items carry ISO-2 codes (RO, SA) while Trade Flow items carry names: normalise both.
export const isoOf = (c) => { const s = (c || '').trim(); return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : (ISO[s] || ''); };
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
