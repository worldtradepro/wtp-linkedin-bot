// Deep data card (owner 2026-11-11 "关键是深度数据infographics", 2026-11-19 "只发这种帖子和深度数据帖, 一天发4个"): one award or tender,
// several data layers on one 1080x1350 card. Layout from the hand-made sample (preview_deepcard.mjs, Fort Worth / COSCO), but every number
// comes from our database (fields v3, verified rows) or is computed from our own tracker - nothing typed by a model:
//   flag + sector kicker, event headline (fact_card.mjs eventTitle), big value, photo strip (licence-checked photo, else country map + drawing),
//   fact table, bar chart of priced projects in the same sector from our tracker (last 30 days), 3 KPI tiles, "So what" line, dated sources.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoOf } from './common.mjs';
import { valueTile, capacityTile, eventTitle, soWhat, stageName, artKey, artSvg, artLabel, locatorSvg } from './fact_card.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGO = 'data:image/png;base64,' + readFileSync(join(HERE, 'assets', 'logo_white_v2.png')).toString('base64');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const flag = (country) => { const i = isoOf(country).toLowerCase(); return i ? `https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/${i}.svg` : ''; };   // flag-icons, MIT

// rough US$ rates for the chart only (labelled "approx." on the card); a row in another currency is left out
const PER_USD = { USD: 1, EUR: 0.93, GBP: 0.79, CNY: 7.2, INR: 88, AUD: 1.53, CAD: 1.38, SAR: 3.75, AED: 3.67, QAR: 3.64, JPY: 152, KRW: 1390, SEK: 10.6, NOK: 10.9, DKK: 6.9,
  PLN: 4.0, CZK: 23.5, HUF: 365, RON: 4.6, TRY: 34, BRL: 5.6, MXN: 19.5, ZAR: 18.2, EGP: 49, NGN: 1600, KES: 129, IDR: 15800, MYR: 4.5, THB: 35, VND: 25400, PHP: 58, SGD: 1.34, CHF: 0.88, NZD: 1.68, CLP: 940, COP: 4300, PEN: 3.75, ARS: 1000, PKR: 278, BDT: 120 };
const UNIT = { thousand: 1e3, million: 1e6, billion: 1e9 };
export const curCode = (c) => ({ '$': 'USD', 'US$': 'USD', 'USD$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'CNY', 'RMB': 'CNY', 'Rs': 'INR', '₹': 'INR' }[String(c || '').trim()] || String(c || '').trim().toUpperCase());
export function usdOf(r) {
  const amt = Number(r.value_amount ?? r.valueAmount), unit = UNIT[r.value_unit ?? r.valueUnit], rate = PER_USD[curCode(r.value_currency ?? r.valueCurrency)];
  return Number.isFinite(amt) && amt > 0 && unit && rate ? (amt * unit) / rate : 0;
}

// A project can carry a deep card when it has a price, a named owner and at least one more party or a capacity.
export function deepScore(f) {
  if (!valueTile(f) || !f.owner || !(f.contractors || f.financing || capacityTile(f))) return 0;
  return usdOf(f) || 1;
}

// Same-sector priced projects from our tracker, last 30 days (verified rows only). The site API is the one generate.mjs reads.
export async function trackerRows(site, secret, today) {
  const from = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 864e5).toISOString().slice(0, 10);
  const url = `${site}/wp-json/wtp/v1/opportunities?report_type=epc&from=${from}&to=${today}&limit=1000${secret ? '&secret=' + encodeURIComponent(secret) : ''}`;
  for (let k = 0; k < 2; k++) {
    try {
      const j = await (await fetch(url, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } })).json();
      const rows = (Array.isArray(j) ? j : j.items || []).filter((r) => r.verification === 'full' || r.verification === 'project_only');
      console.log(`  tracker rows for deep cards: ${rows.length} (${from} to ${today})`);
      if (rows.length) return rows;
    } catch (e) { console.log('  tracker rows failed: ' + String(e.message || e).slice(0, 80)); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return [];
}
const cutWords = (t, n) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');
export function chartFor(f, rows, today) {
  const same = (r) => (f.subsector ? r.subsector === f.subsector : r.sector === f.sector);
  let pool = rows.filter(same);
  const bySector = pool.length < 4;   // too few in the subsector: compare with the whole sector
  if (bySector) pool = rows.filter((r) => r.sector === f.sector);
  const seen = new Set(), priced = [];
  for (const r of pool.map((r) => ({ r, usd: usdOf(r) })).filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd)) {
    const k = String(r.r.project_name || '').toLowerCase().slice(0, 40), k2 = (r.r.country || '') + '|' + Math.round(r.usd / 1e5);
    if (seen.has(k) || seen.has(k2)) continue; seen.add(k); seen.add(k2); priced.push(r);
  }
  const me = String(f.name).toLowerCase().slice(0, 40), mine = usdOf(f);
  if (mine && !priced.some((x) => String(x.r.project_name || '').toLowerCase().slice(0, 40) === me)) priced.push({ r: { project_name: f.name, country: f.country }, usd: mine });
  priced.sort((a, b) => b.usd - a.usd);
  const rank = priced.findIndex((x) => String(x.r.project_name || '').toLowerCase().slice(0, 40) === me) + 1;
  let top = priced.slice(0, 6);
  if (rank > 6) top = [...priced.slice(0, 5), priced[rank - 1]];
  const from = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 864e5);
  const d = (x) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    title: `${bySector ? f.sector : f.subsector || f.sector} projects with a price in our tracker, ${d(from)} – ${d(new Date(today + 'T00:00:00Z'))} (US$m${priced.some((x) => x.r.value_currency && x.r.value_currency !== 'USD') ? ', approx.' : ''})`,
    bars: top.map((x) => ({ label: cutWords(String(x.r.project_name || '').replace(/\s+/g, ' '), 48), country: x.r.country, m: +(x.usd / 1e6).toFixed(x.usd >= 1e8 ? 0 : 1), me: String(x.r.project_name || '').toLowerCase().slice(0, 40) === me })),
    count: pool.length, priced: priced.length, rank, bySector,
  };
}

// v3 (owner 2026-11-19, after a Gulf EPC league-table card with 1,325 likes): ONE hero - the comparison chart. White card, huge uppercase claim,
// one line of parties, thick bars filled with the country's flag (this project outlined in the accent colour), three tiles with concrete facts,
// a dark "So what" bar, plain-spoken footnote. No photo strip, no table, no logos (trademarks). One accent colour only.
export async function stretchFlags(countries) {
  const out = {};
  for (const c of [...new Set(countries.filter(Boolean))]) {
    const i = isoOf(c).toLowerCase(); if (!i) continue;
    try {
      const svg = await (await fetch(`https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/${i}.svg`)).text();
      if (/<svg/i.test(svg)) out[c] = 'data:image/svg+xml;base64,' + Buffer.from(svg.replace(/<svg\b/i, '<svg preserveAspectRatio="none"')).toString('base64');
    } catch { /* bar falls back to the plain flag */ }
  }
  return out;
}
export function deepCardHtml(f, { chart, today, flags = {} } = {}) {
  const v = valueTile(f), cap = capacityTile(f), stage = stageName(f.stage);
  const head = eventTitle(f).replace(/ /g, ' ');
  const kicker = [f.subsector || artLabel(artKey(f.sector, f.subsector, f.name, f.capacity)), f.country].filter(Boolean).join(' · ');
  const reported = f.reportDate ? new Date(f.reportDate + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const parties = [f.owner && `Owner: ${f.owner}`, f.contractors && f.contractors !== f.owner && `${f.contractorLabel || 'Contractors'}: ${f.contractors}`, f.financing && `Financing: ${f.financing}`].filter(Boolean).join('  ·  ');
  const sector = (chart?.bySector ? f.sector : f.subsector || f.sector || 'projects');
  const bars = (chart?.bars || []).slice(0, 6), max = Math.max(1, ...bars.map((b) => b.m));
  const money = (m) => (m >= 1000 ? `$${+(m / 1000).toFixed(m >= 10000 ? 0 : 1)}bn` : `$${m >= 100 ? Math.round(m) : +m.toFixed(1)}m`);
  const top = bars[0];
  const tiles = [
    [v.big + (v.unit ? (v.unit === 'BN' ? 'bn' : v.unit === 'M' ? 'm' : ' ' + v.unit) : ''), v.label.toLowerCase() + (reported ? ', ' + reported : '')],
    chart?.rank && chart.priced > 1 ? [`#${chart.rank} of ${chart.priced}`, `by value, priced ${sector.replace(/\b([A-Z][a-z]+)\b/g, (w) => w.toLowerCase())} projects, 30 days`] : cap ? [`${cap.big} ${cap.unit}`, cap.label.toLowerCase()] : [stage, 'project stage'],
    top && !top.me ? [money(top.m), `largest in the chart: ${top.label}`] : cap ? [`${cap.big} ${cap.unit}`, cap.label.toLowerCase()] : [stage, 'project stage'],
  ];
  for (let i = tiles.length - 1; i > 0; i--) if (tiles.slice(0, i).some((t) => t[0] === tiles[i][0])) tiles.splice(i, 1);
  const n = head.length, fs = n <= 40 ? 96 : n <= 60 ? 84 : n <= 80 ? 74 : 64;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=IBM+Plex+Sans:wght@500;600;700&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0b1626;--navy:#0f2d5e;--acc:#d27a00;--bg:#f2f5fa;--line:#d7dfeb}
body{width:1080px;height:1350px;font-family:'IBM Plex Sans',sans-serif;background:#fff;overflow:hidden;color:var(--ink);position:relative;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between;padding:26px 40px 0}
.top .k{display:flex;align-items:center;gap:12px;font:700 28px/1 'Barlow Condensed';color:var(--acc);letter-spacing:.06em;text-transform:uppercase}
.top .k img{height:30px;border-radius:3px;box-shadow:0 0 0 1px rgba(15,45,94,.2)}
.top .lg{background:var(--navy);border-radius:10px;padding:8px 14px}.top .lg img{height:40px;display:block}
h1{font:900 ${fs}px/.95 'Barlow Condensed';color:var(--ink);text-transform:uppercase;padding:18px 40px 0;letter-spacing:-.005em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.pt{padding:14px 40px 0;font:600 25px/1.25 'Barlow Condensed';color:#4a5a72;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ch{margin:24px 40px 0;flex:1;min-height:0;display:flex;flex-direction:column}.rows{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;min-height:0}
.ch h3{font:800 28px/1.05 'Barlow Condensed';color:var(--navy);margin-bottom:14px}
.row{display:grid;grid-template-columns:300px 1fr;align-items:center;gap:16px;min-height:62px}
.row p{font:700 22px/1.12 'IBM Plex Sans';color:var(--ink);text-align:right;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row.me p{color:var(--acc)}
.row div{display:flex;align-items:center;gap:12px;height:58px}
.row i{display:block;flex:none;width:59px;height:44px;margin-left:10px}.row i img{width:59px;height:44px;border-radius:3px;box-shadow:0 0 0 1px rgba(15,45,94,.25);display:block}
.row u{display:block;height:48px;min-width:4px;background:#7d93b5;border-radius:0 6px 6px 0}
.row.me u{background:var(--acc)}
.row b{font:800 40px/1 'Barlow Condensed';color:var(--ink);white-space:nowrap}
.row.me b{color:var(--acc)}
.lgd{margin:6px 0 0 316px;font:500 15px/1.3 'IBM Plex Sans';color:#6a7a92}
.kp{margin:18px 40px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.kp div{background:var(--bg);border-radius:14px;padding:16px 16px 14px;text-align:center}
.kp b{display:block;font:900 60px/1 'Barlow Condensed';color:var(--acc);white-space:nowrap}
.kp span{display:block;font:600 19px/1.2 'IBM Plex Sans';color:#2b3a52;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.so{margin-top:18px;background:var(--navy);color:#fff;padding:22px 40px 24px;font:700 38px/1.1 'Barlow Condensed';text-align:center}
.so b{color:#f0a640;text-transform:uppercase}
.ft{margin:14px 40px 16px;display:flex;justify-content:space-between;gap:18px;font:500 14px/1.35 'IBM Plex Sans';color:#5a6a82}
.ft div:last-child{border-left:2px solid var(--line);padding-left:16px;min-width:270px}
.ft b{color:var(--navy)}
</style></head><body>
<div class="top"><div class="k">${flag(f.country) ? `<img src="${flag(f.country)}">` : ''}${esc(kicker)}</div><div class="lg"><img src="${LOGO}"></div></div>
<h1>${esc(head)}</h1>
${parties ? `<div class="pt">${esc(parties)}</div>` : ''}
${bars.length > 1 ? `<div class="ch"><h3>${esc(chart.title)}</h3><div class="rows">${bars.map((b) => `<div class="row${b.me ? ' me' : ''}"><p>${esc(b.label)}</p><div><i>${flag(b.country) ? `<img src="${flag(b.country)}">` : ''}</i><u style="width:${Math.max(4, Math.round((b.m / max) * 480))}px"></u><b>${money(b.m)}</b></div></div>`).join('')}</div><div class="lgd">Flag = the project's country${chart.title.includes('approx') ? ' · other currencies converted at approximate rates' : ''}</div></div>` : '<div style="flex:1"></div>'}
<div class="kp">${tiles.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div>
<div class="so"><b>So what:</b> ${esc(soWhat(f).replace(/^[^:]+:\s*/, ''))}</div>
<div class="ft"><div>Sources: ${esc(f.source || 'public filings and releases')}${reported ? ', ' + esc(reported) : ''}. Chart and tiles: World Trade Pro project tracker, verified rows, our sums.</div><div><b>Own infographic © World Trade Pro Research</b><br>Share with credit · worldtradepro.com</div></div>
</body></html>`;
}

// Number check against the source article (owner 2026-11-11: every number on a deep card is checked against the original before posting).
// Rule-based: the value must appear in the article text with its unit word next to it, the capacity number with its unit, and the owner's name.
// Returns { ok, notes }. Any page that does not open or has too little text fails (the project then gets no deep card).
const numForms = (n) => {
  const x = Number(n); if (!Number.isFinite(x)) return [];
  const s = String(+x.toFixed(2)), [i, d] = s.split('.');
  const withCommas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return [...new Set([s, withCommas + (d ? '.' + d : '')])];
};
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const near = (text, nums, unitRe) => nums.some((n) => new RegExp(String.raw`(^|[^\d.,])` + escRe(n) + String.raw`(?!\d)\s?(?:-\s?)?.{0,12}?` + unitRe.source, 'i').test(text));
export async function checkAgainstSource(ctx, url, f) {
  const notes = [];
  if (!url) return { ok: false, notes: ['no source link'] };
  let text = '';
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (/news\.google\.com/.test(page.url())) await page.waitForURL((u) => !/google\.com/.test(u.hostname), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
  } catch (e) { return { ok: false, notes: ['source did not open: ' + String(e.message || e).slice(0, 60)] }; } finally { await page.close().catch(() => {}); }
  if (text.length < 600) return { ok: false, notes: ['source page has too little text (' + text.length + ' chars)'] };
  // value
  const amt = Number(f.valueAmount), unit = f.valueUnit;
  const U = { billion: /(billion|bn|bln|b\b)/, million: /(million|mn|mln|m\b)/, thousand: /(thousand|k\b|000\b)/ };
  let vOk = U[unit] && near(text, numForms(amt), U[unit]);
  if (!vOk && unit === 'million' && amt >= 1000) vOk = near(text, numForms(amt / 1000), U.billion) || near(text, numForms(+(amt / 1000).toFixed(1)), U.billion);
  if (!vOk && unit === 'billion' && amt < 10) vOk = near(text, numForms(amt * 1000), U.million);
  notes.push(vOk ? 'value found in source' : `value ${amt} ${unit} NOT found in source`);
  // capacity
  const cap = capacityTile(f);
  let cOk = true;
  if (cap) { const unitRe = new RegExp(escRe(cap.unit).replace('BPD', '(bpd|barrels)'), 'i'); cOk = near(text, numForms(String(cap.big).replace(/,/g, '')), unitRe) || text.includes(cap.big); notes.push(cOk ? 'capacity found' : `capacity ${cap.big} ${cap.unit} NOT found`); }
  // owner
  const ow = String(f.owner || '').replace(/\([^)]*\)/g, ' ').split(/[\s,;]+/).find((w) => w.length >= 3 && !/^(the|and|of|group|limited|company|corp|inc|ltd)$/i.test(w)) || '';
  const oOk = ow && new RegExp(String.raw`\b` + escRe(ow), 'i').test(text);
  notes.push(oOk ? 'owner found' : `owner "${ow}" NOT found`);
  return { ok: !!(vOk && cOk && oOk), notes };
}
