// World Trade Pro Weekly - the one e-mail (Tuesdays), built from the public API only.
//   "The 10 things worth a call this week": tenders and awards with a name / value / deadline, new projects by sector,
//   the trade flows that changed and what they mean for buyers and shippers. One build per week -> tagged blocks
//   (newsletter/out/<date>-weekly.blocks.json); ses_send.mjs assembles a personal version per subscriber
//   (newsletter_assemble.mjs: the reader's sectors first and in full, the rest folded; section order by role).
// Also writes the default HTML (no preferences) + .json meta, and preview HTML for a few reader profiles when --preview.
// Usage:  node newsletter_weekly.mjs [--date YYYY-MM-DD] [--preview]      (date = the Tuesday of sending; covers the 7 days before)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, hostOf, similar, score, summaryOf, tokens, NOT_EPC, dealOf } from './common.mjs';
import { existsSync } from 'node:fs';
import { SECTORS, SECTOR_ORDER, sectorKeyOf, C, font, esc, row, para, link, box, pill, sectorPill, badge, colorOf, assemble, document as doc } from './newsletter_assemble.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const W = nl.weekly || {};
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const API = cfg.site + '/wp-json/wtp/v1';
const OUT = join(HERE, 'newsletter', 'out');
const NAME = `${TODAY}-weekly`;
const FROM = dayShift(TODAY, -7), TO = dayShift(TODAY, -1);
const PFROM = dayShift(TODAY, -14), PTO = dayShift(TODAY, -8);   // the week before, for the deltas
// Editorial notes (weekly_editor.mjs, or written by hand): { lede_html, deals_why: {deal name: sentence}, flows_why: {url: sentence}, signoff }
const NOTES_FILE = join(HERE, 'newsletter', 'notes', `${NAME}.json`);
const NOTES = existsSync(NOTES_FILE) ? JSON.parse(readFileSync(NOTES_FILE, 'utf8')) : null;

const utm = (u, content) => { const url = new URL(u); url.searchParams.set('utm_source', 'newsletter'); url.searchParams.set('utm_medium', 'email'); url.searchParams.set('utm_campaign', 'weekly-' + TODAY); if (content) url.searchParams.set('utm_content', content); return url.toString(); };
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const blocked = (cfg.blockedWords || []).map((w) => w.toLowerCase());
const ok = (it) => it.source_url && !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w));
const isNA = (s) => !s || /^(n\/?a|unknown|none|not specified|-)$/i.test(clean(s));
const gnews = (it) => hostOf(it.source_url) === 'news.google.com' && clean(it.project_name).match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
const title = (it) => { const g = gnews(it); return g ? g[1] : clean(it.project_name); };
const source = (it) => { const g = gnews(it); return esc(g ? g[2] : it.source_name || hostOf(it.source_url)); };
// Official notices (TED / Find a Tender / World Bank) carry a generated one-liner that only repeats value, buyer and winner -
// the fact line already shows those, so no snippet for them.
const OFFICIAL = /^(EU|UK|World Bank|WB) (contract|open tender|tender|notice|procurement)/i;
const snippet = (desc, max) => { if (OFFICIAL.test(clean(desc))) return ''; const s = summaryOf(desc, max); if (s) return s; const t = clean(desc); return t.length > 60 ? cut(t, Math.min(max, t.length - 1)) : ''; };
const isoWeek = (iso) => { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4)); return [y, 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)]; };
const [YEAR, WEEK] = isoWeek(FROM);
const issueNo = Math.max(1, Math.round((Date.parse(TODAY) - Date.parse(W.firstIssue || TODAY)) / (7 * 864e5)) + 1);
const SLUG = `world-trade-pro-weekly-${YEAR}-w${String(WEEK).padStart(2, '0')}`;
const ISSUE_URL = `${cfg.site}/blog/${SLUG}/`;   // the web version (weekly_web.mjs + weekly_web_publish.mjs), published before the send
// the PDF report (weekly_pdf.mjs) is served from the images branch through jsDelivr (application/pdf), so its URL is known before the send
const PDF_URL = `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY || 'worldtradepro/wtp-linkedin-bot'}@images/weekly/${SLUG}/WorldTradePro-Weekly-${YEAR}-W${String(WEEK).padStart(2, '0')}.pdf`;

// ---------------------------------------------------------------- data
const [epcRes, flowRes, lw, pEpcRes, pFlowRes] = await Promise.all([
  fetchJson(`${API}/opportunities?report_type=epc&from=${FROM}&to=${TO}&limit=1000`),
  fetchJson(`${API}/opportunities?report_type=flow_distortion&from=${FROM}&to=${TO}&limit=1000`),
  fetchJson(`${API}/lane-weeks?weeks=4`),
  fetchJson(`${API}/opportunities?report_type=epc&from=${PFROM}&to=${PTO}&limit=1000`),
  fetchJson(`${API}/opportunities?report_type=flow_distortion&from=${PFROM}&to=${PTO}&limit=1000`),
]);
// one project = one name: the radar keeps a row per report, so same-name rows (several outlets, TED repeats) are merged here,
// keeping the row with the most advanced stage. Every count in the issue (tiles, chart, lists) uses this merged set.
const mergeByName = (items) => { const out = []; for (const it of [...items].sort((a, b) => (stageNo(b.stage) - stageNo(a.stage)) || (b.report_date > a.report_date ? 1 : -1))) { if (!out.some((p) => similar(p.project_name, it.project_name))) out.push(it); } return out; };
const stageNo = (s) => parseInt((String(s || '').match(/^S(\d)/) || [])[1] || '0', 10);
const epcRaw = (epcRes.items || []).filter(ok).filter((it) => !NOT_EPC.test(`${it.project_name} ${it.description}`))
  .map((it) => ({ ...it, moved: it.latest_stage && it.latest_stage !== it.stage ? it.stage : '', stage: it.latest_stage || it.stage, key: sectorKeyOf(it) }));
const epc = mergeByName(epcRaw);
// news signals: the radar's market label is reliable (Energy / Metals / Agriculture / Shipping); only Policy items need the text
const FLOWKEY = { energy: 'energy', metals: 'metals', agriculture: 'agri', shipping: 'shipping' };
const flowKey = (it) => FLOWKEY[(it.sector || '').toLowerCase()] || sectorKeyOf(it);
const stripBoiler = (d) => clean(d).replace(/\s*The post .*? appeared first on .*$/i, '').replace(/\s*Read more.*$/i, '');
const flow = (flowRes.items || []).filter(ok).map((it) => ({ ...it, description: stripBoiler(it.description), key: flowKey(it) }));
const weeks = lw.weeks || [];
let COUNTRY_PAGES = new Set();
try { const xml = await (await fetch(`${cfg.site}/wp-sitemap-intel-1.xml`, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } })).text(); COUNTRY_PAGES = new Set([...xml.matchAll(/\/projects\/([a-z0-9-]+)\//g)].map((m) => m[1])); } catch {}
const slugOf = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const countryLink = (it, bold = false) => {
  const name = countryName(it.country); if (!name || isNA(name)) return '';
  const slug = slugOf(name); const label = `${flagOf(it.country)} ${esc(name)}`;
  return COUNTRY_PAGES.has(slug) ? `<a href="${esc(utm(`${cfg.site}/projects/${slug}/`, 'country-' + slug))}" style="color:${bold ? C.ink : C.muted};text-decoration:none;font-weight:${bold ? 700 : 400};">${label}</a>` : label;
};

// ---------------------------------------------------------------- 1. worth a call: deals with a name, value or deadline
const STAGE = {
  S1: ['Feasibility', 'Consultants and FEED contractors position now; the equipment list comes later.'],
  S2: ['Development', 'The owner is building the project team (FEED, permits, finance): the time to get on the bidder list.'],
  S3: ['Pre-FID', 'Close to the investment decision; main EPC and long-lead equipment packages are being prepared.'],
  S4: ['Tender', 'The tender is out: bidders are forming consortia and pricing equipment and subcontracts now.'],
  S5: ['Awarded', 'Contract awarded: the winner now buys equipment and places subcontracts.'],
};
const stageKey = (s) => (clean(s).match(/^S(\d)/) || [])[0] || '';
const SCALE_RANK = { Mega: -1, Large: 0, Medium: 1, Small: 2 };
const dealsAll = [];
for (const it of epc.filter((x) => ['S4', 'S5'].includes(stageKey(x.stage)))) {
  const d = dealOf(it);
  if (dealsAll.some((x) => x.name.toLowerCase() === d.name.toLowerCase() || similar(x.name, d.name))) continue;
  // a deal is "worth a call" when the notice names money, a counterparty or a deadline
  const substance = (d.usd ? 2 : 0) + (d.who ? 1 : 0) + (d.deadline ? 1 : 0) + (SCALE_RANK[it.scale] <= 0 ? 1 : 0);
  if (!substance) continue;
  dealsAll.push({ ...d, it, substance, strong: !!d.usd || (!!d.who && !!d.deadline), tender: stageKey(it.stage) === 'S4' });
}
dealsAll.sort((a, b) => b.substance - a.substance || (b.usd || 0) - (a.usd || 0));
const callCard = (d) => {
  const it = d.it, [st] = STAGE[stageKey(it.stage)] || [''];
  const who = d.who ? `<b style="color:${C.ink};">${esc(d.who)}</b>` : (isNA(it.company_name) ? '' : `<b style="color:${C.ink};">${esc(clean(it.company_name))}</b>`);
  const facts = [badge(esc(st), d.tender ? '#b45309' : '#15803d'), countryLink(it, true), d.value ? badge(esc(d.value), C.navy) : '', d.tender && d.deadline ? badge(`bids due ${esc(d.deadline)}`, '#b42318') : '',
    who ? ({ winner: 'won by ', buyer: 'buyer ' }[d.role] || '') + who : ''].filter(Boolean);
  const name = d.who || clean(it.company_name);
  const call = d.tender
    ? (d.who ? `Ask ${esc(d.who)} for the bid documents${d.deadline ? ` before ${esc(d.deadline)}` : ''}.` : 'Pull the bid documents from the notice and line up partners.')
    : (d.who ? `${esc(d.who)} is now buying equipment and placing subcontracts. Get on their vendor list.` : 'Find the winner and get on their vendor list.');
  const buyer = d.tender
    ? `A peer is buying this scope${d.value ? ` at an estimated ${esc(d.value)}` : ''}; a live comparison for your own package${d.deadline ? ` (their bids close ${esc(d.deadline)})` : ''}.`
    : `${d.value ? `Reference price: ${esc(d.value)} for this scope in ${esc(countryName(it.country) || 'this market')}. ` : ''}${name && !isNA(name) ? `${esc(name)} is now booked on this job.` : 'The winner\'s team is now committed.'}`;
  const line = (label, text, color) => `<div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:8px;border-top:1px dashed ${C.line};margin-top:8px;"><b style="color:${color};">${label}</b> ${text}</div>`;
  const why = NOTES?.deals_why?.[d.name];
  return {
    html: `<a href="${esc(d.url)}" style="display:block;color:${C.ink};text-decoration:none;font-size:17px;font-weight:700;line-height:1.3;padding:6px 0 6px;">${esc(d.name)}</a>
    <div style="font-size:13px;color:${C.muted};line-height:1.9;">${facts.join(' &nbsp;·&nbsp; ')}</div>${why ? `<div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:8px;">${esc(why)}</div>` : ''}`,
    call: line('The call:', call, C.navy),
    buyer: line('For buyers:', buyer, C.navy),
    why: !!why,
  };
};
// up to 2 per sector so one busy sector cannot take all three default slots; the assembler re-ranks per reader
const calls = []; const perKey = {};
for (const d of dealsAll) { const k = d.it.key; if ((perKey[k] || 0) >= 2) continue; perKey[k] = (perKey[k] || 0) + 1; calls.push({ key: k, sector: SECTORS[k], strong: d.strong, name: d.name, ...callCard(d) }); if (calls.length >= 9) break; }

// ---------------------------------------------------------------- 2. new projects by sector
const sectorOf = (it) => [clean(it.subsector)].filter((x) => x && !/^unknown$/i.test(x)).join('');
// every project of the week, per sector, for the web issue (weekly_web.mjs): name, stage, country, scale, company, value, deadline
const full = {};
for (const k of SECTOR_ORDER) {
  const items = epc.filter((it) => it.key === k).sort((a, b) => (SCALE_RANK[a.scale] ?? 3) - (SCALE_RANK[b.scale] ?? 3) || (b.report_date > a.report_date ? 1 : -1));
  if (!items.length) continue;
  const seen = [];
  full[k] = items.map((it) => {
    const d = dealOf(it), sk = stageKey(it.stage);
    return { name: clean(it.project_name), url: it.source_url, stageKey: sk, usd: d.usd || 0, stage: (STAGE[sk] || [clean(it.stage) || ''])[0], country: countryName(it.country) && !isNA(countryName(it.country)) ? `${flagOf(it.country)} ${countryName(it.country)}` : '', scale: it.scale && it.scale !== 'Unknown' ? it.scale : '', company: isNA(it.company_name) ? '' : clean(it.company_name), sub: sectorOf(it), value: d.value, deadline: sk === 'S4' ? d.deadline : '' };
  });
}


const projRow = (it) => {
  const [st] = STAGE[stageKey(it.stage)] || [''];
  const stColor = { Tender: '#b45309', Awarded: '#15803d', 'Pre-FID': '#7c3aed' }[st] || C.muted;
  const bits = [st ? `<b style="color:${stColor};">${esc(st)}</b>` : '', countryLink(it), esc(sectorOf(it)), it.scale && it.scale !== 'Unknown' ? esc(it.scale) : '', isNA(it.company_name) ? '' : esc(clean(it.company_name))].filter(Boolean);
  return row(`<a href="${esc(it.source_url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:15px;line-height:1.4;">${esc(clean(it.project_name))}</a><br><span style="color:${C.muted};font-size:12.5px;line-height:1.5;">${bits.join(' · ')}</span>`, `7px 0;border-top:1px solid ${C.line}`);
};
const usedInCalls = new Set(calls.map((c) => c.html));
const projects = [];
for (const k of SECTOR_ORDER) {
  const items = epc.filter((it) => it.key === k);
  if (!items.length) continue;
  // large first, then earlier stage, newest; one per project name, max 2 per country in the visible rows
  const sorted = [...items].sort((a, b) => (SCALE_RANK[a.scale] ?? 3) - (SCALE_RANK[b.scale] ?? 3) || (b.report_date > a.report_date ? 1 : -1));
  const rows = [], per = {}, seen = [];
  for (const it of sorted) {
    if (seen.some((n) => similar(n, it.project_name))) continue;
    const c = it.country || '-'; if ((per[c] || 0) >= 2) continue;
    per[c] = (per[c] || 0) + 1; seen.push(it.project_name); rows.push(projRow(it));
    if (rows.length >= 8) break;
  }
  projects.push({ key: k, count: items.length, rows, moreUrl: utm(ISSUE_URL, 'more-' + k) + '#sec-' + k });
}

// ---------------------------------------------------------------- 3. flows that changed
const idx = (c) => (c ? c.crit * 3 + c.elev * 2 + c.watch : 0);
const lanes = LANES.map((l) => { const hist = weeks.map((w) => w.lanes?.[l.id] || null); const now = hist[0] || { crit: 0, elev: 0, watch: 0 }, prev = hist[1] || { crit: 0, elev: 0, watch: 0 }; return { l, now, prev, n: now.crit + now.elev + now.watch, p: idx(now), pp: idx(prev) }; }).sort((a, b) => b.p - a.p || b.n - a.n);
const status = (p) => (p >= 30 ? ['High', '#b42318'] : p >= 10 ? ['Elevated', '#b54708'] : p > 0 ? ['Watch', '#475467'] : ['Quiet', '#98a2b3']);
const change = (a, b) => (a > b ? `<span style="color:#b42318;font-weight:700;">▲ more pressure</span>` : a < b ? `<span style="color:#027a48;font-weight:700;">▼ easing</span>` : `<span style="color:${C.muted};">— unchanged</span>`);
// cluster the week's signals (same story from several outlets), strongest first
function related(a, b) { if (similar(a, b)) return true; const A = tokens(a), B = tokens(b); let s = 0; for (const w of A) if (B.has(w)) s++; return s >= 2 && s / Math.min(A.size, B.size) >= 0.33; }
const clusters = [];
for (const it of [...flow].filter((x) => score(x) >= (nl.minFlowScore || 8)).sort((a, b) => score(b) - score(a) || (b.report_date > a.report_date ? 1 : -1))) {
  const c = clusters.find((x) => [x.lead, ...x.more].some((m) => related(m.project_name, it.project_name)));
  if (c) c.more.push(it); else clusters.push({ lead: it, more: [] });
}
// what a flow signal means for the people who buy or ship the goods: by lane, else by sector
// "What it means": the direction the HEADLINE points (less moving, more moving, corridor at risk, rules, freight) for the people
// who buy or move that commodity. Deterministic on purpose: every sentence must be true of any story that matches its cue.
const WHO = { energy: 'crude, LNG and product buyers', metals: 'concentrate and metal buyers', agri: 'grain and food importers', shipping: 'shippers and forwarders',
  chem: 'fertilizer and chemical buyers', power: 'utilities and IPPs', infra: 'project teams', recycling: 'scrap traders', equipment: 'equipment buyers' };
const RISK = /attack|strike|seiz|blockad|closure|closed|halt|suspend|sanction|\bban\b|embargo|shut/i;
const NEG = /drop|fall|fell|declin|slump|plunge|\bcut|lower|shortage|tight|delay|disrupt|congest|bottleneck|curb|restrict/i;
const POS = /surge|soar|jump|record|high|rise|rising|increase|boost|comeback|ramp|expand|raise|reopen|resume|ease|more ships|more cargo|lift/i;
const RULE = /tariff|dut(y|ies)|quota|\brule|regulat|licen[cs]e|export control|customs|inspection regime/i;
const FREIGHT = /freight|\brates?\b|tanker|charter|tonnage|\bslots?\b|transit|canal|port fee/i;
const dirOf = (t) => (RISK.test(t) ? 'risk' : NEG.test(t) ? 'neg' : POS.test(t) ? 'pos' : RULE.test(t) ? 'rule' : FREIGHT.test(t) ? 'freight' : '');
const SENT = (w, key) => key === 'shipping' ? {
  risk: `This corridor is at risk: ${w} should map the alternative routing now and budget the extra days and insurance.`,
  neg: `Less capacity on this route: ${w} should book early and expect queues and higher slot premiums.`,
  pos: `More capacity on this route: ${w} can expect shorter queues and softer slot premiums, usually within weeks.`,
  rule: `The rules changed, not the ships: ${w} should check paperwork, fees and transit conditions before the next booking.`,
  freight: `The freight leg is what changed: ${w} should re-price door-to-door before committing the next shipment.`,
  '': `${w} should watch this route; it is on the radar for a reason.`,
} : {
  risk: `Supply through this corridor is at risk: ${w} should line up alternative origins and price the re-routing before the next fixture.`,
  neg: `Less is moving from this origin: ${w} can expect firmer offers and longer lead times for a few weeks.`,
  pos: `More is moving from this origin: ${w} get more offers and softer premiums; freight on the route tends to follow.`,
  rule: `The rules changed, not the volumes: ${w} should check paperwork, origin and duty before loading.`,
  freight: `The freight leg is what changed: ${w} should re-price landed cost before fixing the next cargo.`,
  '': `${w} should watch this origin; it is on the radar for a reason.`,
};
const meansFor = (it, l, lr) => {
  const w = WHO[it.key] || WHO.shipping;
  const dir = dirOf(title(it)) || dirOf(it.description || '');
  const core = SENT(w, it.key)[dir];
  const lane = l ? `The ${esc(l.name)} carries ${esc(l.flow)}${lr && lr.now.crit ? ` and logged ${plural(lr.now.crit, 'critical signal')} this week` : ''}. ` : '';
  return lane + core.charAt(0).toUpperCase() + core.slice(1);
};
const flowItems = [];
const flowPer = {};
for (const c of clusters.slice(0, 14)) {
  if ((flowPer[c.lead.key] || 0) >= 2) continue; flowPer[c.lead.key] = (flowPer[c.lead.key] || 0) + 1;
  const it = c.lead, l = laneOf(it) || LANES.find((x) => [it, ...c.more].some((m) => x.re.test(m.project_name + ' ' + m.description)));
  const lr = l && lanes.find((x) => x.l.id === l.id);
  const what = snippet(it.description, 150);
  const means = NOTES?.flows_why?.[it.source_url] ? esc(NOTES.flows_why[it.source_url]) : meansFor(it, l, lr);
  flowItems.push({ key: it.key, url: it.source_url, title: title(it), source: source(it).replace(/&amp;/g, '&'), summary: what, html: row(`<div style="font-size:11px;font-weight:700;color:${C.muted};">${sectorPill(it.key)} ${l ? `&nbsp;${badge(esc(l.name), '#0369a1')}` : ''}</div>
    <a href="${esc(it.source_url)}" style="display:block;color:${C.ink};text-decoration:none;font-size:16px;font-weight:700;line-height:1.35;padding:4px 0 2px;">${flagOf(it.country)} ${esc(title(it))}</a>
    <div style="font-size:12px;color:${C.muted};">${source(it)}${c.more.length ? ` · ${c.more.length + 1} reports this week` : ''}</div>
    ${what && !NOTES?.flows_why?.[it.source_url] ? `<div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:6px;">${esc(what)}</div>` : ''}
    <div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:6px;"><b style="color:${C.ink};">What it means:</b> ${means}</div>`, `12px 0;border-top:1px solid ${C.line}`) });
}
const hot = lanes.filter((x) => x.n > 0);
const laneBoard = hot.length ? row(`<div style="font-size:13px;font-weight:700;color:${C.ink};padding-bottom:4px;">Lane pressure this week</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${hot.slice(0, 4).map((x) => { const [s, col] = status(x.p); return `<tr><td style="${font}font-size:14px;color:${C.text};padding:6px 0;border-top:1px solid ${C.line};"><a href="${esc(utm(`${cfg.site}/trade-lanes/${x.l.id}/`, 'lane-' + x.l.id))}" style="color:${C.ink};text-decoration:none;font-weight:600;">${esc(x.l.name)}</a> <span style="color:${C.muted};font-size:12px;">· ${plural(x.n, 'signal')}</span></td><td style="${font}font-size:13px;padding:6px 0;border-top:1px solid ${C.line};text-align:right;white-space:nowrap;"><span style="color:${col};font-weight:700;">●</span> ${s} &nbsp; ${change(x.p, x.pp)}</td></tr>`; }).join('')}</table>
  <div style="font-size:12px;color:${C.muted};padding-top:6px;">${link('All 9 lanes, week by week →', utm(cfg.site + '/trade-lanes/', 'lanes-hub'), C.muted)}</div>`, '14px 0 0') : '';

// ---------------------------------------------------------------- 4. stage moves (short), tail
const moved = epc.filter((it) => it.moved);
const movesHtml = moved.length ? row(`<div style="font-size:13px;color:${C.muted};"><b style="color:${C.ink};">Stage moves:</b> ${moved.slice(0, 4).map((it) => `${esc(clean(it.project_name))} <span style="white-space:nowrap;">${esc((STAGE[stageKey(it.moved)] || [clean(it.moved)])[0])} → <b>${esc((STAGE[stageKey(it.stage)] || [clean(it.stage)])[0])}</b></span>`).join(' · ')}${moved.length > 4 ? ` · +${moved.length - 4} more` : ''}</div>`, '18px 0 0') : '';
const sponsorMail = `mailto:${nl.ses?.replyTo || 'contact@worldtradepro.com'}?subject=${encodeURIComponent('Sponsor World Trade Pro Weekly')}`;
const sponsor = W.sponsor?.enabled && W.sponsor.name
  ? { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sand};border-radius:8px;"><tr><td style="padding:10px 14px;${font}font-size:13px;line-height:1.5;color:${C.text};"><span style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};">This issue is brought to you by</span><br><b style="color:${C.ink};font-size:14px;">${esc(W.sponsor.name)}</b> — ${esc(W.sponsor.text || '')} ${W.sponsor.url ? link('Learn more →', utm(W.sponsor.url, 'sponsor')) : ''}</td></tr></table>` }
  : null;
const tail = [
  box(`<b style="color:${C.ink};font-size:15px;">Need equipment, spares or services for a project?</b><br><span style="color:${C.text};">Tell us what the project needs; we point you to checked suppliers.</span> ${link('Post a requirement →', utm(cfg.site + '/project-sourcing/#csr-apply', 'sourcing-demand'))}<br><span style="color:${C.text};">Supplier or service provider? </span>${link('List your company →', utm(cfg.site + '/project-sourcing/?side=supply#csr-apply', 'sourcing-supply'))}`, '#fdf6e3', '#ecd9a3'),
  para(`<span style="font-size:13px;color:${C.muted};">${sponsor ? 'Reach the people who build and move commodities: ' : 'Reach ' + (W.audienceLine || 'the people who build and move commodities') + ': '}<a href="${sponsorMail}" style="color:${C.muted};font-weight:700;text-decoration:none;">sponsor this newsletter →</a></span>`, '14px 0 0'),
  nl.promo?.enabled ? para(`<span style="font-size:13px;color:${C.muted};"><b>P.S.</b> New to physical deals? ${esc(nl.promo.title)} walks through one end to end. ${link('Watch the free prologue →', utm(nl.promo.url, 'course'), C.muted)}</span>`, '12px 0 0') : '',
].filter(Boolean);

// ---------------------------------------------------------------- week-on-week, superlatives, bid calendar, sector chart, editor's note
const pEpc = mergeByName((pEpcRes.items || []).filter(ok).filter((it) => !NOT_EPC.test(`${it.project_name} ${it.description}`)));
const pFlow = (pFlowRes.items || []).filter(ok);
const pTenders = pEpc.filter((it) => stageKey(it.stage) === 'S4').length, pAwards = pEpc.filter((it) => stageKey(it.stage) === 'S5').length;
const deltas = { epc: epc.length - pEpc.length, tenders: epc.filter((it) => stageKey(it.stage) === 'S4').length - pTenders, awards: epc.filter((it) => stageKey(it.stage) === 'S5').length - pAwards, flow: flow.length - pFlow.length };

// superlatives: biggest deal, most-named winner, busiest country - each one line, each a link
const winners = {}, winnerUsd = {};
for (const d of dealsAll.filter((x) => !x.tender && x.who)) { winners[d.who] = (winners[d.who] || 0) + 1; winnerUsd[d.who] = (winnerUsd[d.who] || 0) + (d.usd || 0); }
const topWinner = Object.entries(winners).sort((a, b) => b[1] - a[1] || (winnerUsd[b[0]] || 0) - (winnerUsd[a[0]] || 0))[0];
const byCountry = {};
for (const it of epc) { const c = countryName(it.country); if (c && !isNA(c)) byCountry[c] = (byCountry[c] || []).concat(it); }
const topCountry = Object.entries(byCountry).sort((a, b) => b[1].length - a[1].length)[0];
const biggest = [...dealsAll].sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
const supTile = (k, v, sub, href, color) => `<td width="33%" valign="top" style="padding:0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:3px solid ${color};"><tr><td style="padding:8px 2px 0;${font}"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};">${k}</div><div style="font-size:15px;font-weight:700;color:${C.ink};line-height:1.3;padding-top:3px;">${href ? `<a href="${esc(href)}" style="color:${C.ink};text-decoration:none;">${v}</a>` : v}</div><div style="font-size:12px;color:${C.muted};padding-top:2px;">${sub}</div></td></tr></table></td>`;
const superlatives = (biggest || topWinner || topCountry) ? row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px;"><tr>
  ${biggest && biggest.usd ? supTile('Biggest deal', esc(biggest.value), esc(cut(biggest.name, 48)), biggest.url, C.navy) : ''}
  ${topWinner ? supTile('Most awards', esc(cut(topWinner[0], 36)), `${plural(topWinner[1], 'contract')} this week${winnerUsd[topWinner[0]] ? ' · ' + esc(moneyOf(winnerUsd[topWinner[0]])) : ''}`, '', '#15803d') : ''}
  ${topCountry ? supTile('Busiest country', `${flagOf(topCountry[1][0].country)} ${esc(topCountry[0])}`, plural(topCountry[1].length, 'new project'), COUNTRY_PAGES.has(slugOf(topCountry[0])) ? utm(`${cfg.site}/projects/${slugOf(topCountry[0])}/`, 'top-country') : '', '#0369a1') : ''}
</tr></table>`, '22px 0 0') : '';
function moneyOf(usd) { return !usd ? '' : usd >= 1e9 ? `US$${(usd / 1e9).toFixed(1)}bn` : `US$${Math.round(usd / 1e6)}m`; }

// bid calendar: tenders whose notice names a deadline in the next 14 days, soonest first
const calItems = [];
for (const it of epc.filter((x) => stageKey(x.stage) === 'S4')) {
  const m = /deadline (\d{4}-\d{2}-\d{2})/.exec(it.description || '');
  if (!m || m[1] < TODAY || m[1] > dayShift(TODAY, 14)) continue;
  const d = dealOf(it);
  calItems.push({ iso: m[1], key: it.key, name: d.name, value: d.value, country: countryName(it.country), url: d.url, who: d.who });
}
calItems.sort((a, b) => a.iso.localeCompare(b.iso));
const calDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const calendar = calItems.length ? calItems.slice(0, 8).map((c, i, arr) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  <td width="76" valign="top" style="${font}padding:9px 10px 9px 0;border-top:1px solid ${C.line};"><div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${c.iso <= dayShift(TODAY, 3) ? '#b42318' : C.muted};">${calDay(c.iso).split(' ')[0]}</div><div style="font-size:18px;font-weight:800;color:${c.iso <= dayShift(TODAY, 3) ? '#b42318' : C.ink};line-height:1.1;">${calDay(c.iso).split(' ')[1]} <span style="font-size:12px;font-weight:700;color:${C.muted};">${calDay(c.iso).split(' ')[2]}</span></div></td>
  <td valign="top" style="${font}padding:9px 0;border-top:1px solid ${C.line};">${sectorPill(c.key)}<br><a href="${esc(c.url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:14.5px;line-height:1.35;">${esc(cut(c.name, 90))}</a><div style="font-size:12.5px;color:${C.muted};padding-top:2px;">${[c.country ? esc(c.country) : '', c.value ? `<b style="color:${C.ink};">${esc(c.value)}</b>` : '', c.who ? esc(c.who) : ''].filter(Boolean).join(' · ')}</div></td>
</tr></table>`)).join('\n') : '';

// sector chart: one horizontal bar per sector (tenders + awards + other), drawn with table cells so it renders in every mail client
const chartRows = SECTOR_ORDER.map((k) => { const items = epc.filter((it) => it.key === k); return { k, t: items.filter((it) => stageKey(it.stage) === 'S4').length, a: items.filter((it) => stageKey(it.stage) === 'S5').length, o: items.filter((it) => !['S4', 'S5'].includes(stageKey(it.stage))).length, usd: items.reduce((n, it) => n + (dealOf(it).usd || 0), 0) }; })
  .filter((r) => r.t + r.a + r.o > 0).sort((a, b) => (b.t + b.a + b.o) - (a.t + a.a + a.o));
const chartMax = Math.max(1, ...chartRows.map((r) => r.t + r.a + r.o));
const seg = (n, color, title) => (n ? `<td width="${Math.round((n / chartMax) * 100)}%" title="${title}" style="background:${color};height:16px;font-size:1px;line-height:16px;">&nbsp;</td>` : '');
const chart = chartRows.length ? row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${chartRows.map((r) => `<tr><td width="150" style="${font}font-size:12.5px;font-weight:700;color:${C.ink};padding:5px 8px 5px 0;white-space:nowrap;">${esc(SECTORS[r.k])}</td>
    <td style="padding:5px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${seg(r.t, C.accent, 'tenders')}${seg(r.a, C.navy, 'awards')}${seg(r.o, '#D1D5DB', 'earlier stage')}<td style="${font}font-size:12px;color:${C.text};padding-left:8px;white-space:nowrap;"><b>${r.t + r.a + r.o}</b>${r.usd ? ` <span style="color:${C.muted};">· ${esc(moneyOf(r.usd))}</span>` : ''}</td><td width="100%"></td></tr></table></td></tr>`).join('')}
</table>
<div style="font-size:12px;color:${C.muted};padding-top:6px;"><span style="display:inline-block;width:10px;height:10px;background:${C.accent};vertical-align:middle;"></span> tenders &nbsp; <span style="display:inline-block;width:10px;height:10px;background:${C.navy};vertical-align:middle;"></span> awards &nbsp; <span style="display:inline-block;width:10px;height:10px;background:#D1D5DB;vertical-align:middle;"></span> earlier stage &nbsp;·&nbsp; Source: World Trade Pro project radar, ${fmtDay(FROM)} – ${fmtDay(TO)}</div>`, '10px 0 0') : '';
// the chart's title is its conclusion (BP / MGI): the leading sector, its count, and its money if the notices named any
const lead = chartRows[0];
const chartTitle = lead ? `${SECTORS[lead.k]} led the week with ${plural(lead.t + lead.a + lead.o, 'new project')}${lead.usd ? ` and ${moneyOf(lead.usd)} of named contract value` : ''}${chartRows[1] ? `; ${SECTORS[chartRows[1].k].toLowerCase()} next with ${chartRows[1].t + chartRows[1].a + chartRows[1].o}` : ''}.` : '';
// ONE big number (MGI): the biggest deal, with the two other records as small print
const callout = biggest && biggest.usd ? row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};"><tr>
  <td width="42%" valign="top" style="padding:16px 18px;${font}border-right:1px solid ${C.line};"><div style="font-size:38px;font-weight:800;color:${C.navy};line-height:1;letter-spacing:-.02em;">${esc(biggest.value)}</div><div style="font-size:12.5px;color:${C.muted};padding-top:6px;line-height:1.4;">biggest contract of the week</div></td>
  <td valign="top" style="padding:16px 18px;${font}"><a href="${esc(biggest.url)}" style="color:${C.ink};text-decoration:none;font-weight:700;font-size:14.5px;line-height:1.4;">${esc(cut(biggest.name, 70))}</a><div style="font-size:12.5px;color:${C.muted};padding-top:4px;line-height:1.5;">${esc(countryName(biggest.it.country) || '')}${biggest.who ? ` · ${biggest.tender ? 'buyer' : 'won by'} ${esc(cut(biggest.who, 60))}` : ''}</div>
    <div style="font-size:12.5px;color:${C.text};padding-top:8px;line-height:1.6;">${topWinner ? `<b>Most awards:</b> ${esc(cut(topWinner[0], 40))} (${topWinner[1]})<br>` : ''}${topCountry ? `<b>Busiest country:</b> ${flagOf(topCountry[1][0].country)} ${esc(topCountry[0])} (${plural(topCountry[1].length, 'new project')})` : ''}</div></td>
</tr></table>`, '14px 0 0') : superlatives;

// dashboard numbers (PDF + web): the same merged set cut four ways, plus the largest contracts and lane pressure
const countBy = (items, key) => Object.entries(items.reduce((m, it) => { const k = key(it); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
const REGION = (it) => { const r = clean(it.region); return r === 'Asia' ? 'Asia Pacific' : r === 'South America' ? 'Americas' : r || 'Other'; };
const dash = {
  countries: countBy(epc.filter((it) => countryName(it.country) && !isNA(countryName(it.country))), (it) => countryName(it.country)).slice(0, 10).map(([name, n]) => ({ name, n, flag: flagOf(epc.find((it) => countryName(it.country) === name)?.country), slug: COUNTRY_PAGES.has(slugOf(name)) ? `${cfg.site}/projects/${slugOf(name)}/` : '' })),
  regions: countBy(epc, REGION).map(([name, n]) => ({ name, n })),
  stages: ['S1', 'S2', 'S3', 'S4', 'S5'].map((k) => ({ key: k, label: (STAGE[k] || [k])[0], n: epc.filter((it) => stageKey(it.stage) === k).length })),
  topDeals: [...dealsAll].filter((d) => d.usd).sort((a, b) => b.usd - a.usd).slice(0, 10).map((d) => ({ name: d.name, value: d.value, usd: d.usd, who: d.who, role: d.role, tender: d.tender, country: countryName(d.it.country), sector: SECTORS[d.it.key], url: d.url })),
  lanes: lanes.map((x) => ({ name: x.l.name, flow: x.l.flow, n: x.n, crit: x.now.crit, p: x.p, pp: x.pp, status: status(x.p)[0], url: `${cfg.site}/trade-lanes/${x.l.id}/` })),
  flowSectors: countBy(flow, (it) => SECTORS[it.key] || it.sector).map(([name, n]) => ({ name, n })),
  totalUsd: dealsAll.reduce((n, d) => n + (d.usd || 0), 0),
};

// editor's note: the one place a person speaks. From the notes file (LLM-drafted, reviewed) - nothing is invented in code.
const editor = NOTES?.lede_html ? row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sand};border-radius:10px;"><tr><td style="padding:16px 18px;${font}">
  <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8a6d1f;">This week</div>
  <div style="font-size:15.5px;line-height:1.6;color:${C.ink};padding-top:6px;">${NOTES.lede_html}</div>
  ${NOTES.signoff ? `<div style="font-size:13px;color:${C.muted};padding-top:8px;">— ${esc(NOTES.signoff)}</div>` : ''}
</td></tr></table>`, '16px 0 0') : '';

// ---------------------------------------------------------------- head, subject, blocks
const tenders = epc.filter((it) => stageKey(it.stage) === 'S4').length, awards = epc.filter((it) => stageKey(it.stage) === 'S5').length;
const crit = flow.filter((it) => score(it) >= 12).length;
const countries = new Set(epc.map((it) => countryName(it.country)).filter(Boolean)).size;
const topDeal = dealsAll[0];
const subject = cut(topDeal ? `${topDeal.value ? topDeal.value + ' ' : ''}${topDeal.tender ? 'tender' : 'award'}: ${topDeal.name}` : `${plural(epc.length, 'new project')}, ${plural(tenders, 'tender')}, ${plural(awards, 'award')}`, 64);
const preview = cut(`${plural(epc.length, 'new project')} in ${countries} countries · ${tenders} tenders · ${awards} awards · ${plural(flow.length, 'trade-flow signal')}, ${crit} critical`, 110);
const blocks = {
  date: TODAY, edition: 'weekly', issue: issueNo, week: WEEK, year: YEAR, from: FROM, to: TO, subject, preview, slug: SLUG, issueUrl: ISSUE_URL, full,
  head: { kicker: `${W.name || 'World Trade Pro Weekly'} · Issue ${issueNo} · Week ${WEEK}`, title: W.subtitle || "Who's buying, who won, what moved", sub: `${fmtDay(FROM)} – ${fmtDay(TO)} ${YEAR} · ${plural(epc.length, 'new project')} in ${countries} countries (${epcRaw.length} reports) · ${tenders} tenders · ${awards} awards · ${plural(flow.length, 'trade-flow signal')}` },
  stats: { epc: epc.length, tenders, awards, flow: flow.length, critical: crit, deltas }, directory: '',
  editor, chart, chartTitle, callout, superlatives, calendar, dash, calendarCount: calItems.length,
  promise: `${plural(calls.slice(0, 3).length, 'deal')} · ${plural(calItems.length, 'deadline')} · ${plural(Math.min(3, flowItems.length), 'flow')} · about 5 minutes`,
  openThese: calls.slice(0, 3).map((c, i) => `<a href="#d${i + 1}" style="color:${C.accent};text-decoration:none;font-weight:700;">${esc(cut(c.name, 44))}</a>`).join(' &nbsp;·&nbsp; '),
  footer: { forward: `mailto:?subject=${encodeURIComponent((W.name || 'World Trade Pro Weekly') + ' - worth a look')}&body=${encodeURIComponent('Free Tuesday e-mail: tenders, awards, new projects and trade flows, filtered to your sectors. ' + cfg.site + '/subscribe/')}`, add: utm(cfg.site + '/project-sourcing/', 'footer-add'), archive: utm(cfg.site + '/blog/', 'footer-archive'), issue: utm(ISSUE_URL, 'footer-web') },
  sponsor, calls, projects, flows: { lanes: laneBoard, items: flowItems }, moves: movesHtml, tail,
  links: { projects: utm(cfg.site + '/projects/', 'projects-hub'), map: utm(cfg.site + '/intelligence-map/', 'map'), manage: cfg.site + '/newsletter/unsubscribe/', issue: utm(ISSUE_URL, 'read-full'), pdf: PDF_URL + '?utm_source=newsletter&utm_medium=email&utm_campaign=weekly-' + TODAY + '&utm_content=pdf' },
  pdfUrl: PDF_URL,
  skip: epc.length + flow.length < 5,
  counts: { epc: epc.length, tenders, awards, flow: flow.length, critical: crit, calls: calls.length, calendar: calItems.length, notes: !!NOTES, sectors: projects.map((p) => `${p.key}:${p.count}`) },
  // material for weekly_editor.mjs (names + urls the model may use; nothing else)
  material: { deals: dealsAll.slice(0, 12).map((d) => ({ name: d.name, stage: d.tender ? 'tender' : 'award', country: countryName(d.it.country), value: d.value, who: d.who, deadline: d.deadline, sector: SECTORS[d.it.key], url: d.url, summary: snippet(d.it.description, 240) })), flows: flowItems.map((f) => ({ url: f.url, title: f.title, source: f.source, sector: SECTORS[f.key], summary: f.summary })), deltas, prev: { epc: pEpc.length, tenders: pTenders, awards: pAwards, flow: pFlow.length }, topWinner: topWinner ? { who: topWinner[0], n: topWinner[1] } : null, topCountry: topCountry ? { name: topCountry[0], n: topCountry[1].length } : null, biggest: biggest ? { name: biggest.name, value: biggest.value, who: biggest.who, url: biggest.url } : null },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, NAME + '.blocks.json'), JSON.stringify(blocks, null, 1));
writeFileSync(join(OUT, NAME + '.html'), doc(blocks, assemble(blocks, {})));
writeFileSync(join(OUT, NAME + '.json'), JSON.stringify({ date: TODAY, edition: 'weekly', skip: blocks.skip, subject, preview, counts: blocks.counts }, null, 2));
if (args.includes('--preview')) {
  for (const [tag, reader] of [['metals-buyer', { sectors: 'metals', role: 'procurement' }], ['energy-supplier', { sectors: 'energy,power', role: 'equipment' }], ['agri-trader', { sectors: 'agri', role: 'trader' }], ['shipping', { sectors: 'shipping', role: 'shipping' }], ['power-owner', { sectors: 'power', role: 'owner' }]])
    writeFileSync(join(OUT, `${NAME}.preview-${tag}.html`), doc(blocks, assemble(blocks, reader)));
  console.log('previews: metals-buyer, energy-supplier, agri-trader, shipping');
}
console.log(`weekly ${TODAY} (issue ${issueNo}, W${WEEK})${blocks.skip ? ' SKIP: too little data' : ''}: "${subject}" (${subject.length}) — ${JSON.stringify(blocks.counts)} -> newsletter/out/${NAME}.html`);
