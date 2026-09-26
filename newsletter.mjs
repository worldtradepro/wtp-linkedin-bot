// Weekly e-mails for World Trade Pro, built from the site's PUBLIC API only (so only free data).
//   flow:     "Trade Flow Weekly" (Mondays) - readers: commodity traders, charterers, logistics.
//             The week's big story, a risk scoreboard for the 9 shipping lanes (this week vs last, 4-week trend),
//             by-the-numbers bullets, top signals per market, lanes to watch, then the Verified Commodity Supply & Demand box.
//   projects: "EPC Project Leads Weekly" (Tuesdays) - readers: BD at EPC contractors / equipment makers, owners.
//             Projects that became free this week (first seen 7-13 days ago): the top lead with what the stage
//             means for bidders, then open tenders / early stage / awards, the locked newest week as a count
//             with the Pro offer, and the EPC supply-request box.
// Layout follows the Smart Brevity order (news -> why it matters -> numbers -> go deeper), one primary button,
// a hidden preheader, real HTML text (no image-only content) so the plain-text part made by ses_send.mjs reads well.
// Writes newsletter/out/<date>-<edition>.html (e-mail body, inline styles) + .json (subject, preview, counts).
// Sending is a separate step (ses_send.mjs).
//
// Usage:  node newsletter.mjs [--edition flow|projects] [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayShift, fetchJson, flagOf, countryName, LANES, laneOf, clean, hostOf, similar, score, summaryOf, tokens } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const EDITION = args.includes('--edition') ? args[args.indexOf('--edition') + 1] : 'projects';
if (!['flow', 'projects'].includes(EDITION)) throw new Error('--edition must be flow or projects');
const FLOW = EDITION === 'flow';
const ed = { ...nl, ...(nl[EDITION] || {}) };   // per-edition overrides
const API = cfg.site + '/wp-json/wtp/v1';
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
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const tier = (n) => (n >= 12 ? ['Critical', '#b42318'] : n >= 8 ? ['Elevated', '#b54708'] : ['Watch', '#475467']);
const blocked = (cfg.blockedWords || []).map((w) => w.toLowerCase());
const ok = (it) => it.source_url && !blocked.some((w) => clean(it.project_name + ' ' + it.description).toLowerCase().includes(w));
const countBy = (items, key) => Object.entries(items.reduce((m, it) => { const k = key(it); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);

// ---------------------------------------------------------------- html building blocks
const C = { ink: '#101828', text: '#344054', muted: '#667085', line: '#eaecf0', bg: '#f5f6f8', card: '#ffffff', accent: '#0b4a6f', navy: '#0f2d5e', gold: '#c8a94a' };
const font = 'font-family:Segoe UI,Helvetica,Arial,sans-serif;';
const row = (inner, pad = '0') => `<tr><td style="padding:${pad};${font}">${inner}</td></tr>`;
const h2 = (t, sub) => row(`<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};">${t}</div>${sub ? `<div style="font-size:13px;color:${C.muted};padding-top:2px;">${sub}</div>` : ''}`, '26px 0 8px');
const para = (html, pad = '0 0 8px') => row(`<div style="font-size:15px;line-height:1.55;color:${C.text};">${html}</div>`, pad);
const link = (label, href, color = C.accent) => `<a href="${esc(href)}" style="color:${color};font-weight:700;text-decoration:none;">${label}</a>`;
const button = (label, href) => row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};border-radius:6px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;${font}font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${label}</a></td></tr></table>`, '14px 0 4px');
const bullets = (items) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map((b) => `<tr><td valign="top" style="${font}font-size:15px;line-height:1.5;color:${C.accent};width:16px;padding:3px 0;">•</td><td style="${font}font-size:15px;line-height:1.5;color:${C.text};padding:3px 0;">${b}</td></tr>`).join('')}</table>`);
const box = (html, bg, border) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};${border ? `border:1px solid ${border};` : ''}border-radius:8px;"><tr><td style="padding:14px 18px;${font}font-size:14px;line-height:1.55;">${html}</td></tr></table>`, '18px 0 0');
// Google News links carry the real outlet as a " - Reuters" title suffix
const gnews = (it) => hostOf(it.source_url) === 'news.google.com' && clean(it.project_name).match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
const title = (it) => { const g = gnews(it); return g ? g[1] : clean(it.project_name); };
const source = (it) => { const g = gnews(it); return esc(g ? g[2] : it.source_name || hostOf(it.source_url)); };
const isNA = (s) => !s || /^(n\/?a|unknown|none|not specified|-)$/i.test(clean(s));
// First whole sentences of the stored snippet; a snippet cut mid-sentence falls back to its words + "…"
const snippet = (desc, max) => { const s = summaryOf(desc, max); if (s) return s; const t = clean(desc); return t.length > 60 ? cut(t, Math.min(max, t.length - 1)) : ''; };
const headlineRow = (it, label) => {
  const [t, color] = tier(score(it));
  return row(`<div style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.04em;">${label || t}</div>
    <a href="${esc(it.source_url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:15px;line-height:1.4;">${flagOf(it.country)} ${esc(title(it))}</a>
    <span style="color:${C.muted};font-size:12px;"> — ${source(it)}</span>`, `9px 0;border-top:1px solid ${C.line}`);
};

// "the same story from several outlets" -> one cluster, strongest report first. A story joins a cluster when
// it is similar to any member, or shares 2+ words and a third of its words with one ("Yanbu pipeline attack…").
function related(a, b) {
  if (similar(a, b)) return true;
  const A = tokens(a), B = tokens(b);
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared >= 2 && shared / Math.min(A.size, B.size) >= 0.33;
}
function clusters(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => score(b) - score(a) || (b.report_date > a.report_date ? 1 : -1))) {
    const c = out.find((x) => [x.lead, ...x.more].some((m) => related(m.project_name, it.project_name)));
    if (c) c.more.push(it); else out.push({ lead: it, more: [] });
  }
  return out;
}

// ================================================================ Trade Flow Weekly
async function buildFlow() {
  const from = dayShift(TODAY, -7), to = dayShift(TODAY, -1);   // Monday..Sunday before this Monday
  const res = await fetchJson(`${API}/opportunities?report_type=flow_distortion&from=${from}&to=${to}&limit=1000`);
  const flow = (res.items || []).filter(ok);
  const lw = await fetchJson(`${API}/lane-weeks?weeks=4`);   // server-side lane counts, k=0 is the last 7 days
  const weeks = lw.weeks || [];
  const idx = (c) => (c ? c.crit * 3 + c.elev * 2 + c.watch : 0);   // lane pressure index: critical 3, elevated 2, watch 1
  const lanes = LANES.map((l) => {
    const hist = weeks.map((w) => w.lanes?.[l.id] || null);   // [this week, last week, ...]
    const now = hist[0] || { crit: 0, elev: 0, watch: 0 }, prev = hist[1] || { crit: 0, elev: 0, watch: 0 };
    return { l, now, prev, n: now.crit + now.elev + now.watch, p: idx(now), pp: idx(prev), trend: hist.map(idx).reverse(), top: now.top?.[0] };
  }).sort((a, b) => b.p - a.p || b.n - a.n);
  const status = (p) => (p >= 30 ? ['High', '#b42318'] : p >= 10 ? ['Elevated', '#b54708'] : p > 0 ? ['Watch', '#475467'] : ['Quiet', '#98a2b3']);
  const SPARK = '▁▂▃▄▅▆▇█';
  const spark = (vals) => { const m = Math.max(...vals, 1); return vals.map((v) => SPARK[Math.min(7, Math.round((v / m) * 7))]).join(''); };
  const change = (a, b) => (a > b ? `<span style="color:#b42318;">▲ ${a - b}</span>` : a < b ? `<span style="color:#027a48;">▼ ${b - a}</span>` : `<span style="color:${C.muted};">–</span>`);

  const crit = flow.filter((it) => score(it) >= 12).length;
  const critPrev = weeks[1]?.tiers?.crit ?? null;
  const cl = clusters(flow.filter((it) => score(it) >= (ed.minFlowScore || 8)));
  const big = cl[0];
  const used = new Set(big ? [big.lead, ...big.more] : []);
  // lane of the big story: its own match, else any lane its reports mention
  const bigLane = big && ([big.lead, ...big.more].map(laneOf).find(Boolean)
    || LANES.find((l) => [big.lead, ...big.more].some((it) => l.re.test(it.project_name + ' ' + it.description))));
  const bigLaneRow = bigLane && lanes.find((x) => x.l.id === bigLane.id);
  const hot = lanes.filter((x) => x.n > 0);
  const quiet = lanes.length - hot.length;
  const lead = hot[0];

  // Top signals per market (the pipeline's sector), strongest story per cluster, not repeating the big story.
  const MARKETS = [['Energy', 'Oil, gas & power'], ['Shipping', 'Shipping & freight'], ['Agriculture', 'Grains & agri'], ['Metals', 'Metals & mining'], ['Policy', 'Trade policy & sanctions']];
  const markets = MARKETS.map(([key, label]) => ({ label, n: flow.filter((it) => it.sector === key).length,
    picks: cl.filter((c) => c.lead.sector === key && !used.has(c.lead)).slice(0, ed.perMarket || 2).map((c) => c.lead) })).filter((m) => m.picks.length);
  const bySector = countBy(flow, (it) => it.sector);
  const rising = lanes.filter((x) => x.trend.length >= 3 && x.trend.at(-1) > x.trend.at(-2) && x.trend.at(-2) > x.trend.at(-3));

  const map = utm(cfg.site + '/intelligence-map/?view=flows', 'map-flows');
  const lanesHub = utm(cfg.site + '/trade-lanes/', 'lanes-hub');
  const laneLink = (l) => utm(`${cfg.site}/trade-lanes/${l.id}/`, 'lane-' + l.id);

  const body = [];
  // 1. the one big thing
  if (big) {
    const what = snippet(big.lead.description, 260);
    body.push(h2('The big one'));
    body.push(row(`<a href="${esc(big.lead.source_url)}" style="color:${C.ink};text-decoration:none;font-size:20px;font-weight:700;line-height:1.3;">${flagOf(big.lead.country)} ${esc(title(big.lead))}</a>
      <div style="font-size:12px;color:${C.muted};padding-top:3px;">${source(big.lead)}${big.more.length ? ` · ${big.more.length + 1} reports this week` : ''} · ${tier(score(big.lead))[0]}</div>`, '0 0 8px'));
    if (what) body.push(para(`<b style="color:${C.ink};">What happened:</b> ${esc(what)}`));
    if (bigLaneRow) body.push(para(`<b style="color:${C.ink};">Why it matters:</b> the ${esc(bigLane.name)} carries ${esc(bigLane.flow)}. It logged ${plural(bigLaneRow.now.crit, 'critical signal')} this week (${bigLaneRow.prev.crit} the week before).`));
    // follow-ups: other angles on the same story (different outlets, newest first)
    const follow = big.more.filter((m) => source(m) !== source(big.lead)).sort((a, b) => (b.report_date > a.report_date ? 1 : -1)).slice(0, 3);
    if (follow.length) body.push(para(`<b style="color:${C.ink};">Follow-ups:</b><br>${follow.map((m) => `<a href="${esc(m.source_url)}" style="color:${C.accent};text-decoration:none;">${esc(title(m))}</a> <span style="color:${C.muted};font-size:12px;">— ${source(m)}, ${fmtDay(m.report_date)}</span>`).join('<br>')}`, '4px 0 8px'));
  }
  // 2. lane scoreboard
  const th = (t, al = 'left') => `<td style="${font}font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;padding:6px 6px;text-align:${al};border-bottom:1px solid ${C.line};">${t}</td>`;
  const td = (t, al = 'left', extra = '') => `<td style="${font}font-size:14px;color:${C.text};padding:8px 6px;text-align:${al};border-bottom:1px solid ${C.line};${extra}">${t}</td>`;
  body.push(h2('Lane scoreboard', `Pressure on the 9 main shipping lanes, ${fmtDay(weeks[0]?.from || from)} – ${fmtDay(weeks[0]?.to || to)} vs the week before`));
  body.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${th('Lane')}${th('Status')}${th('w/w', 'right')}${th('4 wks', 'right')}</tr>
    ${lanes.map((x) => { const [s, c] = status(x.p); return `<tr>${td(`<a href="${esc(laneLink(x.l))}" style="color:${C.ink};text-decoration:none;font-weight:600;">${esc(x.l.name)}</a><br><span style="font-size:12px;color:${C.muted};">${x.n ? plural(x.n, 'signal') + (x.now.crit ? ` · <span style="color:#b42318;">${x.now.crit} critical</span>` : '') : 'no signals'}</span>`)}${td(`<span style="color:${c};font-weight:700;">●</span>&nbsp;${s}`, 'left', 'white-space:nowrap;')}${td(change(x.p, x.pp), 'right', 'white-space:nowrap;')}${td(`<span style="color:${C.accent};letter-spacing:1px;">${spark(x.trend)}</span>`, 'right', 'white-space:nowrap;font-size:13px;')}</tr>`; }).join('')}
  </table>
  <div style="font-size:12px;color:${C.muted};padding-top:6px;">Status from the week's signals on each lane (critical ×3, elevated ×2, watch ×1). ▲ = more pressure than last week.</div>`));
  body.push(button('Open the live trade-flow map →', map));
  // 3. by the numbers
  const nums = [
    `<b>${flow.length}</b> trade-flow signals this week; <b>${crit}</b> critical${critPrev !== null ? ` (${critPrev} the week before)` : ''}.`,
    lead ? `<b>${lead.n}</b> on the ${esc(lead.l.name)} — the busiest lane.` : '',
    bySector.length ? `<b>${bySector[0][1]}</b> ${esc(bySector[0][0].toLowerCase())} signals, the most active market${bySector[1] ? `; ${esc(bySector[1][0].toLowerCase())} next with ${bySector[1][1]}` : ''}.` : '',
    `<b>${quiet}</b> of 9 lanes quiet.`,
  ].filter(Boolean);
  body.push(h2('By the numbers'));
  body.push(bullets(nums));
  // 4. top signals by market
  if (markets.length) {
    body.push(h2('Top signals by market', 'Ranked by flow impact, one line per story'));
    for (const m of markets) {
      body.push(row(`<div style="font-size:14px;font-weight:700;color:${C.ink};">${esc(m.label)} <span style="color:${C.muted};font-weight:400;">· ${m.n}</span></div>`, '12px 0 2px'));
      for (const it of m.picks) { const l = laneOf(it); body.push(headlineRow(it, tier(score(it))[0] + (l ? ' · ' + l.name : ''))); }
    }
  }
  // 5. what to watch
  const watch = rising.length ? rising : hot.filter((x) => x.p > x.pp);
  if (watch.length) {
    body.push(h2('Watch next week'));
    body.push(bullets(watch.slice(0, 3).map((x) => `${link(esc(x.l.name), laneLink(x.l), C.ink)} — ${rising.includes(x) ? 'pressure up three weeks running' : 'pressure up on last week'} (${esc(x.l.flow)}).`)));
  }
  body.push(para(`Go deeper: ${link('shipping lane tracker', lanesHub)} · ${link('live map', map)}`, '18px 0 0'));
  // 6. Verified Commodity Supply & Demand + course
  body.push(box(`<b style="color:${C.ink};font-size:15px;">Buying or selling bulk commodities?</b><br><span style="color:${C.text};">Get verified as a real buyer or seller — we check role, mandate and recent trades, then connect you with verified counterparties on the other side.</span><br>${link('Verified Commodity Supply &amp; Demand →', utm(cfg.site + '/join-verified-club/', 'commodity-sd'))}`, '#f0f5fb', '#c9d8ea'));
  if (nl.promo?.enabled) body.push(para(`<span style="font-size:13px;color:${C.muted};"><b>P.S.</b> New to physical deals? ${esc(nl.promo.title)} walks through one end to end — fake offers, documents, LCs, price confirmation. ${link('Watch the free prologue →', utm(nl.promo.url, 'course'), C.muted)}</span>`, '16px 0 0'));

  const topLaneWord = lead ? (lead.p > lead.pp ? 'rises' : lead.p < lead.pp ? 'eases' : 'holds') : '';
  const subject = lead && lead.now.crit
    ? cut(`${lead.l.name} pressure ${topLaneWord}: ${plural(lead.now.crit, 'critical signal')}`, 60)
    : big ? cut(title(big.lead), 60) : `Trade Flow Weekly: ${plural(flow.length, 'signal')}`;
  const preview = cut((big ? title(big.lead) + ' · ' : '') + `${crit} critical signals, ${quiet} of 9 lanes quiet`, 110);
  return {
    head: { kicker: 'World Trade Pro · Trade Flow Weekly', title: `Week of ${fmtDay(from)} – ${fmtDay(to)}`, sub: `${plural(flow.length, 'signal')} · ${crit} critical · ${hot.length} of 9 lanes active` },
    body: body.join('\n'), subject, preview, skip: flow.length === 0,
    counts: { flow: flow.length, critical: crit, lanesActive: hot.length, markets: markets.length },
  };
}

// ================================================================ EPC Project Leads Weekly
const STAGE = {
  S1: ['Feasibility', 'Earliest stage — consultants and FEED contractors position now; the equipment list comes later.'],
  S2: ['Development', 'The owner is building the project team (FEED, permits, finance): the time to get on the bidder list.'],
  S3: ['Pre-FID', 'Close to the investment decision — main EPC and long-lead equipment packages are being prepared.'],
  S4: ['Tender', 'The tender is out — bidders are forming consortia and pricing equipment and subcontracts now.'],
  S5: ['Awarded', 'Contract awarded — the winner now buys equipment and places subcontracts.'],
};
const stageKey = (s) => (clean(s).match(/^S(\d)/) || [])[0] || '';
const SCALE_RANK = { Large: 0, Medium: 1, Small: 2 };

async function buildProjects() {
  const from = dayShift(TODAY, -13), to = dayShift(TODAY, -7);   // first seen 7-13 days ago = free this week
  const res = await fetchJson(`${API}/opportunities?report_type=epc&from=${from}&to=${to}&limit=1000`);
  const epc = (res.items || []).filter(ok).map((it) => ({ ...it, moved: it.latest_stage && it.latest_stage !== it.stage ? it.stage : '', stage: it.latest_stage || it.stage }));
  let LOCKED = 0, COUNTRY_PAGES = new Set();
  try { LOCKED = (await fetchJson(`${API}/opportunities?report_type=epc&from=${dayShift(TODAY, -6)}&to=${TODAY}&limit=1`)).locked_counts?.recent || 0; } catch {}
  try {
    const xml = await (await fetch(`${cfg.site}/wp-sitemap-intel-1.xml`, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } })).text();
    COUNTRY_PAGES = new Set([...xml.matchAll(/\/projects\/([a-z0-9-]+)\//g)].map((m) => m[1]));
  } catch {}
  const slugOf = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const countryLink = (it) => {
    const name = countryName(it.country);
    if (!name) return '';
    const slug = slugOf(name);
    return COUNTRY_PAGES.has(slug) ? link(`${flagOf(it.country)} ${esc(name)}`, utm(`${cfg.site}/projects/${slug}/`, 'country-' + slug)).replace('font-weight:700;', 'font-weight:400;') : `${flagOf(it.country)} ${esc(name)}`;
  };
  const sectorOf = (it) => [clean(it.sector), clean(it.subsector)].filter((x) => x && !/^unknown$/i.test(x)).join(' / ');
  // one per project name, large first, max 2 per country so one country cannot fill a section
  const pick = (items, n) => {
    const sorted = [...items].sort((a, b) => (SCALE_RANK[a.scale] ?? 3) - (SCALE_RANK[b.scale] ?? 3) || (b.report_date > a.report_date ? 1 : -1));
    const out = [], per = {};
    for (const it of sorted) {
      if (out.some((p) => similar(p.project_name, it.project_name))) continue;
      const c = it.country || '-';
      if ((per[c] || 0) >= 2) continue;
      per[c] = (per[c] || 0) + 1;
      out.push(it);
      if (out.length >= n) break;
    }
    return out;
  };
  const leadRow = (it) => {
    const bits = [countryLink(it), esc(sectorOf(it)), it.scale && it.scale !== 'Unknown' ? esc(it.scale) : '', isNA(it.company_name) ? '' : esc(clean(it.company_name))].filter(Boolean);
    return row(`<a href="${esc(it.source_url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:15px;line-height:1.4;">${esc(clean(it.project_name))}</a><br>
      <span style="color:${C.muted};font-size:13px;line-height:1.5;">${bits.join(' · ')}</span>`, `9px 0;border-top:1px solid ${C.line}`);
  };
  const byStage = (keys) => epc.filter((it) => keys.includes(stageKey(it.stage)));
  const tenders = byStage(['S4']), early = byStage(['S1', 'S2', 'S3']), awards = byStage(['S5']);
  const moved = epc.filter((it) => it.moved);
  // top lead: a large tender if there is one, else pre-FID, award, development, feasibility
  const topLead = ['S4', 'S3', 'S5', 'S2', 'S1'].map((k) => pick(byStage([k]), 1)[0]).find(Boolean);
  const countries = countBy(epc, (it) => countryName(it.country));
  const REGION = (it) => { const r = clean(it.region); return r === 'Asia' ? 'Asia Pacific' : r === 'South America' ? 'Americas' : r || 'Other'; };
  const regions = countBy(epc, REGION);
  const sectors = countBy(epc, (it) => clean(it.sector));
  const hub = utm(cfg.site + '/projects/', 'projects-hub');
  const unlock = utm(cfg.site + '/unlock-intelligence-map/', 'unlock');
  const perSection = ed.perSection || 6;

  const body = [];
  if (topLead) {
    const [st, why] = STAGE[stageKey(topLead.stage)] || ['', ''];
    body.push(h2('Top lead this week'));
    body.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-left:4px solid ${C.navy};border-radius:8px;"><tr><td style="padding:14px 18px;${font}">
      <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.accent};">${esc(st)} · ${esc(sectorOf(topLead))}</div>
      <a href="${esc(topLead.source_url)}" style="display:block;color:${C.ink};text-decoration:none;font-size:19px;font-weight:700;line-height:1.3;padding:4px 0;">${esc(clean(topLead.project_name))}</a>
      <div style="font-size:13px;color:${C.muted};">${[countryLink(topLead), isNA(topLead.company_name) ? '' : esc(clean(topLead.company_name)), topLead.scale && topLead.scale !== 'Unknown' ? esc(topLead.scale) + ' project' : '', source(topLead)].filter(Boolean).join(' · ')}</div>
      ${snippet(topLead.description, 240) ? `<div style="font-size:15px;line-height:1.55;color:${C.text};padding-top:8px;">${esc(snippet(topLead.description, 240))}</div>` : ''}
      <div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:8px;"><b style="color:${C.ink};">Why it matters for bidders:</b> ${esc(why)}</div>
    </td></tr></table>`));
  }
  body.push(h2('By the numbers'));
  body.push(bullets([
    `<b>${epc.length}</b> new projects in <b>${countries.length}</b> countries; most in ${countries.slice(0, 3).map(([k, n]) => `${esc(k)} (${n})`).join(', ')}.`,
    `<b>${tenders.length}</b> open tenders · <b>${early.length}</b> early stage · <b>${awards.length}</b> awards.`,
    sectors.length ? `By sector: ${sectors.map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}.` : '',
    `By region: ${regions.map(([k, n]) => `${esc(k)} ${n}`).join(' · ')}.`,
  ].filter(Boolean)));
  if (LOCKED) body.push(box(`<b style="color:#ffffff;font-size:15px;">🔒 ${plural(LOCKED, 'more project')} found in the last 7 days.</b><br><span style="color:#dbe4f0;">Everything in this e-mail is a week old. Pro members see new projects the day they are found — time to reach the owner or EPC before the tender is public.</span><br>${link('See them 7 days earlier →', unlock, C.gold)}`, C.navy));
  const section = (title, sub, items, key) => {
    if (!items.length) return;
    const shown = pick(items, perSection);
    body.push(h2(`${title} <span style="color:${C.muted};font-weight:400;">· ${items.length}</span>`, sub));
    shown.forEach((it) => body.push(leadRow(it)));
    if (items.length > shown.length) body.push(para(`<span style="font-size:13px;">${link(`+ ${items.length - shown.length} more on the site →`, utm(cfg.site + '/projects/', 'more-' + key))}</span>`, '6px 0 0'));
  };
  section('Open tenders', 'Bid window: consortia and subcontract pricing now', tenders, 'tenders');
  section('Early stage', 'Feasibility to pre-FID: get on the bidder list', early, 'early');
  section('Awarded', 'Winners are buying equipment and placing subcontracts', awards, 'awards');
  if (moved.length) {
    body.push(h2('Stage moves', 'Projects that advanced since first seen'));
    pick(moved, perSection).forEach((it) => body.push(row(`${esc(clean(it.project_name))} <span style="color:${C.muted};font-size:13px;">— ${esc((STAGE[stageKey(it.moved)] || [clean(it.moved)])[0])} → <b>${esc((STAGE[stageKey(it.stage)] || [clean(it.stage)])[0])}</b></span>`, `8px 0;border-top:1px solid ${C.line};font-size:14px;color:${C.ink}`)));
  }
  body.push(button(`Filter all projects by country →`, hub));
  body.push(box(`<b style="color:${C.ink};font-size:15px;">Need Chinese equipment or an EPC partner for a project?</b><br><span style="color:${C.text};">Tell us what the project needs. We match owners and contractors with checked Chinese manufacturers and EPCs — factory checks, inspection and procurement follow-up included.</span><br>${link('Submit an EPC supply request →', utm(cfg.site + '/china-sourcing-support-request/#csr-apply', 'epc-request'))}<br><span style="color:${C.muted};font-size:13px;">Chinese manufacturer or EPC? ${link('Send us your supplier profile', utm(cfg.site + '/china-sourcing-support-request/?side=supply#csr-apply', 'epc-supplier'), C.muted)} and we will match you to projects like these.</span>`, '#fdf6e3', '#ecd9a3'));
  body.push(para(`<span style="font-size:13px;color:${C.muted};">Also free: the ${link('live project map', utm(cfg.site + '/intelligence-map/?view=infrastructure', 'map-infra'), C.muted)} and the ${link('shipping lane tracker', utm(cfg.site + '/trade-lanes/', 'lanes-hub'), C.muted)}.</span>`, '16px 0 0'));

  const subject = cut(`${epc.length} new projects: ${plural(tenders.length, 'tender')}, ${plural(awards.length, 'award')}${countries[0] ? ' — top: ' + countries[0][0] : ''}`, 64);
  const preview = cut(topLead ? `${(STAGE[stageKey(topLead.stage)] || [''])[0]}: ${clean(topLead.project_name)}${LOCKED ? ` · ${LOCKED} newer locked for Pro` : ''}` : 'New infrastructure projects this week', 110);
  return {
    head: { kicker: 'World Trade Pro · EPC Project Leads Weekly', title: `${plural(epc.length, 'new project')} this week`, sub: `First seen ${fmtDay(from)} – ${fmtDay(to)} ${TODAY.slice(0, 4)} · energy, mining & commodity infrastructure` },
    body: body.join('\n'), subject, preview, skip: epc.length === 0,
    counts: { epc: epc.length, tenders: tenders.length, early: early.length, awards: awards.length, moved: moved.length, locked: LOCKED },
  };
}

// ================================================================ page
const issue = FLOW ? await buildFlow() : await buildProjects();
const pre = esc(issue.preview) + '&#8199;&#65279;&#847;'.repeat(40);   // hidden preheader, padded so the inbox does not pull body text after it
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(issue.head.kicker)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:${C.card};border-radius:10px;"><tr><td style="padding:22px 18px 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="${font}padding-bottom:6px;border-bottom:3px solid ${C.navy};">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700;">${esc(issue.head.kicker)}</div>
    <div style="font-size:26px;font-weight:700;color:${C.ink};padding-top:6px;line-height:1.2;">${esc(issue.head.title)}</div>
    <div style="font-size:13px;color:${C.muted};padding:4px 0 8px;">${esc(issue.head.sub)}</div>
  </td></tr>
  ${issue.body}
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;

const NAME = `${TODAY}-${EDITION}`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, NAME + '.html'), html);
writeFileSync(join(OUT, NAME + '.json'), JSON.stringify({ date: TODAY, edition: EDITION, skip: issue.skip, subject: issue.subject, preview: issue.preview, counts: issue.counts }, null, 2));
console.log(`${EDITION} ${TODAY}${issue.skip ? ' (SKIP: no data)' : ''}: "${issue.subject}" (${issue.subject.length} chars) — ${JSON.stringify(issue.counts)} — ${(html.length / 1024).toFixed(0)} KB -> newsletter/out/${NAME}.html`);
