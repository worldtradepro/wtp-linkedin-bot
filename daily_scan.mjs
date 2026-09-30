// Daily Scan: ONE LinkedIn document (PDF carousel) per page per day, always the same 6-slide format.
//   --series flow    Daily Trade Flow Scan  (main page): the previous UTC day's 3 strongest trade-flow signals + lane risk board
//   --series infra   Daily Project Scan     (Infrastructure page): the previous day's 3 most significant new projects + pipeline board
// Steps (each can run alone):
//   node daily_scan.mjs --series flow --data-only    data.json in reports/out/<date>-scan-<series>/
//   node daily_scan.mjs --series flow --note         editorial note (one OpenRouter call, checked in code) -> reports/notes/<date>-scan-<series>.json
//   node daily_scan.mjs --series flow                render: carousel.pdf, cover.jpg, slide-N.png, linkedin.txt, assets.json
// The note may only use facts from data.json (hard checks: valid ids, required fields, lengths; numbers must appear in the source).
// Env: OPENROUTER_API_KEY (note), WTP_BOT_SECRET (infra: fresh projects; without it the public 7-15-day window is used).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask } from './llm.mjs';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, hostOf, similar, score, summaryOf, tokens } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const DS = cfg.dailyScan || {};
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SERIES = arg('--series', 'flow');
if (!['flow', 'infra'].includes(SERIES)) throw new Error('--series flow|infra');
const DATE = arg('--date', new Date().toISOString().slice(0, 10));   // publication day
const API = cfg.site + '/wp-json/wtp/v1';
const SECRET = process.env.WTP_BOT_SECRET || '';
const OUT = join(HERE, 'reports', 'out', `${DATE}-scan-${SERIES}`);
const NOTES = join(HERE, 'reports', 'notes', `${DATE}-scan-${SERIES}.json`);
mkdirSync(OUT, { recursive: true });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const issueNo = Math.max(1, Math.round((Date.parse(DATE) - Date.parse(DS.startDate || DATE)) / 864e5) + 1);
const SERIES_NAME = SERIES === 'flow' ? 'Daily Trade Flow Scan' : 'Daily Project Scan';
const gnews = (it) => hostOf(it.source_url) === 'news.google.com' && clean(it.project_name).match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
const titleOf = (it) => { const g = gnews(it); return g ? g[1] : clean(it.project_name); };
const sourceOf = (it) => { const g = gnews(it); return g ? g[2] : it.source_name || hostOf(it.source_url); };
const blocked = (cfg.blockedWords || []).map((w) => w.toLowerCase());
const ok = (it) => it.source_url && !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w));
const tier = (n) => (n >= 12 ? 'Critical' : n >= 8 ? 'Elevated' : 'Watch');

function related(a, b) {
  if (similar(a, b)) return true;
  const A = tokens(a), B = tokens(b); let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 2 && shared / Math.min(A.size, B.size) >= 0.33;
}

// ================================================================ data
// The feed's descriptions are 1-2 sentences, too thin for a good slide: read the opening of each picked article
// (meta description + first paragraphs). Best effort - paywalled / blocked pages just add nothing.
const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&#8217;|&#39;|&rsquo;/g, "'").replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
async function articleText(url, max = 1800) {
  if (!url || hostOf(url) === 'news.google.com') return '';
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36', accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    const h = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<aside[\s\S]*?<\/aside>/gi, ' ');
    const meta = decode((h.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/i) || [])[1] || '');
    const body = h.match(/<article[\s\S]*?<\/article>/i)?.[0] || h;
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decode(m[1]))
      // real sentences only: sidebar / related-story headlines have no sentence punctuation
      .filter((p) => p.length > 80 && /[.!?]["'”’)]?$/.test(p) && !/cookie|subscribe|sign up|newsletter|all rights reserved|javascript|advertisement|click here|read more|investment advice|not intended to provide|terms of use|privacy policy/i.test(p));
    let out = meta; for (const p of paras) { if (out.length > max) break; if (!out.includes(p.slice(0, 40))) out += (out ? '\n' : '') + p; }
    return out.slice(0, max);
  } catch { return ''; }
}
async function enrich(picks) {
  for (const p of picks) {
    p.article = await articleText(p.url);
    for (const o of p.otherReports || []) o.article = o.url ? await articleText(o.url, 900) : '';
  }
}

async function flowData() {
  const D1 = dayShift(DATE, -1);
  const res = await fetchJson(`${API}/opportunities?report_type=flow_distortion&from=${dayShift(DATE, -14)}&to=${D1}&limit=2000`);
  const all = (res.items || []).filter(ok);
  const day = all.filter((it) => it.report_date === D1);
  const cl = [];
  for (const it of [...day].sort((a, b) => score(b) - score(a))) {
    const c = cl.find((x) => [x.lead, ...x.more].some((m) => related(m.project_name, it.project_name)));
    if (c) c.more.push(it); else cl.push({ lead: it, more: [] });
  }
  cl.sort((a, b) => score(b.lead) - score(a.lead) || b.more.length - a.more.length);
  // 3 picks: strongest first, one per lane, no near-duplicates, at least 2 sectors when the day allows it
  const picks = [];
  for (const c of cl) {
    if (picks.length === 3) break;
    const lane = laneOf(c.lead)?.id;
    if (lane && picks.some((p) => laneOf(p.lead)?.id === lane)) continue;
    if (picks.length === 2 && picks[0].lead.sector === picks[1].lead.sector && c.lead.sector === picks[0].lead.sector
        && cl.some((o) => !picks.includes(o) && o !== c && o.lead.sector !== picks[0].lead.sector && score(o.lead) >= 8)) continue;
    picks.push(c);
  }
  const win = (from, to) => all.filter((it) => it.report_date >= from && it.report_date <= to);
  const cur = win(dayShift(D1, -6), D1), prev = win(dayShift(D1, -13), dayShift(D1, -7));
  const count = (items, id) => { const x = items.filter((it) => laneOf(it)?.id === id); return { crit: x.filter((it) => score(it) >= 12).length, elev: x.filter((it) => score(it) >= 8 && score(it) < 12).length, watch: x.filter((it) => score(it) < 8).length }; };
  const idx = (c) => c.crit * 3 + c.elev * 2 + c.watch;
  const lanes = LANES.map((l) => { const now = count(cur, l.id), pr = count(prev, l.id); return { id: l.id, name: l.name, flow: l.flow, now, p: idx(now), pp: idx(pr), today: day.filter((it) => laneOf(it)?.id === l.id).length }; })
    .sort((a, b) => b.p - a.p || b.today - a.today);
  const sig = (it, more = []) => ({ id: String(it.id), title: titleOf(it), source: sourceOf(it), url: it.source_url, date: it.report_date, tier: tier(score(it)), score: score(it),
    sector: it.sector, flag: flagOf(it.country), country: countryName(it.country), lane: laneOf(it)?.name || '', laneFlow: laneOf(it)?.flow || '',
    summary: summaryOf(it.description, 400) || '', otherReports: more.slice(0, 4).map((m) => ({ title: titleOf(m), source: sourceOf(m), url: m.source_url, summary: summaryOf(m.description, 240) || '' })) });
  const sectors = {}; for (const it of day) sectors[it.sector || 'Other'] = (sectors[it.sector || 'Other'] || 0) + 1;
  const pk = picks.map((c) => sig(c.lead, c.more));
  await enrich(pk);
  return {
    series: 'flow', date: DATE, scanDay: D1, issue: issueNo,
    totals: { signals: day.length, critical: day.filter((it) => score(it) >= 12).length, elevated: day.filter((it) => score(it) >= 8 && score(it) < 12).length, lanesActive: lanes.filter((l) => l.today > 0).length, stories: cl.length },
    sectors, picks: pk, lanes,
    alsoOnRadar: cl.filter((c) => !picks.includes(c)).slice(0, 6).map((c) => sig(c.lead)),
  };
}

const STAGE = { S1: 'Feasibility', S2: 'Development', S3: 'Pre-FID', S4: 'Tender', S5: 'Awarded' };
const stageOf = (s) => STAGE[String(s || '').slice(0, 2)] || '';
const stageW = (s) => ({ S5: 5, S4: 4, S3: 3, S2: 2, S1: 1 })[String(s || '').slice(0, 2)] || 0;
const scaleW = (s) => ({ Mega: 4, Large: 3, Medium: 2, Small: 1 })[s] || 0;
async function infraData() {
  const q = SECRET ? `&secret=${encodeURIComponent(SECRET)}` : '';
  const res = await fetchJson(`${API}/opportunities?report_type=epc&from=${dayShift(DATE, -21)}&to=${dayShift(DATE, -1)}&limit=2000${q}`);
  const all = (res.items || []).filter(ok);
  // Projects reach the feed days after their report date and the daily intake is uneven (4 one day, 29 another), so each
  // scan draws on the last 7 days and skips projects an earlier Daily Project Scan already featured (state/scan_pushed.json).
  // Without the secret (local tests) the newest public day stands in for "yesterday".
  const pushedF = join(HERE, 'state', 'scan_pushed.json');
  const featured = new Set(Object.entries(existsSync(pushedF) ? JSON.parse(readFileSync(pushedF, 'utf8')) : {})
    .filter(([k, v]) => k.endsWith(':infra') && v.bufferPostId).flatMap(([, v]) => v.pickIds || []));
  const D1 = SECRET ? dayShift(DATE, -1) : all.map((it) => it.report_date).sort().pop();
  const W0 = dayShift(D1, -6);
  const day = all.filter((it) => it.report_date >= W0 && it.report_date <= D1 && !featured.has(String(it.id)));
  // Google News redirect links cannot be read (no article text for the note) and name the outlet poorly: rank them last among equals
  const rank = (it) => stageW(it.stage) * 10 + scaleW(it.scale) * 6 + (parseInt(it.credibility, 10) || 0) - (hostOf(it.source_url) === 'news.google.com' ? 9 : 0);
  // topics that are not business-development leads for this audience (politically charged, defence)
  const offTopic = new RegExp('\\b(' + (DS.infraBlockedWords || ['detention', 'prison', 'jail', 'immigration', 'military', 'weapons?', 'ammunition', 'missile', 'border wall']).join('|') + ')\\b', 'i');
  const sorted = [...day].filter((it) => !offTopic.test(it.project_name + ' ' + it.description)).sort((a, b) => rank(b) - rank(a));
  // shortlist 8 (one per country), read their articles, then take the 3 best that have real article text
  const short = [];
  for (const it of sorted) {
    if (short.length === 10) break;
    if (short.some((p) => p.country === it.country || similar(p.project_name, it.project_name))) continue;
    short.push(it);
  }
  const texts = new Map();
  for (const it of short) texts.set(it, await articleText(it.source_url));
  const pool = [...short.filter((it) => texts.get(it).length >= 300), ...short.filter((it) => texts.get(it).length < 300)];
  const picks = [];
  for (const it of pool) if (picks.length < 3 && !picks.some((p) => (p.subsector || p.sector) === (it.subsector || it.sector))) picks.push(it);   // 3 different sub-sectors
  for (const it of pool) if (picks.length < 3 && !picks.includes(it)) picks.push(it);
  const proj = (it) => ({ id: String(it.id), name: clean(it.project_name), country: countryName(it.country), flag: flagOf(it.country), region: it.region || '',
    sector: it.sector || '', subsector: /^(unknown|n\/a|other|none)$/i.test(String(it.subsector || '').trim()) ? '' : (it.subsector || ''), stage: stageOf(it.stage), scale: it.scale || '', company: clean(it.company_name),
    summary: clean(it.description), source: sourceOf(it), url: it.source_url, date: it.report_date });
  const pk = picks.map((it) => ({ ...proj(it), article: texts.get(it) }));
  const tally = (key) => { const t = {}; for (const it of day) { const k = key(it) || 'Other'; t[k] = (t[k] || 0) + 1; } return Object.entries(t).sort((a, b) => b[1] - a[1]); };
  return {
    series: 'infra', date: DATE, scanDay: D1, windowFrom: W0, issue: issueNo, fresh: !!SECRET,
    totals: { projects: day.length, awarded: day.filter((it) => stageW(it.stage) === 5).length, tenders: day.filter((it) => stageW(it.stage) === 4).length,
      countries: new Set(day.map((it) => it.country)).size, large: day.filter((it) => scaleW(it.scale) >= 3).length },
    byStage: ['S1', 'S2', 'S3', 'S4', 'S5'].map((s) => [STAGE[s], day.filter((it) => String(it.stage).startsWith(s)).length]),
    byRegion: tally((it) => it.region), bySector: tally((it) => it.sector),
    picks: pk,
    others: sorted.filter((it) => !picks.includes(it)).slice(0, 8).map(proj),
  };
}

// ================================================================ note: one model call, checked in code
function material(d) {
  return d.series === 'flow'
    ? { day: d.scanDay, totals: d.totals, sectors: d.sectors, picks: d.picks, lanes: d.lanes.map((l) => ({ lane: l.name, flow: l.flow, signals_scan_day: l.today, pressure_7d: l.p, pressure_prev_7d: l.pp })), also_on_radar: d.alsoOnRadar.map((s) => ({ title: s.title, source: s.source, tier: s.tier })) }
    : { window: `${d.windowFrom} to ${d.scanDay} (last 7 days)`, totals: d.totals, by_stage: d.byStage, by_region: d.byRegion, by_sector: d.bySector, picks: d.picks, others: d.others.map((p) => ({ name: p.name, country: p.country, sector: p.sector, stage: p.stage, scale: p.scale })) };
}
const LIMITS = SERIES === 'flow'
  ? { headline: 90, hook: 220, board: 200, question: 140, item: { headline: 80, statValue: 14, statLabel: 60, what: 260, why: 260, watch: 170 }, fact: 120 }
  : { headline: 90, hook: 220, board: 200, question: 140, item: { headline: 80, statValue: 14, statLabel: 60, what: 260, who: 140, angle: 260, watch: 170 }, fact: 120 };
const KEYS = Object.keys(LIMITS.item);

function check(n, d) {
  const hard = [], soft = [];
  for (const k of ['headline', 'hook', 'board', 'question', 'items']) if (n[k] === undefined) hard.push('missing ' + k);
  if (hard.length) return { hard, soft };
  const ids = d.picks.map((p) => p.id);
  if (!Array.isArray(n.items) || n.items.length !== ids.length) hard.push(`items must have ${ids.length} entries, one per pick, same order`);
  else n.items.forEach((it, i) => {
    if (String(it.id) !== ids[i]) hard.push(`items[${i}].id must be ${ids[i]}`);
    for (const k of KEYS) { if (!it[k]) hard.push(`items[${i}].${k} missing`); else if (String(it[k]).length > LIMITS.item[k]) hard.push(`items[${i}].${k} is ${String(it[k]).length} chars (max ${LIMITS.item[k]})`); }
    if (!Array.isArray(it.facts) || it.facts.length !== 3) hard.push(`items[${i}].facts must be 3 strings`);
    else it.facts.forEach((f, j) => { if (String(f).length > LIMITS.fact) hard.push(`items[${i}].facts[${j}] is ${String(f).length} chars (max ${LIMITS.fact})`); });
  });
  for (const k of ['headline', 'hook', 'board', 'question']) if (String(n[k]).length > LIMITS[k]) hard.push(`${k} is ${String(n[k]).length} chars (max ${LIMITS[k]})`);
  const all = [n.headline, n.hook, n.board, n.question, ...(n.items || []).flatMap((it) => [...KEYS.map((k) => it[k]), ...(it.facts || [])])].join(' ');
  if (/<[a-z]/i.test(all)) hard.push('no HTML');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(all)) hard.push('no emojis');
  const corpus = JSON.stringify(material(d)).toLowerCase().replace(/,(?=\d{3})/g, '');
  const missing = new Set();
  for (const x of all.match(/\d[\d,.]*%?/g) || []) { const bare = x.replace(/[.,]$/, '').replace(/,/g, ''); if (!corpus.includes(bare.toLowerCase())) missing.add(x); }
  if (missing.size) hard.push('numbers not found in the source material (remove or correct them): ' + [...missing].join(', '));
  return { hard, soft };
}

const COMMON = `- Every fact, number, name and date must come from the material (feed summaries and the "article" texts). No outside knowledge, no prices, forecasts or figures that are not in it.
- Attribute reported claims ("Reuters reports", "per Railway Gazette"). Never state more certainty than the source.
- "statValue" + "statLabel": the single most telling figure of the story, copied from the material (e.g. "18 vs 509" / "LNG cargoes exported, same period a year apart"; "$3.5bn" / "EPC contract, Samsung E&A"). statValue is short (digits, units like "bn", "%", "t", "vs"). If the story has no figure, use a date or count from the material.
- "facts": exactly 3 short, concrete facts from the material that are NOT already in "what" (volumes, dates, names, scope, other outlets' details).
- "watch": the next concrete thing to watch, grounded in the material (a deadline, a decision, a delivery date, a stated plan). No speculation.
- Plain, precise English, no hype, no emojis, no hashtags, no HTML.`;
const SYSTEM = {
  flow: `You write "${SERIES_NAME}", a daily LinkedIn carousel by World Trade Pro for physical commodity traders, charterers, shipowners and buyers.
You get the previous day's 3 strongest trade-flow signals (with the article text and other outlets' reports), the 9-lane risk board and totals.
Write ONLY from this material. Hard rules:
${COMMON}
- "why" explains the consequence for physical flows ONLY as far as the material supports it: the affected lane and its flow ("laneFlow"), the commodity, route, volumes or costs named in the reports.
Return ONE JSON object only: {"headline": the day in one line, "hook": 1-2 sentences for the post caption, "board": one sentence reading the lane risk board, "question": one concrete question to the readers about today's signals that a trader or charterer can answer from experience (no yes/no, no "thoughts?"), "items": [{"id", "headline", "statValue", "statLabel", "what", "why", "facts": [3], "watch"} x3 in the given order]}.`,
  infra: `You write "${SERIES_NAME}", a daily LinkedIn carousel by World Trade Pro for EPC contractors, equipment suppliers, subcontractors and project developers (business development people).
You get the 3 most significant new infrastructure projects of the last 7 days that have not been featured before (with the article text), the other new projects and the week's breakdown by stage, region and sector.
Write ONLY from this material. Hard rules:
${COMMON}
- "who": owner / developer / EPC contractor / licensors named in the material, as "Owner: X. EPC: Y." If none is named, write "Not named in the report".
- "angle": who in the supply chain this is relevant to and why, grounded in the stage (Feasibility, Development, Pre-FID, Tender, Awarded), scope, sector and scale given. An awarded EPC contract means subcontracting and equipment packages come next; a tender means bidders. Do not invent package names, values or dates.
Return ONE JSON object only: {"headline": the three projects in one line, "hook": 1-2 sentences for the post caption, "board": one sentence reading the last 7 days' pipeline breakdown, "question": one concrete question to the readers about today's projects that a BD or procurement person can answer from experience (no yes/no, no "thoughts?"), "items": [{"id", "headline" (a clear project title), "statValue", "statLabel", "what", "who", "angle", "facts": [3], "watch"} x3 in the given order]}.`,
}[SERIES];

async function writeNote(d) {
  const user = `FIELD LIMITS (characters): headline <= ${LIMITS.headline}; hook <= ${LIMITS.hook}; board <= ${LIMITS.board}; question <= ${LIMITS.question}; ${KEYS.map((k) => `items[].${k} <= ${LIMITS.item[k]}`).join('; ')}; each fact <= ${LIMITS.fact}.
Pick ids, in this order: ${d.picks.map((p) => p.id).join(', ')}.

SOURCE MATERIAL:
${JSON.stringify(material(d))}`;
  const messages = [{ role: 'user', content: user }];
  let note, chk, res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await ask(SYSTEM, messages, { model: DS.model || cfg.weeklyReport?.model, title: 'World Trade Pro - ' + SERIES_NAME, site: cfg.site });
    const text = res.text;
    try { note = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); chk = check(note, d); } catch (e) { chk = { hard: ['not valid JSON: ' + e.message], soft: [] }; }
    console.log(`note attempt ${attempt}: ${res.model}, hard ${chk.hard.length}`);
    if (!chk.hard.length) break;
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'Fix these problems and return the full JSON again:\n- ' + chk.hard.join('\n- ') });
  }
  if (chk.hard.length) throw new Error('note failed the checks:\n- ' + chk.hard.join('\n- '));
  note._generated = { at: new Date().toISOString(), model: res.model, usage: res.usage };
  mkdirSync(dirname(NOTES), { recursive: true });
  writeFileSync(NOTES, JSON.stringify(note, null, 2) + '\n');
  return note;
}

// ================================================================ photos: ONLY the licence-checked media library (media_pick.mjs + ledger)
// Each story gets a topic photo by keyword -> library tag. A photo is not reused within PHOTO_GAP days (state/photos_used.json),
// every photo is captioned "Illustrative" and credited on the slide. No text is laid over a photo (CC BY-SA would make it an adaptation).
const LIB = join(HERE, 'media_library');
const LEDGER = existsSync(join(LIB, 'ledger.json')) ? JSON.parse(readFileSync(join(LIB, 'ledger.json'), 'utf8')) : [];
const USED_F = join(HERE, 'state', 'photos_used.json');
const USED = existsSync(USED_F) ? JSON.parse(readFileSync(USED_F, 'utf8')) : {};
const PHOTO_GAP = DS.photoGapDays || 14;
const TOPICS = [
  [/\bngl\b|natural gas liquids|fractionation|gas processing|gas plant|sour gas/, ['gas-processing', 'petrochemical']],
  [/\blng\b|liquefied natural gas/, ['lng-carrier', 'lng-plant']], [/\blpg\b|propane|butane/, ['lpg-carrier', 'gas-processing']],
  [/naphtha|diesel|gasoline|jet fuel|fuel oil|refined product|product tanker/, ['product-tanker', 'refinery', 'oil-storage']],
  [/refiner/, ['refinery', 'oil-storage']], [/petrochemical|polymer|ethylene|methanol|chemical plant/, ['petrochemical']],
  [/fertili[sz]er|urea|ammonia|potash|phosphate/, ['fertilizer-plant']],
  [/red sea|bab el-mandeb|bab al-mandab|houthi|gulf of aden|jeddah/, ['red-sea', 'suez-canal']], [/suez/, ['suez-canal', 'red-sea']],
  [/hormuz|gulf of oman|persian gulf|arabian gulf/, ['hormuz-region', 'gulf-port']], [/malacca|singapore strait/, ['malacca', 'singapore-port']], [/panama canal|panama/, ['panama-canal']], [/bosphorus|bosporus|turkish straits/, ['bosphorus']],
  [/container|box ship|\bteu\b/, ['container-ship', 'container-port']],
  [/kamsarmax|capesize|panamax|supramax|ultramax|dry bulk|bulk carrier|bulker/, ['bulk-carrier']],
  [/shipyard|newbuild|dry dock|orders? .{0,30}(vessel|ship|carrier|tanker)/, ['shipyard']],
  [/wheat|grain|barley/, ['wheat', 'grain-silo', 'grain-loading']], [/soy/, ['soybean', 'grain-silo']], [/\bcorn\b|maize/, ['corn', 'grain-silo']],
  [/\brice\b/, ['rice']], [/cocoa/, ['cocoa']], [/sugar|coffee/, ['sugar-coffee']], [/palm oil|oil palm|\bcpo\b/, ['palm-oil']], [/cotton/, ['cotton']],
  [/cattle|beef|livestock|dairy/, ['cattle']], [/fish|seafood|tuna|shrimp/, ['fishing']], [/timber|lumber|log exports|wood pellet|sawn/, ['timber']],
  [/\bgold\b/, ['gold']], [/nickel/, ['nickel']], [/nuclear|uranium|reactor/, ['uranium-nuclear']], [/geothermal/, ['geothermal']],
  [/\bfpso\b|floating production/, ['fpso']], [/drillship|jack-up|drilling rig/, ['drillship', 'offshore-platform']], [/compressor station|compression/, ['compressor']],
  [/cement|clinker/, ['cement']], [/warehouse|logistics cent|distribution cent/, ['warehouse']], [/truck|trucking|haulage/, ['trucks']],
  [/freight train|rail freight|freight rail/, ['rail-freight']], [/crane|terminal equipment/, ['port-cranes']],
  [/fujairah|jebel ali|khor fakkan|sohar/, ['gulf-port']], [/singapore/, ['singapore-port']],
  [/rotterdam|maasvlakte/, ['rotterdam']], [/shanghai|ningbo|qingdao|yangshan|tianjin port|chinese ports?/, ['china-port']],
  [/mundra|nhava sheva|jawaharlal nehru port|mumbai port|indian ports?/, ['india-port']], [/houston|corpus christi|sabine pass|gulf coast|louisiana/, ['us-gulf']],
  [/santos|paranagu|brazilian ports?/, ['brazil-port']], [/port hedland|dampier|newcastle|gladstone/, ['australia-port']],
  [/odesa|odessa|novorossiysk|constan[tț]a|black sea ports?/, ['black-sea-port']], [/mombasa|durban|lagos|lekki|dar es salaam|tema/, ['africa-port']],
  [/norway|norwegian|north sea/, ['norway-offshore']], [/concentrated solar|\bcsp\b|desert/, ['desert-solar']],
  [/module|modular/, ['modules']], [/heavy[- ]lift/, ['heavy-lift']],
  [/fsru|regasification|lng import terminal/, ['storage-lng', 'lng-plant']], [/flaring|\bflare\b/, ['refinery-flare']],
  [/substation|transformer/, ['substation-hv', 'transmission']], [/gigafactory|battery (plant|factory|cell)|cell manufactur/, ['ev-battery']],
  [/semiconductor|\bchips?\b|\bfab\b|wafer/, ['semiconductor']], [/bunker/, ['bunkering']], [/\btugs?\b|towage/, ['tugboats']],
  [/barge|inland waterway|rhine|danube|mississippi|yangtze/, ['river-barge', 'canal-lock']], [/air cargo|airfreight|air freight/, ['air-cargo']],
  [/customs|tariff|import duty|export ban|export controls?|sanction/, ['customs', 'container-port']], [/hydropower|hydroelectric/, ['hydro-power', 'hydro-dam']],
  [/copper/, ['copper-mine']], [/iron ore/, ['iron-ore']], [/\bsteel\b/, ['steel-mill']], [/alumin/, ['aluminium']], [/lithium/, ['lithium']],
  [/\bcoal\b/, ['coal']], [/\bmine\b|mining/, ['mining-general']],
  [/pipeline/, ['pipeline']], [/offshore wind/, ['wind-offshore']], [/offshore|fpso|platform|\brig\b/, ['offshore-platform']],
  [/oilfield|upstream|drilling|\bwell\b/, ['oilfield']], [/crude|oil export|oil import|barrels|\bvlcc\b|tanker/, ['crude-tanker', 'oil-storage']],
  [/power plant|power station|gas-fired|combined cycle|\bccgt\b/, ['power-plant']],
  [/high-speed|high speed/, ['high-speed-train', 'rail-construction']], [/\bmetro\b|subway|\btram/, ['metro']], [/rail|signalling|signaling|interlocking/, ['rail-construction', 'high-speed-train']],
  [/wind/, ['wind-onshore', 'wind-offshore']], [/solar|photovoltaic/, ['solar']], [/hydro|\bdam\b/, ['hydro-dam']],
  [/transmission|\bgrid\b|substation|interconnector/, ['transmission']], [/battery|\bbess\b|energy storage/, ['battery-storage']],
  [/bridge/, ['bridge']], [/tunnel/, ['tunnel']], [/data cent/, ['data-centre']], [/desalination|water treatment|wastewater/, ['desalination']],
  [/airport/, ['airport']], [/\broad\b|highway|expressway|motorway/, ['road']], [/hydrogen|electroly/, ['hydrogen']],
  [/\bport\b|terminal|harbour|harbor/, ['container-port', 'port-general']],
];
const SECTOR_TAGS = { Shipping: ['container-ship', 'bulk-carrier', 'port-general'], Energy: ['refinery', 'oil-storage', 'crude-tanker'], Agriculture: ['grain-silo', 'wheat'],
  Metals: ['mining-general', 'steel-mill'], 'Mining & Metals': ['mining-general'], Policy: ['customs', 'container-port', 'port-general'], 'Logistics & Infrastructure': ['construction-site'] };
const PLACE_TAGS = new Set(['rotterdam', 'china-port', 'india-port', 'us-gulf', 'brazil-port', 'australia-port', 'black-sea-port', 'africa-port', 'norway-offshore',
  'gulf-port', 'singapore-port', 'suez-canal', 'panama-canal', 'bosphorus', 'red-sea', 'hormuz-region', 'malacca', 'gulf-industry']);
function recentIds() {
  const cutoff = dayShift(DATE, -PHOTO_GAP), s = new Set();
  for (const [key, ids] of Object.entries(USED)) if (key.slice(0, 10) >= cutoff && key !== DATE + ':' + SERIES) for (const id of ids) s.add(id);
  return s;
}
function pickPhoto(p, taken) {
  const text = [p.title || p.name, p.headline, p.subsector, p.summary, (p.article || '').slice(0, 600)].join(' ').toLowerCase();
  const tags = [];
  for (const [re, t] of TOPICS) if (re.test(text)) for (const x of t) if (!tags.includes(x)) tags.push(x);
  for (const x of SECTOR_TAGS[p.sector] || []) if (!tags.includes(x)) tags.push(x);
  // project posts show plants and sites, not ships: vessel photos go last for the Infrastructure series
  if (SERIES === 'infra') { const vessel = (t) => /carrier|tanker|container-ship/.test(t); tags.sort((a, b) => vessel(a) - vessel(b)); }
  const recent = recentIds();
  // a photo of a named place (Rotterdam, Houston, Odesa...) only illustrates a story about that place
  const placeOk = (r) => r.tags.every((t) => !PLACE_TAGS.has(t) || tags.includes(t));
  for (const pass of [0, 1]) for (const tag of tags) {   // pass 0: not used for PHOTO_GAP days; pass 1: any not used today
    const pool = LEDGER.filter((r) => r.tags.includes(tag) && placeOk(r) && !taken.has(r.id) && (pass === 1 || !recent.has(r.id)));
    if (pool.length) { const h = [...(DATE + p.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); return pool[h % pool.length]; }
  }
  return null;
}

// ================================================================ main
const DATA = join(OUT, 'data.json');
let d;
if (existsSync(DATA) && !args.includes('--refresh')) d = JSON.parse(readFileSync(DATA, 'utf8'));
else { d = SERIES === 'flow' ? await flowData() : await infraData(); writeFileSync(DATA, JSON.stringify(d, null, 2)); }
console.log(`${SERIES_NAME} #${d.issue} (${d.scanDay}): ${d.picks.length} picks`);
if (d.picks.length < 3) { console.error('fewer than 3 picks - no scan today'); process.exit(2); }
if (args.includes('--data-only')) process.exit(0);
let N;
if (args.includes('--note') || !existsSync(NOTES)) N = await writeNote(d);
else { N = JSON.parse(readFileSync(NOTES, 'utf8')); const c = check(N, d); if (c.hard.length) throw new Error('note failed the checks:\n- ' + c.hard.join('\n- ')); }
if (args.includes('--note')) process.exit(0);
const byId = Object.fromEntries((N.items || []).map((x) => [String(x.id), x]));

// photos for the 3 stories (the lead story's photo is also the cover)
const taken = new Set();
const PH = d.picks.map((p) => { const r = pickPhoto({ ...p, headline: byId[p.id].headline }, taken); if (r) taken.add(r.id); return r; });
const COVER = pickPhoto({ ...d.picks[0], headline: byId[d.picks[0].id].headline }, taken) || PH[0]; if (COVER) taken.add(COVER.id);
console.log('cover:', COVER?.id, '· photos:', PH.map((r) => r ? r.id + ' [' + r.tags.join(',') + ']' : 'none').join(' | '));

// ================================================================ globe: the map's own Share card (our data, no licence issue)
const { chromium } = await import('playwright');
const cardDir = join(OUT, 'map');
if (!existsSync(cardDir) || !readdirSync(cardDir).some((f) => f.endsWith('.png'))) {
  try { execFileSync(process.execPath, [join(HERE, 'share_card.mjs'), SERIES === 'flow' ? 'flash' : 'projects'], { cwd: HERE, env: { ...process.env, OUT_DIR: cardDir }, stdio: 'inherit' }); }
  catch (e) { console.warn('share card failed, board without globe:', e.message); }
}
const cardPng = existsSync(cardDir) && readdirSync(cardDir).find((f) => f.endsWith('.png') && !f.startsWith('_'));
// cut the globe out of the card: the sphere is the widest CONTINUOUS run of non-background pixels (text rows have gaps)
if (cardPng && !existsSync(join(cardDir, '_globe.png'))) execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); W, H = im.size; bg = im.getpixel((6, 6))
px = im.load(); best = (0, 0, 0, 0)
for y in range(60, int(H * 0.62), 2):
    run = None
    for x in range(int(W * 0.1), int(W * 0.9)):
        if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > 70:
            if run is None: run = [x, x]
            elif x - run[1] <= 8: run[1] = x
            else:
                if run[1] - run[0] > best[0]: best = (run[1] - run[0], y, run[0], run[1])
                run = [x, x]
    if run and run[1] - run[0] > best[0]: best = (run[1] - run[0], y, run[0], run[1])
w, y, x0, x1 = best; r = w / 2 * 0.99; cx = (x0 + x1) / 2
im.crop((int(cx - r), int(y - r), int(cx + r), int(y + r))).resize((900, 900), Image.LANCZOS).save(sys.argv[2])
`, join(cardDir, cardPng), join(cardDir, '_globe.png')]);
const GLOBE_FILE = cardPng && existsSync(join(cardDir, '_globe.png')) ? join(cardDir, '_globe.png') : '';

// ================================================================ slides (1080x1350, 10 per carousel)
const S = { w: 1080, h: 1350 };
const T = SERIES === 'flow'
  ? { main: '#0f2d5e', accent: '#c8a94a', kick: '#0b4a6f', tint: '#f3f6fa' }
  : { main: '#0d3b3e', accent: '#e0a526', kick: '#0e6b70', tint: '#f1f7f6' };
const fileUrl = (f) => 'file:///' + f.replace(/\\/g, '/');
const GLOBE = GLOBE_FILE ? fileUrl(GLOBE_FILE) : '';
const TIER_C = { Critical: '#b42318', Elevated: '#b54708', Watch: '#667085' };
const STAGE_C = { Awarded: '#027a48', Tender: '#b54708', 'Pre-FID': '#0b4a6f', Development: '#475467', Feasibility: '#667085' };
const TOTAL = 10;
const dt = new Date(d.scanDay + 'T00:00:00Z');
const DAYW = dt.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
const DATE_SHORT = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_BIG = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const slide = (inner, n, cls = '') => `<section class="s ${cls}">${inner}<footer><span>WORLD TRADE PRO · ${SERIES_NAME.toUpperCase()} · ${DATE_SHORT.toUpperCase()}</span><span>${n} / ${TOTAL}</span></footer></section>`;
const bigStat = (v, l) => `<div class="bs"><b>${v}</b><span>${l}</span></div>`;
const photo = (r, h) => r ? `<div class="ph" style="height:${h}px;background-image:url('${fileUrl(join(LIB, r.file))}')"></div><div class="cr">${esc(r.caption.replace(/\.$/, ''))} · ${esc(r.credit)}</div>` : `<div class="ph none" style="height:${h}px"></div>`;
const label = SERIES === 'flow' ? 'Signal' : 'Project';
const chipsFor = (p) => SERIES === 'flow'
  ? `<span class="chip" style="background:${TIER_C[p.tier]}">${p.tier}</span><span class="chip o">${esc(p.sector)}</span>${p.lane ? `<span class="chip o">${esc(p.lane)}</span>` : ''}`
  : `${p.stage ? `<span class="chip" style="background:${STAGE_C[p.stage] || '#475467'}">${esc(p.stage)}</span>` : ''}<span class="chip o">${esc(p.country)}</span><span class="chip o">${esc(p.subsector || p.sector)}</span>`;
const src = (p) => `${esc(p.source)}${p.otherReports?.length ? ` + ${p.otherReports.length} more report${p.otherReports.length > 1 ? 's' : ''}` : ''} · ${esc(p.date)}`;

const cover = slide(`${photo(COVER, 610)}
  <div class="datebox"><b>${esc(DATE_BIG)}</b><span>${SERIES === 'infra' ? 'Last 7 days' : esc(DAYW)} · ${dt.getUTCFullYear()} · Issue #${d.issue}</span></div>
  <div class="cv"><div class="k">${SERIES_NAME}</div><h1>${esc(N.headline)}</h1></div>
  <div class="row3">${SERIES === 'flow'
    ? bigStat(d.totals.signals, 'trade-flow signals') + bigStat(d.totals.critical, 'critical') + bigStat(d.totals.lanesActive + '/9', 'lanes with signals')
    : bigStat(d.totals.projects, 'new projects') + bigStat(d.totals.awarded, 'contracts awarded') + bigStat(d.totals.countries, 'countries')}</div>
  <div class="swipe">Swipe →</div>`, 1, 'dark cover');

const glanceRows = SERIES === 'flow'
  ? [...d.picks.map((p, i) => ({ strong: true, tag: `<span class="dot" style="background:${TIER_C[p.tier]}"></span>`, t: byId[p.id].headline, s: `${p.source}${p.lane ? ' · ' + p.lane : ''} · slides ${3 + i * 2}–${4 + i * 2}` })),
     ...d.alsoOnRadar.slice(0, 5).map((p) => ({ tag: `<span class="dot" style="background:${TIER_C[p.tier]}"></span>`, t: p.title, s: `${p.source}${p.lane ? ' · ' + p.lane : ''}` }))]
  : [...d.picks.map((p, i) => ({ strong: true, tag: `<span class="dot" style="background:${STAGE_C[p.stage] || '#475467'}"></span>`, t: byId[p.id].headline, s: `${p.country} · ${p.stage} · slides ${3 + i * 2}–${4 + i * 2}` })),
     ...d.others.slice(0, 5).map((p) => ({ tag: `<span class="dot" style="background:${STAGE_C[p.stage] || '#475467'}"></span>`, t: p.name, s: `${p.country} · ${p.stage || p.sector}${p.subsector ? ' · ' + p.subsector : ''}` }))];
const glance = slide(`<div class="k">${SERIES === 'flow' ? 'Yesterday at a glance' : 'The week at a glance'}</div>
  <h2 class="sm">${SERIES === 'flow' ? `${d.totals.signals} signals, ${d.totals.critical} critical. The three that matter most, then the rest of the radar.` : `${d.totals.projects} new projects in ${d.totals.countries} countries over the last 7 days. The three most significant, then the rest.`}</h2>
  <div class="gl-list">${glanceRows.map((r, i) => `${i === 3 ? '<div class="sep">Also on the radar</div>' : ''}<div class="gr${r.strong ? ' st' : ''}">${r.tag}<div><b>${esc(r.t)}</b><span>${esc(r.s)}</span></div></div>`).join('')}</div>`, 2);

const storySlides = d.picks.flatMap((p, i) => { const x = byId[p.id];
  const a = slide(`${photo(PH[i], 500)}<div class="body">
    <div class="k">${label} ${i + 1} of 3</div><div class="chips">${chipsFor(p)}</div>
    <h2>${esc(x.headline)}</h2>
    <div class="stat"><b>${esc(x.statValue)}</b><span>${esc(x.statLabel)}</span></div>
    <p class="what">${esc(x.what)}</p></div>`, 3 + i * 2, 'photo');
  const b = slide(`<div class="k">${label} ${i + 1} of 3 · ${SERIES === 'flow' ? 'why it matters' : 'the opportunity'}</div>
    <div class="h3">${esc(x.headline)}</div>
    ${SERIES === 'flow' ? `<div class="blk"><b>Why it matters</b><p>${esc(x.why)}</p></div>` : `<div class="blk"><b>Who</b><p>${esc(x.who)}</p></div><div class="blk"><b>Opportunity for</b><p>${esc(x.angle)}</p></div>`}
    <div class="blk"><b>Key facts</b><ul>${x.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
    <div class="blk watch"><b>What to watch</b><p>${esc(x.watch)}</p></div>
    <div class="meta">${SERIES === 'flow' && p.lane ? `<div><span>Lane</span>${esc(p.lane)} · ${esc(p.laneFlow)}</div>` : ''}<div><span>Source</span>${src(p)}</div></div>`, 4 + i * 2);
  return [a, b]; });

let board;
if (SERIES === 'flow') {
  const maxP = Math.max(...d.lanes.map((l) => Math.max(l.p, l.pp)), 1);
  const st = (p) => (p >= 30 ? 'High' : p >= 10 ? 'Elevated' : p > 0 ? 'Watch' : 'Quiet');
  board = slide(`<div class="k">Lane risk board · last 7 days</div>
    <div class="bhead">${GLOBE ? `<div class="gsm" style="background-image:url('${GLOBE}')"></div>` : ''}<p class="lead2">${esc(N.board)}</p></div>
    <div class="lg"><span><i class="now"></i>Last 7 days</span><span><i class="prev"></i>7 days before</span></div>
    ${d.lanes.map((l) => `<div class="cb"><div class="cb-n">${esc(l.name)}${l.today ? ` <em>+${l.today}</em>` : ''}</div><div class="cb-b"><i class="now" style="width:${(l.p / maxP * 100).toFixed(1)}%"></i><i class="prev" style="width:${(l.pp / maxP * 100).toFixed(1)}%"></i></div><div class="cb-v st-${st(l.p).toLowerCase()}">${st(l.p)}</div></div>`).join('')}
    <p class="fine">Pressure = critical×3 + elevated×2 + watch×1 over 7 days · +N = signals on ${esc(DATE_SHORT)}</p>`, 9);
} else {
  const maxS = Math.max(...d.byStage.map((x) => x[1]), 1);
  const bars = (rows) => { const m = Math.max(...rows.map((r) => r[1]), 1); return rows.slice(0, 5).map(([k, n]) => `<div class="hb"><span>${esc(k)}</span><i style="width:${(n / m * 100).toFixed(1)}%"></i><b>${n}</b></div>`).join(''); };
  board = slide(`<div class="k">Pipeline · last 7 days</div>
    <div class="bhead">${GLOBE ? `<div class="gsm" style="background-image:url('${GLOBE}')"></div>` : ''}<p class="lead2">${esc(N.board)}</p></div>
    <div class="stg">${d.byStage.map(([s, n]) => `<div><i style="height:${(n / maxS * 100).toFixed(1)}%;background:${STAGE_C[s]}"></i><b>${n}</b><span>${s}</span></div>`).join('')}</div>
    <div class="two"><div><b class="t">By region</b>${bars(d.byRegion)}</div><div><b class="t">By sector</b>${bars(d.bySector)}</div></div>`, 9);
}
const cta = SERIES === 'flow'
  ? slide(`<div class="k">Every signal, every day</div><h2>All ${d.totals.signals} of yesterday's signals are pinned on the live trade-flow map</h2><div class="url">worldtradepro.com</div>
    <p class="lead">Free. Updated every weekday. Lane pages with 13-week history at worldtradepro.com/trade-lanes</p><div class="follow">Follow World Trade Pro for tomorrow's scan</div>`, 10, 'dark')
  : slide(`<div class="k">Every project, every country</div><h2>Project trackers for 66 countries, updated every day</h2><div class="url">worldtradepro.com/projects</div>
    <p class="lead">Owners, contractors, stages and sources in one place. Free.</p><div class="follow">Follow World Trade Pro Infrastructure for tomorrow's scan</div>`, 10, 'dark');
const slides = [cover, glance, ...storySlides, board, cta];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;font-family:'IBM Plex Sans',sans-serif;color:#101828}
.s{width:${S.w}px;height:${S.h}px;padding:88px 84px 0;position:relative;overflow:hidden;background:#fff;border-top:14px solid ${T.main}}
.s.dark{background:${T.main};color:#fff;border-top-color:${T.accent}}
.s.photo,.s.cover{padding-top:0}
.k{font-size:25px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${T.kick};margin-bottom:24px}.dark .k{color:${T.accent}}
h1{font:600 60px/1.1 Newsreader,serif;margin:0}h2{font:600 calc(52px*var(--fs,1))/1.14 Newsreader,serif;margin:0 0 26px}h2.sm{font-size:44px;margin-bottom:34px}
.ph{margin:0 -84px;background-size:cover;background-position:center;background-color:#1d2939}.ph.none{background:linear-gradient(135deg,${T.main},#344054)}
.cr{margin:0 -84px;padding:7px 84px;font-size:15px;line-height:1.3;color:#667085;background:#f2f4f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cover .cr{background:rgba(0,0,0,.25);color:#b9c6da}
.datebox{position:absolute;left:84px;top:668px;display:flex;align-items:baseline;gap:20px}.datebox b{font:600 58px/1 Newsreader,serif;color:${T.accent}}.datebox span{font-size:24px;color:#c9d6ea;font-weight:600;letter-spacing:.04em}
.cv{position:absolute;left:84px;right:84px;top:760px}.cv .k{margin-bottom:14px}
.row3{position:absolute;left:84px;right:84px;bottom:100px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.bs{border:2px solid rgba(255,255,255,.25);border-radius:14px;padding:16px 22px}.bs b{display:block;font:600 54px/1 Newsreader,serif}.bs span{font-size:21px;color:#c9d6ea}
.swipe{position:absolute;right:36px;top:26px;background:rgba(0,0,0,.55);padding:8px 18px;border-radius:8px;font-size:28px;font-weight:700;color:${T.accent}}
.body{padding-top:30px}
.chips{display:flex;flex-wrap:wrap;gap:12px;margin:-6px 0 22px}.chip{font-size:22px;font-weight:700;color:#fff;border-radius:999px;padding:6px 17px}.chip.o{background:${T.tint};color:#344054;border:2px solid #e4e7ec}
.stat{display:flex;align-items:baseline;gap:22px;margin:-6px 0 18px}.stat b{font:600 84px/1 Newsreader,serif;color:${T.main};white-space:nowrap}.stat span{font-size:25px;line-height:1.3;color:#475467;font-weight:600}
.what{font-size:calc(31px*var(--fs,1));line-height:1.42;color:#344054;margin:0}
.h3{font:600 calc(40px*var(--fs,1))/1.18 Newsreader,serif;color:#475467;margin:-4px 0 26px}
.blk{border-top:2px solid #eaecf0;padding:calc(24px*var(--fs,1)) 0 calc(10px*var(--fs,1))}.blk b{display:block;font-size:21px;letter-spacing:.1em;text-transform:uppercase;color:${T.kick};margin-bottom:8px}.blk p{font-size:calc(33px*var(--fs,1));line-height:1.42;margin:0;color:#344054}
.blk ul{margin:0;padding:0;list-style:none}.blk li{font-size:calc(31px*var(--fs,1));line-height:1.38;color:#344054;padding:0 0 calc(16px*var(--fs,1)) 36px;position:relative}.blk li:before{content:'';position:absolute;left:0;top:14px;width:14px;height:14px;border-radius:3px;background:${T.accent}}
.blk.watch p{font-weight:600;color:#101828}
.meta{position:absolute;left:84px;right:84px;bottom:96px;font-size:21px;color:#667085;line-height:1.5}.meta span{display:inline-block;min-width:110px;font-weight:700;color:#98a2b3;text-transform:uppercase;letter-spacing:.08em;font-size:18px}
.gl-list .gr{display:grid;grid-template-columns:30px 1fr;gap:14px;padding:17px 0;border-top:2px solid #eaecf0}.gr .dot{width:16px;height:16px;border-radius:50%;margin-top:11px}
.gr b{display:block;font-size:calc(29px*var(--fs,1));line-height:1.28;font-weight:600;color:#101828}.gr span{font-size:22px;color:#667085}.gr.st b{font-size:calc(32px*var(--fs,1))}
.gr:not(.st) b{font-weight:400;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sep{font-size:20px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#98a2b3;padding:20px 0 6px;border-top:4px solid ${T.main}}
.bhead{display:flex;gap:28px;align-items:center;margin:-4px 0 18px}.gsm{flex:0 0 190px;height:190px;border-radius:50%;background-size:cover;background-position:center;box-shadow:0 0 0 6px ${T.tint}}
.lead2{font-size:calc(29px*var(--fs,1));line-height:1.4;color:#344054;margin:0}
.lg{display:flex;gap:30px;font-size:21px;color:#667085;margin:0 0 6px}.lg i{display:inline-block;width:28px;height:14px;border-radius:3px;margin-right:9px;vertical-align:middle}
i.now{background:${T.main}}i.prev{background:#c3cad5}
.cb{display:grid;grid-template-columns:380px 1fr 150px;gap:18px;align-items:center;padding:12px 0;border-bottom:2px solid #eaecf0}
.cb-n{font-size:24px;font-weight:600;line-height:1.2}.cb-n em{font-style:normal;color:#b42318;font-size:20px;margin-left:6px}.cb-b i{display:block;height:14px;border-radius:0 5px 5px 0;min-width:3px}.cb-b i+i{margin-top:3px}
.cb-v{font-size:22px;font-weight:700;text-align:right}.st-high{color:#b42318}.st-elevated{color:#b54708}.st-watch{color:#475467}.st-quiet{color:#98a2b3}
.fine{font-size:19px;color:#98a2b3;margin-top:12px}
.stg{display:flex;gap:18px;align-items:flex-end;height:250px;margin:6px 0 26px}.stg div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}.stg i{display:block;width:100%;border-radius:8px 8px 0 0;min-height:4px}.stg b{font:600 40px/1.2 Newsreader,serif;margin-top:6px}.stg span{font-size:20px;color:#667085}
.two{display:grid;grid-template-columns:1fr 1fr;gap:40px}.two .t{display:block;font-size:21px;letter-spacing:.1em;text-transform:uppercase;color:${T.kick};margin-bottom:10px}
.hb{display:grid;grid-template-columns:1fr;gap:4px;padding:8px 0;border-top:2px solid #eaecf0;position:relative}.hb span{font-size:22px;color:#344054;padding-right:50px}.hb i{display:block;height:12px;border-radius:0 5px 5px 0;background:${T.main};min-width:3px}.hb b{position:absolute;right:0;top:8px;font-size:22px}
.url{display:inline-block;background:${T.accent};color:#101828;font-size:40px;font-weight:700;padding:22px 32px;border-radius:12px;margin:6px 0 40px}
.lead{font-size:32px;line-height:1.4;color:#c9d6ea}.follow{position:absolute;left:84px;bottom:140px;font-size:29px;font-weight:600}
footer{position:absolute;left:84px;right:84px;bottom:40px;display:flex;justify-content:space-between;font-size:18px;letter-spacing:.1em;color:#98a2b3;font-weight:600}.dark footer{color:#8fa3c4}
</style></head><body>${slides.join('')}</body></html>`;
writeFileSync(join(OUT, 'carousel.html'), html);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: S.w, height: S.h }, deviceScaleFactor: 2 });
await page.goto(fileUrl(join(OUT, 'carousel.html')));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
const els = await page.$$('section.s');
// overflow guard: content must end above the meta block / stats row / footer
// auto-fit: a slide whose text runs into its meta block / stats row / footer gets its body type scaled down in 4% steps
// (to 78% at most); only a slide that still does not fit fails the run (quality guard)
await page.$$eval('section.s', (ss) => ss.forEach((s) => {
  const fits = () => { const f = s.querySelector('footer').getBoundingClientRect().top; const m = s.querySelector('.meta,.row3,.follow'); const lim = m ? m.getBoundingClientRect().top : f;
    const kids = [...s.querySelectorAll('.blk,.cb,.gr,.lead2,h2,.what,.two,.stg,.url,.lead,.cv')].filter((e) => !e.closest('.meta')); return Math.max(0, ...kids.map((e) => e.getBoundingClientRect().bottom)) <= lim - 6; };
  for (let fs = 1; !fits() && fs > 0.78; ) { fs = Math.round((fs - 0.04) * 100) / 100; s.style.setProperty('--fs', fs); }
}));
const over = await page.$$eval('section.s', (ss) => ss.map((s, i) => { const f = s.querySelector('footer').getBoundingClientRect().top; const m = s.querySelector('.meta,.row3,.follow'); const lim = m ? m.getBoundingClientRect().top : f;
  const kids = [...s.querySelectorAll('.blk,.cb,.gr,.lead2,h2,.what,.two,.stg,.url,.lead,.cv')].filter((e) => !e.closest('.meta')); const bottom = Math.max(0, ...kids.map((e) => e.getBoundingClientRect().bottom)); return bottom > lim - 6 ? i + 1 : 0; }).filter(Boolean));
if (over.length) { console.error('TEXT OVERFLOW on slide(s):', over.join(', ')); if (!args.includes('--allow-overflow')) process.exitCode = 3; }
rmSync(join(OUT, 'pdfpages'), { recursive: true, force: true });
mkdirSync(join(OUT, 'pdfpages'), { recursive: true });
for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: join(OUT, 'pdfpages', `p${String(i + 1).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 90 });
await browser.close();
// flattened JPEG pages in the PDF: LinkedIn's converter paints transparent layers black
const pages = els.map((_, i) => join(OUT, 'pdfpages', `p${String(i + 1).padStart(2, '0')}.jpg`));
execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import sys; from PIL import Image; ims=[Image.open(p).convert("RGB") for p in sys.argv[3:]]; ims[0].save(sys.argv[1], save_all=True, append_images=ims[1:], resolution=192.0); ims[0].resize((1080, 1350), Image.LANCZOS).save(sys.argv[2], quality=88)', join(OUT, 'carousel.pdf'), join(OUT, 'cover.jpg'), ...pages], { stdio: 'inherit' });

// ================================================================ caption (fixed skeleton; no link in the text - LinkedIn cuts reach for external links)
const TAGS = SERIES === 'flow' ? '#TradeFlow #CommodityTrading #Shipping #EnergyMarkets #SupplyChain' : '#EPC #Infrastructure #ProjectFinance #Construction #BusinessDevelopment';
const caption = `${SERIES_NAME} · ${DAYW}, ${DATE_SHORT} · #${d.issue}

${N.hook}

${d.picks.map((p) => `▪️ ${SERIES === 'infra' && p.flag ? p.flag + ' ' : ''}${byId[p.id].headline}`).join('\n')}

👉 Swipe for ${SERIES === 'flow' ? 'what happened, why it matters and the 9-lane risk board' : 'who is involved, where the opportunity is and the week\'s full pipeline'}.

💬 ${N.question}

${TAGS}`;
writeFileSync(join(OUT, 'linkedin.txt'), caption);
const docTitle = `${SERIES_NAME} · ${DATE_SHORT}`;
writeFileSync(join(OUT, 'assets.json'), JSON.stringify({ series: SERIES, date: DATE, scanDay: d.scanDay, issue: d.issue, docTitle, pdf: 'carousel.pdf', cover: 'cover.jpg', caption, photos: PH.map((r) => r?.id || null), coverPhoto: COVER?.id || null, pickIds: d.picks.map((p) => p.id) }, null, 2));
// remember the photos only when this run is the one that gets published (--commit-photos in the workflow)
if (args.includes('--commit-photos')) { USED[DATE + ':' + SERIES] = [COVER, ...PH].filter(Boolean).map((r) => r.id); mkdirSync(dirname(USED_F), { recursive: true }); writeFileSync(USED_F, JSON.stringify(USED, null, 2)); }
console.log(`rendered ${els.length} slides -> ${OUT}`);
