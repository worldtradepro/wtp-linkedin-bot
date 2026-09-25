// E-mail editions for World Trade Pro, built from the site's PUBLIC API only (so only free data).
//   weekly: "Project Leads Weekly" - the Infrastructure projects that became free this week (first seen
//           7-13 days back), grouped by region with links to the country pages, and the newest week as a
//           count with the Pro offer. Readers: EPC / supplier BD.
//   daily:  "Trade Flow Daily", short on purpose - the day's map card (the image the LinkedIn bot made this morning),
//           headlines only for the last 24 hours (48h on a quiet day), a count of the projects that
//           became free today, and a visible course line. Skipped (skip:true) with fewer than 3 signals.
// Writes newsletter/out/<date>-<edition>.html (e-mail body, inline styles) + .json (subject, preview, counts).
// Sending is a separate step (ses_send.mjs).
//
// Usage:  node newsletter.mjs [--edition weekly|daily] [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, hostOf, similar, score } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const EDITION = args.includes('--edition') ? args[args.indexOf('--edition') + 1] : 'weekly';
if (!['weekly', 'daily'].includes(EDITION)) throw new Error('--edition must be weekly or daily');
const DAILY = EDITION === 'daily';
const ed = { ...nl, ...(nl[EDITION] || {}) };   // per-edition overrides (signals, minFlowScore, ...)
const API = cfg.site + '/wp-json/wtp/v1/opportunities';
const OUT = join(HERE, 'newsletter', 'out');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utm = (u, content) => {
  const url = new URL(u);
  url.searchParams.set('utm_source', 'newsletter');
  url.searchParams.set('utm_medium', 'email');
  url.searchParams.set('utm_campaign', EDITION + '-' + TODAY);
  if (content) url.searchParams.set('utm_content', content);
  return url.toString();
};
const fmtDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tier = (n) => (n >= 12 ? ['Critical', '#b42318'] : n >= 8 ? ['Elevated', '#b54708'] : ['Watch', '#475467']);
const SCALE_RANK = { Large: 0, Medium: 1, Small: 2 };
const stageLabel = (s) => clean(s).replace(/^S\d+-/, '');

// ---------------------------------------------------------------- data
const flowFrom = dayShift(TODAY, DAILY ? -2 : -7), flowTo = TODAY;
const epcFrom = dayShift(TODAY, DAILY ? -7 : -13), epcTo = dayShift(TODAY, -7);
const flowRes = await fetchJson(`${API}?report_type=flow_distortion&from=${flowFrom}&to=${flowTo}&limit=1000`);
const epcRes = await fetchJson(`${API}?report_type=epc&from=${epcFrom}&to=${epcTo}&limit=1000`);
const blocked = (cfg.blockedWords || []).map((w) => w.toLowerCase());
const ok = (it) => it.source_url && !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w));
const flow = (flowRes.items || []).filter(ok);
const epc = (epcRes.items || []).filter(ok).map((it) => (it.latest_stage ? { ...it, stage: it.latest_stage } : it));  // merged projects: most advanced stage

// Lanes: every lit lane with its signal count and strongest signal.
const lanePool = DAILY ? flow.filter((it) => it.report_date >= dayShift(TODAY, -1)) : flow;
const laneStats = LANES.map((l) => {
  const hits = lanePool.filter((it) => laneOf(it) === l);
  return { lane: l, n: hits.length, critical: hits.filter((it) => score(it) >= 12).length };
}).filter((x) => x.n > 0).sort((a, b) => b.critical - a.critical || b.n - a.n);

// Top signals: highest score first, one story per event (similar headlines collapse), max 2 per lane.
function pickSignals(items, n) {
  const picks = [], perLane = {};
  for (const it of [...items].sort((a, b) => score(b) - score(a) || (b.report_date > a.report_date ? 1 : -1))) {
    if (score(it) < ed.minFlowScore) break;
    if (picks.some((p) => similar(p.project_name, it.project_name))) continue;
    const l = laneOf(it)?.id || '-';
    if (l !== '-' && (perLane[l] || 0) >= 2) continue;
    perLane[l] = (perLane[l] || 0) + 1;
    picks.push(it);
    if (picks.length >= n) break;
  }
  return picks;
}
// Daily: the last 24 hours first; a quiet day falls back to 48 hours.
const recent = DAILY ? flow.filter((it) => it.report_date >= dayShift(TODAY, -1)) : flow;
let signals = pickSignals(recent, ed.signals);
if (DAILY && signals.length < 3) signals = pickSignals(flow, ed.signals);
const SKIP = DAILY && signals.length < 3;

// The map's own share card, published by linkedin-daily to the public "images" branch before this runs.
const IMG_BASE = `https://raw.githubusercontent.com/${nl.imagesRepo || 'worldtradepro/wtp-linkedin-bot'}/images/${TODAY}`;
async function cardUrl() {
  for (const name of ['main-card-flash', 'main-card-weekly']) {
    const u = `${IMG_BASE}/${name}.png`;
    try { const r = await fetch(u, { method: 'HEAD' }); if (r.ok) return u; } catch {}
  }
  return null;
}
const CARD = DAILY ? await cardUrl() : null;

// Projects: large + early-stage first, one per project name, spread across countries.
function pickProjects(items, n) {
  const sorted = [...items].sort((a, b) =>
    (SCALE_RANK[a.scale] ?? 3) - (SCALE_RANK[b.scale] ?? 3) || clean(a.stage).localeCompare(clean(b.stage)) || (b.report_date > a.report_date ? 1 : -1));
  const picks = [], perCountry = {};
  for (const it of sorted) {
    if (picks.some((p) => similar(p.project_name, it.project_name))) continue;
    const c = countryName(it.country) || '-';
    if ((perCountry[c] || 0) >= 2) continue;
    perCountry[c] = (perCountry[c] || 0) + 1;
    picks.push(it);
    if (picks.length >= n) break;
  }
  return picks;
}
const projects = pickProjects(epc, ed.projects);
const countBy = (items, key) => Object.entries(items.reduce((m, it) => { const k = key(it); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);

// ---------------------------------------------------------------- html
const C = { ink: '#101828', muted: '#667085', line: '#eaecf0', bg: '#f5f6f8', card: '#ffffff', accent: '#0b4a6f' };
const font = "font-family:Segoe UI,Helvetica,Arial,sans-serif;";
const h2 = (t, sub) => `<tr><td style="padding:28px 0 6px;${font}"><div style="font-size:18px;font-weight:700;color:${C.ink};">${t}</div>${sub ? `<div style="font-size:13px;color:${C.muted};padding-top:2px;">${sub}</div>` : ''}</td></tr>`;

const button = (label, href) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0;"><tr><td style="background:${C.accent};border-radius:6px;"><a href="${esc(href)}" style="display:inline-block;padding:10px 18px;${font}font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a></td></tr></table>`;

const mapFlows = utm(cfg.site + '/?view=flows', 'map-flows');
const mapInfra = utm(cfg.site + '/?view=infrastructure', 'map-infra');
const unlock = utm(cfg.site + '/unlock-intelligence-map/', 'unlock');

// ---------------------------------------------------------------- Project Leads Weekly (edition "weekly")
// Projects that became free this week, grouped by region, each country linked to its /projects/<country>/
// page when the site lists one; the newest week (paid) is shown only as a count with the Pro offer.
let LOCKED = 0, COUNTRY_PAGES = new Set();
if (!DAILY) {
  try { LOCKED = (await fetchJson(`${API}?report_type=epc&from=${dayShift(TODAY, -6)}&to=${TODAY}&limit=1`)).locked_counts?.recent || 0; } catch {}
  try {
    const xml = await (await fetch(`${cfg.site}/wp-sitemap-intel-1.xml`, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } })).text();
    COUNTRY_PAGES = new Set([...xml.matchAll(/\/projects\/([a-z0-9-]+)\//g)].map((m) => m[1]));
  } catch {}
}
const slugOf = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const countryLink = (it) => {
  const name = countryName(it.country);
  if (!name) return '';
  const slug = slugOf(name);
  return COUNTRY_PAGES.has(slug)
    ? `<a href="${esc(utm(`${cfg.site}/projects/${slug}/`, 'country-' + slug))}" style="color:${C.accent};text-decoration:none;">${flagOf(it.country)} ${esc(name)}</a>`
    : `${flagOf(it.country)} ${esc(name)}`;
};
const REGION_ORDER = ['Middle East', 'Asia Pacific', 'Europe', 'Africa', 'Americas'];
const regionOf = (it) => { const r = clean(it.region); return r === 'Asia' ? 'Asia Pacific' : r === 'South America' ? 'Americas' : (REGION_ORDER.includes(r) ? r : 'Other'); };
const regions = DAILY ? [] : Object.entries(epc.reduce((m, it) => { (m[regionOf(it)] ||= []).push(it); return m; }, {}))
  .sort((a, b) => b[1].length - a[1].length);
const leadRow = (it) => {
  const bits = [countryLink(it), esc([clean(it.sector), clean(it.subsector)].filter((x) => x && !/^unknown$/i.test(x)).join(' / ')), esc(stageLabel(it.stage)), esc(clean(it.company_name))].filter(Boolean);
  return `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};${font}font-size:14px;line-height:1.45;">
    <a href="${esc(it.source_url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:15px;">${esc(clean(it.project_name))}</a><br>
    <span style="color:${C.muted};font-size:13px;">${bits.join(' · ')}</span>
  </td></tr>`;
};
const proBox = `<tr><td style="padding:18px 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f2d5e;border-radius:8px;"><tr><td style="padding:14px 18px;${font}font-size:14px;line-height:1.5;color:#dbe4f0;">
    <b style="color:#ffffff;font-size:15px;">🔒 ${LOCKED} more project${LOCKED === 1 ? '' : 's'} found in the last 7 days.</b><br>
    Everything below is a week old. Pro members see new projects the day they are found — time to reach the owner or EPC before the tender is public.
    <a href="${esc(unlock)}" style="color:#c8a94a;font-weight:700;">See them 7 days earlier →</a>
  </td></tr></table></td></tr>`;
const weeklySections = `${LOCKED ? proBox : ''}
  ${regions.map(([reg, items]) => h2(`${esc(reg)} <span style="color:${C.muted};font-weight:400;font-size:15px;">· ${items.length}</span>`) + pickProjects(items, ed.perRegion || 4).map(leadRow).join('\n')).join('\n')}
  <tr><td>${button('Browse all projects by country', utm(cfg.site + '/projects/', 'projects-hub'))}</td></tr>
  <tr><td style="padding-top:16px;${font}font-size:13px;color:${C.muted};">Also free: the <a href="${esc(utm(cfg.site + '/trade-lanes/', 'lanes-hub'))}" style="color:${C.accent};">shipping lane risk tracker</a> and the <a href="${esc(mapInfra)}" style="color:${C.accent};">live project map</a>.</td></tr>`;
const topCountries = countBy(epc, (it) => countryName(it.country)).slice(0, 3).map(([k]) => k);

const head = DAILY
  ? { kicker: 'World Trade Pro · Trade Flow Daily', title: 'Trade-flow brief', sub: `${fmtDay(TODAY)} ${TODAY.slice(0, 4)} · ${signals.length} top signals · ${epc.length} project${epc.length === 1 ? '' : 's'} unlocked today` }
  : { kicker: 'World Trade Pro · Project Leads Weekly', title: `${epc.length} new infrastructure projects`, sub: `First seen ${fmtDay(epcFrom)} – ${fmtDay(epcTo)} ${TODAY.slice(0, 4)}${topCountries.length ? ' · most in ' + esc(topCountries.join(', ')) : ''}` };
// Daily: one headline per line (tier, lane) - the card carries the picture, the e-mail stays short.
const headlineRow = (it) => {
  const [t, color] = tier(score(it));
  const lane = laneOf(it);
  return `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};${font}font-size:15px;line-height:1.4;">
    <span style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.04em;">${t}${lane ? ' · ' + esc(lane.name) : ''}</span><br>
    <a href="${esc(it.source_url)}" style="color:${C.ink};text-decoration:none;font-weight:600;">${flagOf(it.country)} ${esc(clean(it.project_name))}</a>
    <span style="color:${C.muted};font-size:12px;"> — ${esc(it.source_name || hostOf(it.source_url))}</span>
  </td></tr>`;
};
const courseLine = nl.promo?.enabled
  ? `<tr><td style="padding:16px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6e3;border:1px solid #ecd9a3;border-radius:8px;"><tr><td style="padding:12px 16px;${font}font-size:14px;line-height:1.5;color:#344054;">
      <b style="color:${C.ink};">New to physical commodity trading?</b> ${esc(nl.promo.title)} — a short video course on avoiding fake offers, bad documents and price traps.
      <a href="${esc(utm(nl.promo.url, 'course-daily'))}" style="color:${C.accent};font-weight:700;">Watch the free prologue →</a>
    </td></tr></table></td></tr>`
  : '';
const sections = DAILY
  ? `${CARD ? `<tr><td style="padding:16px 0 4px;" align="center"><a href="${esc(mapFlows)}"><img src="${esc(CARD)}" width="480" alt="Today's trade-flow map: top signals and the trade lanes under pressure" style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:10px;"></a></td></tr>` : ''}
  ${h2('Top signals', 'The last 24 hours, ranked by flow impact')}
  ${signals.map(headlineRow).join('\n')}
  <tr><td style="padding-top:12px;${font}font-size:14px;"><a href="${esc(mapFlows)}" style="color:${C.accent};font-weight:700;text-decoration:none;">Open the live trade-flow map →</a></td></tr>
  ${epc.length ? `<tr><td style="padding-top:18px;${font}font-size:14px;color:#344054;"><b style="color:${C.ink};">${epc.length} infrastructure project${epc.length > 1 ? 's' : ''} unlocked today</b> (first seen ${fmtDay(epcFrom)}). <a href="${esc(utm(cfg.site + '/projects/', 'projects-hub'))}" style="color:${C.accent};font-weight:700;text-decoration:none;">Browse by country →</a><br><span style="color:${C.muted};font-size:13px;">Pro members saw them a week ago — <a href="${esc(unlock)}" style="color:${C.muted};">see new projects 7 days earlier</a>.</span></td></tr>` : ''}
  ${courseLine}`
  : weeklySections;

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${head.kicker}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.card};border-radius:10px;"><tr><td style="padding:24px 24px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="${font}">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700;">${head.kicker}</div>
    <div style="font-size:24px;font-weight:700;color:${C.ink};padding-top:6px;">${head.title}</div>
    <div style="font-size:13px;color:${C.muted};padding-top:4px;">${head.sub}</div>
  </td></tr>
  ${sections}

</table>
</td></tr></table>
</td></tr></table>
</body></html>`;

const lead = laneStats[0];
const top = signals[0] ? clean(signals[0].project_name) : '';
const subject = DAILY
  ? (top.length > 90 ? top.slice(0, 87).replace(/\s+\S*$/, '') + '…' : top) + (signals.length > 1 ? ` + ${signals.length - 1} more signals` : '')
  : `${epc.length} new infrastructure projects this week${topCountries.length ? ': ' + topCountries.join(', ') : ''}`;
const preview = DAILY
  ? (signals[1] ? clean(signals[1].project_name).slice(0, 140) : 'Today in trade flows')
  : (projects[0] ? clean(projects[0].project_name).slice(0, 140) + (LOCKED ? ` · ${LOCKED} more locked for Pro` : '') : 'New infrastructure projects this week');

const NAME = `${TODAY}-${EDITION}`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, NAME + '.html'), html);
writeFileSync(join(OUT, NAME + '.json'), JSON.stringify({
  date: TODAY, edition: EDITION, skip: SKIP, subject, preview,
  counts: { flow: flow.length, epc: epc.length, signals: signals.length, projects: projects.length, lanes: laneStats.length },
}, null, 2));
console.log(`${EDITION} ${TODAY}${SKIP ? ' (SKIP: fewer than 3 signals)' : ''}: "${subject}" — ${signals.length} signals, ${projects.length} projects, ${laneStats.length} lanes -> newsletter/out/${NAME}.html`);
