// Daily LinkedIn queue generator for World Trade Pro.
//
// Reads the site's PUBLIC API (no secrets needed), picks the day's posts for the two
// accounts, writes them as JSON + a readable preview under queue/YYYY-MM-DD/.
//   main  = "World Trade Pro"                 -> single Trade Flow news posts
//   infra = "World Trade Pro · Infrastructure" -> single project posts
// Single news / project posts carry the SOURCE LINK, so LinkedIn builds the preview from the
// article's own image. Own-artwork cards (daily flash, weekly summary) are a separate step.
//
// Usage:  node generate.mjs [--date YYYY-MM-DD] [--dry]
//   --dry  = print only, do not write files or update state/used.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const TODAY = dateArg || new Date().toISOString().slice(0, 10);
const API = cfg.site + '/wp-json/wtp/v1/opportunities';
const STATE_FILE = join(HERE, 'state', 'used.json');

const dayShift = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

async function fetchJson(url, tries = 3) {
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
const ISO = { 'United States':'US','USA':'US','US':'US','China':'CN','India':'IN','Iran':'IR','Yemen':'YE','Saudi Arabia':'SA','Qatar':'QA','United Arab Emirates':'AE','UAE':'AE','Oman':'OM','Kuwait':'KW','Iraq':'IQ','Egypt':'EG','Israel':'IL','Turkey':'TR','Russia':'RU','Ukraine':'UA','Japan':'JP','South Korea':'KR','Korea':'KR','Taiwan':'TW','Singapore':'SG','Malaysia':'MY','Indonesia':'ID','Vietnam':'VN','Thailand':'TH','Philippines':'PH','Australia':'AU','New Zealand':'NZ','United Kingdom':'GB','UK':'GB','Germany':'DE','France':'FR','Italy':'IT','Spain':'ES','Netherlands':'NL','Norway':'NO','Denmark':'DK','Poland':'PL','Greece':'GR','Brazil':'BR','Argentina':'AR','Chile':'CL','Mexico':'MX','Canada':'CA','Panama':'PA','Colombia':'CO','Peru':'PE','South Africa':'ZA','Nigeria':'NG','Kenya':'KE','Ethiopia':'ET','Morocco':'MA','Algeria':'DZ','Mozambique':'MZ','Tanzania':'TZ','Ghana':'GH','Angola':'AO','Senegal':'SN','Pakistan':'PK','Bangladesh':'BD','Sri Lanka':'LK','Kazakhstan':'KZ','Uzbekistan':'UZ','Cyprus':'CY','Romania':'RO' };
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
// Infrastructure items carry ISO-2 codes (RO, SA) while Trade Flow items carry names: normalise both.
const isoOf = (c) => { const s = (c || '').trim(); return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : (ISO[s] || ''); };
const flagOf = (c) => { const i = isoOf(c); return i ? String.fromCodePoint(0x1F1E6 + i.charCodeAt(0) - 65, 0x1F1E6 + i.charCodeAt(1) - 65) : ''; };
const countryName = (c) => { const s = (c || '').trim(); if (/^[A-Za-z]{2}$/.test(s)) { try { return regionNames.of(s.toUpperCase()) || s; } catch { return s; } } return s; };

const SECTOR_EMOJI = { Shipping: '\u{1F6A2}', Energy: '⚡', Metals: '⛏️', 'Mining & Metals': '⛏️', Agriculture: '\u{1F33E}', Policy: '\u{1F4DC}', 'Logistics & Infrastructure': '\u{1F3D7}️' };
const emojiOf = (s) => SECTOR_EMOJI[s] || '\u{1F4CC}';

// Trade lanes: keep in sync with TRADE_LANES in the site's map snippet (id 51) and wtp_lane_defs() in snippet 38.
const LANES = [
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
function laneOf(it) {
  for (const l of LANES) {
    const g = new RegExp(l.re.source, 'gi');
    const title = it.project_name || '', desc = it.description || '';
    if (l.re.test(title)) return l;
    if ((title.match(g) || []).length + (desc.match(g) || []).length >= 2) return l;
  }
  return null;
}

// ---------------------------------------------------------------- text helpers
const clean = (s) => (s || '').replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The pipeline stores a description cut at 255 chars, often mid-sentence: keep only whole sentences.
function summaryOf(desc, max) {
  const t = clean(desc);
  if (!t) return '';
  const sentences = t.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
  let out = '';
  for (const s of sentences) { if ((out + ' ' + s).trim().length > max) break; out = (out + ' ' + s).trim(); }
  return out;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const STOP = new Set('the and for with from that this into over amid after their than have will says said its are was has new more your'.split(' '));
const tokens = (s) => new Set(clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.5;   // overlap coefficient: catches "same story, different outlet"
}
const score = (it) => parseInt(it.confidence, 10) || 0;

const TIER_HINT = (n) => n >= 12 ? 'Likely to move prices or disrupt flows now' : (n >= 8 ? 'Material development worth tracking' : 'Background signal');

function whyNews(it) {
  const lane = laneOf(it);
  if (lane) return `Hits the ${lane.name} lane — ${lane.flow.replace(/\s*\(([^)]*)\)/, ', $1')}.`;
  return `${TIER_HINT(score(it))} — ${it.sector || 'trade'}${it.country ? ', ' + countryName(it.country) : ''}.`;
}
function newsTags(it) {
  const lane = laneOf(it);
  const t = [];
  const secTag = { Shipping: 'Shipping', Energy: 'Energy', Metals: 'Metals', Agriculture: 'Agriculture', Policy: 'TradePolicy' }[it.sector];
  if (secTag) t.push(secTag);
  if (lane) t.push(lane.tag);
  for (const x of ['SupplyChain', 'Commodities', 'TradeFlows']) if (t.length < 5) t.push(x);
  return t.slice(0, 5).map((x) => '#' + x).join(' ');
}

// ---------------------------------------------------------------- selection
function pickNews(items, n, minScore, used, blocked) {
  const cands = items
    .filter((it) => score(it) >= minScore && it.source_url && !used.has(it.source_url))
    .filter((it) => !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w)))
    .sort((a, b) => score(b) - score(a) || (b.report_date > a.report_date ? 1 : -1));
  const picks = [];
  const pass = (strict) => {
    for (const it of cands) {
      if (picks.length >= n) return;
      if (picks.includes(it)) continue;
      if (picks.some((p) => p.source_url === it.source_url || similar(p.project_name, it.project_name))) continue;
      const lane = laneOf(it);
      if (strict) {
        if (lane && picks.some((p) => laneOf(p)?.id === lane.id)) continue;             // one post per lane per day
        if (picks.filter((p) => p.sector === it.sector).length >= Math.ceil(n / 2)) continue; // spread across sectors
      }
      picks.push(it);
    }
  };
  pass(true); pass(false);
  return picks;
}

const STAGE_NOTE = {
  S1: 'earliest lead',
  S2: 'before tender',
  S3: 'nearing a decision',
  S4: 'in tender',
  S5: 'awarded — track the winner and subcontract openings',
};
const stageNote = (st) => STAGE_NOTE[(st || '').slice(0, 2)] || '';
const isEarly = (it) => /^S[123]/.test(it.stage || '');
const SCALE_RANK = { mega: 4, large: 3, medium: 2, small: 1 };
const scaleRank = (s) => SCALE_RANK[(s || '').trim().toLowerCase()] || 0;

function audienceOf(it) {
  const t = `${it.subsector || ''} ${it.sector || ''}`.toLowerCase();
  const rules = [
    [/port|terminal/, 'terminal equipment suppliers, marine & civil EPC, port operators'],
    [/rail/, 'rolling-stock and signalling suppliers, civil EPC, track contractors'],
    [/airport/, 'airfield and terminal contractors, baggage and security systems suppliers'],
    [/renewable|solar|wind|battery|storage/, 'EPC partners, inverter / battery / turbine suppliers, grid contractors'],
    [/power|transmission/, 'transmission EPC, transformer and cable suppliers, substation contractors'],
    [/lng|oil|gas|pipeline|storage/, 'process EPC, pipeline contractors, compressor and valve suppliers'],
    [/hydrogen|ammonia/, 'electrolyser and process-equipment suppliers, EPC'],
    [/mine|mining|lithium|copper|critical|metal/, 'mining-equipment makers, process-plant EPC, materials suppliers'],
    [/fertilizer/, 'process EPC and equipment suppliers'],
    [/grain|food|irrigation|water|agri/, 'agri-processing equipment makers, civil and water-treatment contractors'],
  ];
  for (const [re, txt] of rules) if (re.test(t)) return txt;
  return 'EPC contractors, developers and equipment suppliers';
}
function projectTags(it) {
  const sub = (it.subsector && it.subsector !== '(unspecified)' ? it.subsector : it.sector || '').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const c = countryName(it.country).replace(/[^A-Za-z]/g, '');
  return ['#Infrastructure', sub && '#' + sub, c && '#' + c, '#EPC', '#BusinessDevelopment'].filter(Boolean).slice(0, 5).join(' ');
}

function pickProjects(items, n, used) {
  const cands = items
    .filter((it) => it.source_url && !used.has(it.source_url) && it.project_name)
    // importance first: bigger scale, then earlier (pre-tender) stage, then newest
    .sort((a, b) => (scaleRank(b.scale) - scaleRank(a.scale)) || (isEarly(b) - isEarly(a)) || (b.report_date > a.report_date ? 1 : -1));
  const picks = [];
  const pass = (strict) => {
    for (const it of cands) {
      if (picks.length >= n) return;
      if (picks.includes(it)) continue;
      if (picks.some((p) => similar(p.project_name, it.project_name))) continue;
      if (strict && picks.some((p) => p.sector === it.sector || isoOf(p.country) === isoOf(it.country))) continue;  // different sector and country each
      picks.push(it);
    }
  };
  pass(true); pass(false);
  return picks;
}

// ---------------------------------------------------------------- post builders
const utm = (view, kind, date, i) => `${cfg.site}/?view=${view}&utm_source=linkedin&utm_medium=social&utm_campaign=${kind}-${date.replace(/-/g, '')}-${i}`;

// ---- friend-style post: flags + emoji + headline / 2-3 sentence description / "Source ➡️ link" / hashtags ----
const isoFlag = (i) => String.fromCodePoint(0x1F1E6 + i.charCodeAt(0) - 65, 0x1F1E6 + i.charCodeAt(1) - 65);
// Up to two flags, in the order the countries appear in the headline (e.g. "US, China discuss ..." -> US CN); falls back to the item's own country.
function flagsFor(it) {
  const text = clean(it.project_name);
  const found = [];
  for (const [name, iso] of Object.entries(ISO)) {
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', name.length <= 3 ? '' : 'i');   // "US", "UK", "UAE": case-sensitive
    const m = re.exec(text);
    if (m && !found.some((f) => f.iso === iso)) found.push({ iso, pos: m.index });
  }
  found.sort((x, y) => x.pos - y.pos);
  const isos = found.map((f) => f.iso);
  const prim = isoOf(it.country);
  if (!isos.length && prim) isos.push(prim);
  return isos.slice(0, 2).map(isoFlag).join(' ');
}
const KEYWORD_TAGS = [[/\blng\b/i, 'LNG'], [/\b(crude|oil)\b/i, 'Oil'], [/\bcoal\b/i, 'Coal'], [/\bcopper\b/i, 'Copper'], [/\blithium\b/i, 'Lithium'], [/\b(wheat|grain|corn|soy\w*)\b/i, 'Grain'], [/\btariffs?\b/i, 'Tariffs'], [/\bcontainers?(ships?)?\b/i, 'Containerships'], [/\btankers?\b/i, 'Tankers'], [/\bfreight\b/i, 'Freight'], [/\b(ports?|terminals?)\b/i, 'Ports'], [/\b(battery|storage|bess)\b/i, 'EnergyStorage'], [/\bsolar\b/i, 'Solar'], [/\bwind\b/i, 'Wind'], [/\bhydrogen\b/i, 'Hydrogen'], [/\bammonia\b/i, 'Ammonia'], [/\bpipelines?\b/i, 'Pipelines'], [/\brefiner(s|ies|y)\b/i, 'Refining'], [/\bgold\b/i, 'Gold'], [/\bsteel\b/i, 'Steel'], [/\b(fertili[sz]ers?|urea)\b/i, 'Fertilizer'], [/\bsanctions?\b/i, 'Sanctions'], [/\brail(way)?s?\b/i, 'Rail'], [/\bairports?\b/i, 'Airports'], [/\bmin(e|es|ing)\b/i, 'Mining'], [/\b(shipbuild\w*|newbuild\w*)\b/i, 'Shipbuilding']];
// Specific hashtags like the friend's (#LNG #tariffs #Maersk): what the story is about, not generic labels.
function hashtagsFor(it, extra = []) {
  const text = clean(it.project_name + ' ' + it.description);
  const tags = [];
  const add = (t) => { if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t); };
  for (const [re, t] of KEYWORD_TAGS) if (re.test(text)) add(t);
  const lane = laneOf(it); if (lane) add(lane.tag);
  for (const t of extra) add(t);
  const c = countryName(it.country).replace(/[^A-Za-z]/g, ''); if (c && c.length > 2) add(c);
  return tags.slice(0, 5).map((t) => '#' + t).join(' ');
}

// Where the source link goes: in the FIRST COMMENT (better reach for image posts) or in the body like the friend's posts.
const sourceLine = (it) => cfg.sourceLink === 'body' ? `Source ➡️ ${it.source_url}` : `Source ➡️ ${it.source_name || hostOf(it.source_url)} (link in comments)`;
const commentFor = (it, mapLink) => [cfg.sourceLink === 'body' ? '' : `Source: ${it.source_url}`, cfg.mapLinkInFirstComment ? mapLink : ''].filter(Boolean).join('\n');

function newsPost(it, i, date, slot) {
  const summary = summaryOf(it.description, cfg.maxSummaryChars);
  const prefix = `${flagsFor(it)} ${emojiOf(it.sector)}`.trim();
  // blocks[1] is the description: render.mjs replaces it with 2-3 opening sentences taken from the article itself when it can.
  const blocks = [`${prefix} ${clean(it.project_name)}`, summary, sourceLine(it), hashtagsFor(it, [{ Shipping: 'Shipping', Energy: 'Energy', Metals: 'Metals', Agriculture: 'Agriculture', Policy: 'TradePolicy' }[it.sector]])];
  return {
    account: 'main', type: 'news', id: `main-${i}`, scheduledAtUtc: `${date}T${slot}:00Z`,
    headline: clean(it.project_name), headPrefix: prefix, blocks, descIndex: 1,
    text: blocks.filter(Boolean).join('\n\n'),
    firstComment: commentFor(it, `🗺️ Live map: ${utm('flows', 'news', date, i)}`),
    image: 'screenshot', sourceUrl: it.source_url, sourceName: it.source_name || hostOf(it.source_url),
    meta: { score: score(it), sector: it.sector, country: it.country, lane: laneOf(it)?.id || null, laneName: laneOf(it)?.name || null, reportDate: it.report_date },
  };
}
const STAGE_LONG = { S1: 'Earliest lead', S2: 'Development, before tender', S3: 'Nearing a decision', S4: 'In tender', S5: 'Awarded' };
function snapshotOf(it) {
  const st = STAGE_LONG[(it.stage || '').slice(0, 2)];
  const loc = [countryName(it.country), subOf(it)].filter(Boolean).join(' · ');
  const lines = [loc && '📍 ' + loc, st && '🔧 Stage: ' + st, it.scale && '📊 Scale: ' + capWord(it.scale), '🎯 Worth a look for: ' + audienceOf(it)].filter(Boolean);
  return lines.length ? ['Project snapshot', ...lines].join('\n') : '';
}
function projectPost(it, i, date, slot) {
  const sub = subOf(it);   // skips "(unspecified)" / "Unknown" so no #Unknown hashtag
  const title = clean(it.description) && /[.!?]$/.test(clean(it.description)) && clean(it.description).length <= 140 ? clean(it.description).replace(/.$/, '') : clean(it.project_name);
  const prefix = `${flagsFor({ ...it, project_name: title })} 🏗️`.trim();
  const blocks = [
    `${prefix} ${title}`,
    clean(it.description).replace(/.$/, '') !== title ? summaryOf(it.description, cfg.maxSummaryChars) : '',
    snapshotOf(it),
    sourceLine(it),
    hashtagsFor(it, ['Infrastructure', it.company_name && it.company_name.replace(/[^A-Za-z0-9]/g, ''), sub && sub.replace(/[^A-Za-z]/g, '')]),
  ];
  return {
    account: 'infra', type: 'project', id: `infra-${i}`, scheduledAtUtc: `${date}T${slot}:00Z`,
    headline: clean(it.project_name), headPrefix: prefix, blocks, descIndex: 1,
    text: blocks.filter(Boolean).join('\n\n'),
    firstComment: commentFor(it, `🗂️ All projects with filters: ${utm('infrastructure', 'proj', date, i)}`),
    image: 'screenshot', sourceUrl: it.source_url, sourceName: it.source_name || hostOf(it.source_url),
    meta: { stage: it.stage, sector: it.sector, subsector: it.subsector, country: countryName(it.country), company: it.company_name || null, scale: it.scale || null, reportDate: it.report_date },
  };
}

const BODY_LINKS = cfg.sourceLink === 'body';   // Buffer Free has no first-comment feature: links go in the post body
// ---- own-data cards (Infrastructure): a small slice of the pipeline + counts; company / source / description stay on the map ----
const vague = (s) => !s || /^\(?(unspecified|unknown|n\/a|other)\)?$/i.test(clean(s));
const subOf = (it) => (!vague(it.subsector) ? it.subsector : !vague(it.sector) ? it.sector : '');
const capWord = (s) => { const t = clean(s); return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : ''; };
const STAGE_SHORT = { S1: 'earliest lead', S2: 'before tender', S3: 'nearing a decision', S4: 'in tender', S5: 'awarded' };
const metaOf = (it) => [countryName(it.country), subOf(it), STAGE_SHORT[(it.stage || '').slice(0, 2)], it.scale && `${capWord(it.scale)} scale`].filter(Boolean).join(' · ');
const latestDay = (items) => items.reduce((m, it) => (it.report_date > m ? it.report_date : m), '');
const niceDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function dailyCardPost(items, shown, date, slot) {
  const day = latestDay(items) || date;
  const total = items.filter((it) => it.report_date === day).length || items.length;
  const rest = Math.max(0, total - shown.length);
  const rows = shown.map((it) => ({ iso: isoOf(it.country), name: clean(it.project_name), meta: metaOf(it), sector: it.sector || '' }));
  const lines = [
    `🏗️ ${total} new infrastructure projects tracked · ${niceDate(day)}`, '',
    `Top ${shown.length} by scale and stage:`,
    ...shown.map((it) => `• ${flagOf(it.country) ? flagOf(it.country) + ' ' : ''}${clean(it.project_name)} — ${metaOf(it)}`), '',
    BODY_LINKS ? `Showing ${shown.length} of ${total}. The full list, with company, stage, source and filters ➡️ ${utm('infrastructure', 'daily', date, 1)}` : `Showing ${shown.length} of ${total}. The full list, with company, stage, source and filters, is on the Intelligence Map (link in the first comment).`, '',
    '#Infrastructure #EPC #ProjectFinance #BusinessDevelopment',
  ];
  return {
    account: 'infra', type: 'card', id: 'infra-card-daily', scheduledAtUtc: `${date}T${slot}:00Z`,
    headline: `${total} new infrastructure projects`, blocks: [lines.join('\n')], descIndex: 0, text: lines.join('\n'),
    firstComment: BODY_LINKS ? '' : `🗂️ Full pipeline with filters: ${utm('infrastructure', 'daily', date, 1)}`,
    image: 'card', sourceUrl: null, sourceName: '',
    shareFormat: 'projects', pickUrls: shown.map((it) => it.source_url),   // sharecards.mjs redraws the image with the map's own Share card (this hand-drawn card stays as the fallback)
    card: { kind: 'daily', title: 'New Infrastructure Projects', sub: `${niceDate(day)}  ·  ${total} new projects tracked`, heading: `TOP ${shown.length} BY SCALE AND STAGE`, rows, restText: rest > 0 ? `+${rest} more projects today` : '', restSub: 'Company names, stages, sources and filters are on the map' },
    meta: { total, shown: shown.length, day },
  };
}

function weeklyCardPost(items, date, slot) {
  const dates = items.map((it) => it.report_date).filter(Boolean).sort();
  const from = dates[0] || date, to = dates[dates.length - 1] || date;
  const tally = (fn) => { const m = new Map(); for (const it of items) { const k = fn(it); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const sectors = tally((it) => (it.sector && it.sector !== '(unspecified)' ? it.sector : '')).slice(0, 5).map(([name, n]) => ({ name, n }));
  const countries = tally((it) => isoOf(it.country)).slice(0, 5).map(([iso, n]) => ({ iso, name: countryName(iso), n }));
  const largest = [...items].filter((it) => it.project_name).sort((a, b) => (scaleRank(b.scale) - scaleRank(a.scale)) || (isEarly(b) - isEarly(a))).filter((it, i, arr) => arr.findIndex((x) => similar(x.project_name, it.project_name)) === i).slice(0, 3)
    .map((it) => ({ iso: isoOf(it.country), name: clean(it.project_name), meta: metaOf(it) }));
  const total = items.length, nCountries = new Set(items.map((it) => isoOf(it.country)).filter(Boolean)).size, early = items.filter(isEarly).length;
  const lines = [
    `📊 Infrastructure pipeline · ${niceDate(from)} – ${niceDate(to)}`, '',
    `${total} projects tracked across ${nCountries} countries, ${early} of them still before tender.`,
    sectors.length ? `Most active: ${sectors.slice(0, 3).map((s) => `${s.name} (${s.n})`).join(', ')}.` : '',
    countries.length ? `Hotspots: ${countries.slice(0, 3).map((c) => `${flagOf(c.iso)} ${c.name} (${c.n})`).join(', ')}.` : '', '',
    BODY_LINKS ? `Full pipeline with sector, stage and country filters ➡️ ${utm('infrastructure', 'weekly', date, 1)}` : 'Full pipeline with sector, stage and country filters is on the Intelligence Map (link in the first comment).', '',
    '#Infrastructure #EPC #ProjectFinance #Construction #BusinessDevelopment',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  return {
    account: 'infra', type: 'card', id: 'infra-card-weekly', scheduledAtUtc: `${date}T${slot}:00Z`,
    headline: `Infrastructure pipeline ${from} to ${to}`, blocks: [lines.join('\n')], descIndex: 0, text: lines.join('\n'),
    firstComment: BODY_LINKS ? '' : `🗂️ Full pipeline with filters: ${utm('infrastructure', 'weekly', date, 1)}`,
    image: 'card', sourceUrl: null, sourceName: '',
    card: { kind: 'weekly', title: 'Weekly Infrastructure Update', sub: `${niceDate(from)} – ${niceDate(to)}`, kpis: [{ n: total, label: 'projects' }, { n: nCountries, label: 'countries' }, { n: early, label: 'before tender' }], sectors, countries, largest },
    meta: { total, from, to },
  };
}

// ---------------------------------------------------------------- main
const used = new Set(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')).urls || [] : []);

const flow = await fetchJson(`${API}?report_type=flow_distortion&from=${dayShift(TODAY, -2)}&to=${TODAY}&limit=1000`);
// Infrastructure: the freshest 7 days are the paid window, so anonymous requests only ever see 7-15 days back.
// With WTP_BOT_SECRET set (env var / GitHub secret — never commit it) the API skips the gate and the bot posts the
// last 7 days instead; without it the bot falls back to the free window and posts lag ~1 week.
const SECRET = process.env.WTP_BOT_SECRET || '';
const epcFrom = SECRET ? dayShift(TODAY, -6) : dayShift(TODAY, -15);
const epcTo = SECRET ? TODAY : dayShift(TODAY, -7);
const epc = await fetchJson(`${API}?report_type=epc&from=${epcFrom}&to=${epcTo}&limit=1000${SECRET ? '&secret=' + encodeURIComponent(SECRET) : ''}`);

const A = cfg.accounts;
const isWeekend = [0, 6].includes(new Date(TODAY + 'T00:00:00Z').getUTCDay());   // Sat / Sun (UTC)
const newsN = isWeekend ? (A.main.weekendNewsPerDay ?? 1) : A.main.newsPerDay;
const newsSlots = isWeekend ? [A.main.weekendSlotUtc || '08:30'] : A.main.slotsUtc;
const infraOn = !(isWeekend && A.infra.weekend === false);
const news = pickNews(flow.items || [], newsN, A.main.minScore, used, cfg.blockedWords);
// Never expose more than maxProjectsShownPerDay distinct projects a day (the rest stays on the map for subscribers).
// Pool = the last two days of the window (so "today's" projects are actually recent); widen to the whole window if that is too thin.
const epcItems = epc.items || [];
const recentPool = epcItems.filter((it) => it.report_date >= dayShift(latestDay(epcItems) || TODAY, -1));
const shown = infraOn ? pickProjects(recentPool.length >= A.infra.maxProjectsShownPerDay ? recentPool : epcItems, A.infra.maxProjectsShownPerDay, used) : [];
const projs = shown.slice(0, A.infra.projectsPerDay);
const isWeekly = args.includes('--weekly') || new Date(TODAY + 'T00:00:00Z').getUTCDay() === 1;   // Mondays (UTC)
// The cards say "new / this week": without the secret the data is a week old, so do not publish them (use --allow-stale to test only).
const cardsOk = !!SECRET || args.includes('--allow-stale');
if (!cardsOk) console.error('WARNING: WTP_BOT_SECRET is not set -> Infrastructure cards skipped (data would be a week old).');

const posts = [
  ...news.map((it, k) => newsPost(it, k + 1, TODAY, newsSlots[k % newsSlots.length])),
  ...projs.map((it, k) => projectPost(it, k + 1, TODAY, A.infra.slotsUtc[k % A.infra.slotsUtc.length])),
  ...(cardsOk && shown.length ? [dailyCardPost(epcItems, shown, TODAY, A.infra.dailyCardSlotUtc)] : []),
  ...(cardsOk && infraOn && isWeekly && epcItems.length ? [weeklyCardPost(epcItems, TODAY, A.infra.weeklyCardSlotUtc)] : []),
];

const preview = [`# LinkedIn queue — ${TODAY}`, '',
  `Trade Flow items last 3 days: ${(flow.items || []).length} · Infrastructure ${SECRET ? 'fresh (last 7d)' : 'free-window (7-15d back)'} items: ${(epc.items || []).length}`, ''];
for (const acct of ['main', 'infra']) {
  preview.push(`## ${A[acct].name}`, '');
  const mine = posts.filter((p) => p.account === acct);
  if (!mine.length) preview.push('_Nothing qualified today._', '');
  for (const p of mine) {
    preview.push(`### ${p.id} · ${p.scheduledAtUtc.slice(11, 16)} UTC · image: ${p.image}`, '', '```', p.text, '```', '', `First comment: ${p.firstComment}`, '');
  }
}

console.log(preview.join('\n'));
if (!DRY) {
  const dir = join(HERE, 'queue', TODAY);
  mkdirSync(dir, { recursive: true });
  for (const p of posts) writeFileSync(join(dir, p.id + '.json'), JSON.stringify(p, null, 2));
  writeFileSync(join(dir, 'preview.md'), preview.join('\n'));
  for (const p of posts) if (p.sourceUrl) used.add(p.sourceUrl);
  for (const it of shown) used.add(it.source_url);   // projects that only appear on the daily card must not come back tomorrow
  mkdirSync(join(HERE, 'state'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ urls: [...used].slice(-600) }, null, 2));
  console.error(`\nWrote ${posts.length} posts to ${dir}`);
}
