// E-mail editions for World Trade Pro, built from the site's PUBLIC API only (so only free data).
//   weekly: Trade Flow signals of the last 7 days + lane summary; Infrastructure projects that became
//           free during the week (first seen 7-15 days back)
//   daily:  Trade Flow signals of the last 24 hours (48h on a quiet day) + the projects that became
//           free today (first seen exactly 7 days ago). Skipped (skip:true) with fewer than 3 signals.
// Writes newsletter/out/<date>-<edition>.html (e-mail body, inline styles) + .json (subject, preview, counts).
// Sending is a separate step (kit_push.mjs).
//
// Usage:  node newsletter.mjs [--edition weekly|daily] [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, summaryOf, hostOf, similar, score } from './common.mjs';

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
// Whole sentences when there are any; otherwise the stored (255-char, often cut) text trimmed at a word with an ellipsis.
const blurb = (it) => summaryOf(it.description, 260) || clean(it.description).replace(/\s+\S*$/, '').replace(/[,;:\-–—\s]+$/, '') + (clean(it.description) ? '…' : '');
const flowNote = (l) => l.flow.replace(/\s*\(([^)]*)\)/, ', $1');

// ---------------------------------------------------------------- data
const flowFrom = dayShift(TODAY, DAILY ? -2 : -7), flowTo = TODAY;
const epcFrom = dayShift(TODAY, DAILY ? -7 : -15), epcTo = dayShift(TODAY, -7);
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
const bySector = countBy(epc, (it) => clean(it.sector));
const byCountry = countBy(epc, (it) => countryName(it.country));

// ---------------------------------------------------------------- html
const C = { ink: '#101828', muted: '#667085', line: '#eaecf0', bg: '#f5f6f8', card: '#ffffff', accent: '#0b4a6f' };
const font = "font-family:Segoe UI,Helvetica,Arial,sans-serif;";
const h2 = (t, sub) => `<tr><td style="padding:28px 0 6px;${font}"><div style="font-size:18px;font-weight:700;color:${C.ink};">${t}</div>${sub ? `<div style="font-size:13px;color:${C.muted};padding-top:2px;">${sub}</div>` : ''}</td></tr>`;
const chip = (t, color) => `<span style="display:inline-block;font-size:11px;font-weight:700;color:${color};border:1px solid ${color};border-radius:10px;padding:1px 7px;">${esc(t)}</span>`;

function signalRow(it) {
  const [t, color] = tier(score(it));
  const lane = laneOf(it);
  const meta = [flagOf(it.country) + ' ' + esc(countryName(it.country)), esc(it.sector), lane ? esc(lane.name) : '', fmtDay(it.report_date)].filter((x) => x.trim()).join(' · ');
  return `<tr><td style="padding:12px 0;border-top:1px solid ${C.line};${font}">
    <div style="padding-bottom:4px;">${chip(t, color)}</div>
    <a href="${esc(it.source_url)}" style="font-size:15px;font-weight:600;color:${C.ink};text-decoration:none;">${esc(clean(it.project_name))}</a>
    <div style="font-size:14px;line-height:1.5;color:#344054;padding-top:4px;">${esc(blurb(it))}</div>
    <div style="font-size:12px;color:${C.muted};padding-top:4px;">${meta} · Source: <a href="${esc(it.source_url)}" style="color:${C.muted};">${esc(it.source_name || hostOf(it.source_url))}</a></div>
  </td></tr>`;
}

function projectRow(it) {
  const facts = [
    ['Where', `${flagOf(it.country)} ${countryName(it.country)}`],
    ['Sector', [clean(it.sector), clean(it.subsector)].filter(Boolean).join(' / ')],
    ['Stage', stageLabel(it.stage)],
    ['Scale', clean(it.scale)],
    ['Company', clean(it.company_name)],
  ].filter(([, v]) => v.trim());
  return `<tr><td style="padding:12px 0;border-top:1px solid ${C.line};${font}">
    <a href="${esc(it.source_url)}" style="font-size:15px;font-weight:600;color:${C.ink};text-decoration:none;">${esc(clean(it.project_name))}</a>
    <div style="font-size:14px;line-height:1.5;color:#344054;padding-top:4px;">${esc(blurb(it))}</div>
    <div style="font-size:12px;color:${C.muted};padding-top:6px;">${facts.map(([k, v]) => `<b style="color:#475467;">${k}:</b> ${esc(v)}`).join(' &nbsp;·&nbsp; ')}</div>
    <div style="font-size:12px;color:${C.muted};padding-top:2px;">First seen ${fmtDay(it.report_date)} · Source: <a href="${esc(it.source_url)}" style="color:${C.muted};">${esc(it.source_name || hostOf(it.source_url))}</a></div>
  </td></tr>`;
}

const button = (label, href) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0;"><tr><td style="background:${C.accent};border-radius:6px;"><a href="${esc(href)}" style="display:inline-block;padding:10px 18px;${font}font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a></td></tr></table>`;

const lanesHtml = laneStats.length
  ? `<tr><td style="${font}font-size:14px;color:#344054;">${laneStats.map((x) =>
      `<div style="padding:5px 0;"><b style="color:${C.ink};">${esc(x.lane.name)}</b> — ${x.n} signal${x.n > 1 ? 's' : ''}${x.critical ? `, <span style="color:#b42318;font-weight:600;">${x.critical} critical</span>` : ''} <span style="color:${C.muted};">(${esc(flowNote(x.lane))})</span></div>`).join('')}</td></tr>`
  : `<tr><td style="${font}font-size:14px;color:${C.muted};">No trade lane was hit by a tracked signal ${DAILY ? 'in the last 24 hours' : 'this week'}.</td></tr>`;

// P.S. block: the newsletter is also the course's traffic source (config.newsletter.promo).
const promo = nl.promo?.enabled
  ? `<tr><td style="padding-top:26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6fa;border-radius:8px;"><tr><td style="padding:16px 18px;${font}">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700;">P.S. From World Trade Pro</div>
      <div style="font-size:16px;font-weight:700;color:${C.ink};padding-top:4px;">${esc(nl.promo.title)}</div>
      <div style="font-size:14px;line-height:1.5;color:#344054;padding-top:4px;">${esc(nl.promo.text)}</div>
      ${button(esc(nl.promo.cta), utm(nl.promo.url, 'course'))}
    </td></tr></table></td></tr>`
  : '';
const topList = (pairs, n) => pairs.slice(0, n).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
const mapFlows = utm(cfg.site + '/?view=flows', 'map-flows');
const mapInfra = utm(cfg.site + '/?view=infrastructure', 'map-infra');
const unlock = utm(cfg.site + '/unlock-intelligence-map/', 'unlock');

const head = DAILY
  ? { kicker: 'World Trade Pro · Daily', title: 'Trade-flow brief', sub: `${fmtDay(TODAY)} ${TODAY.slice(0, 4)} · ${signals.length} top signals · ${epc.length} project${epc.length === 1 ? '' : 's'} unlocked today` }
  : { kicker: 'World Trade Pro · Weekly', title: 'Trade flows &amp; new infrastructure projects', sub: `Week to ${fmtDay(TODAY)} ${TODAY.slice(0, 4)} · ${flow.length} trade-flow signals · ${epc.length} new projects tracked` };
const projectsBtn = `<tr><td>${button('Browse projects by country', utm(cfg.site + '/projects/', 'projects-hub'))}</td></tr>`;
const proNote = `<tr><td style="padding-top:22px;${font}font-size:13px;line-height:1.5;color:${C.muted};">
    These projects are a week old. Pro members see new projects as soon as they are found —
    <a href="${esc(unlock)}" style="color:${C.accent};">see them 7 days earlier</a>.
  </td></tr>`;
const sections = DAILY
  ? `${h2('Top signals', 'The last 24 hours, ranked by flow impact')}
  ${signals.map(signalRow).join('\n')}
  ${laneStats.length ? h2('Lanes hit today') + lanesHtml : ''}
  <tr><td>${button('Open the live trade-flow map', mapFlows)}</td></tr>
  ${epc.length ? h2('Projects unlocked today', `${epc.length} infrastructure project${epc.length > 1 ? 's' : ''} first seen ${fmtDay(epcFrom)}`) + projects.map(projectRow).join('\n') + projectsBtn + proNote : ''}`
  : `${h2('Trade lanes under pressure', `Signals from the last 7 days (${fmtDay(flowFrom)} – ${fmtDay(flowTo)})`)}
  ${lanesHtml}
  ${h2('Top trade-flow signals', 'Ranked by our flow-impact score')}
  ${signals.map(signalRow).join('\n')}
  <tr><td>${button('Open the live trade-flow map', mapFlows)}</td></tr>
  ${h2('New infrastructure projects', `${epc.length} projects first seen ${fmtDay(epcFrom)} – ${fmtDay(epcTo)}${bySector.length ? ' · ' + topList(bySector, 4) : ''}`)}
  ${byCountry.length ? `<tr><td style="${font}font-size:13px;color:${C.muted};padding-bottom:6px;">Most active: ${topList(byCountry, 6)}</td></tr>` : ''}
  ${projects.map(projectRow).join('\n')}
  ${projectsBtn}
  ${proNote}`;

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
  ${promo}
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;

const lead = laneStats[0];
const top = signals[0] ? clean(signals[0].project_name) : '';
const subject = DAILY
  ? (top.length > 90 ? top.slice(0, 87).replace(/\s+\S*$/, '') + '…' : top) + (signals.length > 1 ? ` + ${signals.length - 1} more signals` : '')
  : lead?.critical
    ? `${lead.lane.name}: ${lead.critical} critical signal${lead.critical > 1 ? 's' : ''} + ${epc.length} new projects`
    : `This week in trade flows + ${epc.length} new infrastructure projects`;
const preview = DAILY
  ? (signals[1] ? clean(signals[1].project_name).slice(0, 140) : 'Today in trade flows')
  : (signals[0] ? clean(signals[0].project_name).slice(0, 140) : 'Trade flows and new infrastructure projects this week');

const NAME = `${TODAY}-${EDITION}`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, NAME + '.html'), html);
writeFileSync(join(OUT, NAME + '.json'), JSON.stringify({
  date: TODAY, edition: EDITION, skip: SKIP, subject, preview,
  counts: { flow: flow.length, epc: epc.length, signals: signals.length, projects: projects.length, lanes: laneStats.length },
}, null, 2));
console.log(`${EDITION} ${TODAY}${SKIP ? ' (SKIP: fewer than 3 signals)' : ''}: "${subject}" — ${signals.length} signals, ${projects.length} projects, ${laneStats.length} lanes -> newsletter/out/${NAME}.html`);
