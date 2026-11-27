// "Who builds X" market card + post (owner 2026-11-27, pointing at a London BD consultancy's "WHO BUILDS BRAZIL'S NEXT FPSOS" post, 112 reactions:
// "不是让你研究下这个吗？"). One market, several builders: table Builder | Project | Client · country | Status, three market tiles,
// a "So what" bar that names the packages and the builders whose vendor lists matter, dated sources. No logos (trademarks).
// Every row is a verified contract award in our own tracker (last 30 days); counts and sums are ours.
import { shortCo } from './fact_card.mjs';
import { isoOf } from './common.mjs';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const esc = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const co = (s) => shortCo(s).replace(/(\s+(Co|S|S\.A)\.?)+$/, '').replace(/\s+(joint venture|consortium|JV)$/i, ' JV').replace(/\s+(Shipbuilding|Shipyard|Dockyard|Industries|Group|Holdings?)$/i, '').replace(/[\s,]+$/, '').trim();
const unnamed = (s) => !s || /\b(unnamed|undisclosed|unknown|not named)\b/i.test(s);
const place = (c) => (c && !/^(unknown|global|international|various|worldwide)$/i.test(c) ? c : '');
const parties = (v) => { let a = v; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } } return Array.isArray(a) ? a : []; };
const BUILDER = /\b(epc\w*|contractor|construct\w*|build\w*|shipbuild\w*|shipyard|yard|dockyard|supplier|install\w*|design|engineering|integrator|fabricat\w*)\b/i;
const NOT_BUILDER = /\b(offtaker|buyer|subsidiary|charterer|lender|investor|owner|operator only|drilling)\b/i;
const NOT_BUILD_EVENT = /^(Offtake\/Supply agreement|Acquisition\/Sale|Delivery\/Commissioning|Financing|Renewal\/Extension|Permit\/Approval)$/;
const UNIT = { thousand: 1e3, million: 1e6, billion: 1e9 };
const PER_USD = { USD: 1, EUR: 0.93, GBP: 0.79, CNY: 7.2, RMB: 7.2, INR: 88, KRW: 1390, JPY: 152, AED: 3.67, SAR: 3.75, NOK: 10.9, AUD: 1.53, CAD: 1.38, BRL: 5.6 };
const usd = (r) => { const n = Number(r.value_amount), u = UNIT[r.value_unit], c = String(r.value_currency || '').replace(/^(\$|US\$)$/, 'USD').toUpperCase(); return n > 0 && u && PER_USD[c] ? (n * u) / PER_USD[c] : 0; };
const money = (x) => (x >= 1e9 ? `$${+(x / 1e9).toFixed(1)}bn` : `$${Math.round(x / 1e6)}m`);
const day = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthYear = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Markets: name on the card, which rows belong, what gets bought through the builders (general, "usually" - not a claim about one contract)
export const THEMES = [
  { key: 'floatlng', title: "Who builds the world's floating LNG", test: (r) => /FSRU|FLNG|floating LNG|FSU\b/i.test(r.project_name + ' ' + (r.description || '')),
    buys: 'Regas and liquefaction modules, cryogenic pumps, compressors, valves and mooring' },
  { key: 'tankers', title: "Who builds the world's new tankers and gas carriers", test: (r) => r.subsector === 'Shipyard & Fleet' && /VLCC|tanker|LNG carrier|LPG carrier|gas carrier|MR\b|Suezmax|Aframax/i.test(r.project_name),
    buys: 'Main engines, cargo pumps, deck machinery, coatings and outfitting' },
  { key: 'ships', title: "Who builds the world's new ships", test: (r) => r.subsector === 'Shipyard & Fleet',
    buys: 'Main engines, deck machinery, coatings, electrical systems and outfitting' },
  { key: 'offshoreog', title: 'Who builds offshore oil and gas', test: (r) => r.subsector === 'Oil & Gas' && /offshore|subsea|FPSO|pipeline|EPCI|SURF|platform|field/i.test(r.project_name + ' ' + (r.description || '')),
    buys: 'Topsides, compressors, pumps, valves, subsea equipment and mooring' },
  { key: 'lng', title: 'Who builds LNG', test: (r) => r.subsector === 'LNG', buys: 'Cryogenic pumps, compressors, valves, storage tanks and power systems' },
  { key: 'offwind', title: 'Who builds offshore wind', test: (r) => r.subsector === 'Wind' && /offshore|subsea|cable|array|export/i.test(r.project_name + ' ' + (r.description || '')),
    buys: 'Cables, foundations, substations, cable protection and installation vessels' },
  { key: 'ports', title: 'Who builds ports and terminals', test: (r) => r.subsector === 'Ports & Terminals', buys: 'Dredging, piling, quay steel, cranes and marine works' },
  { key: 'power', title: 'Who builds power plants and grids', test: (r) => r.subsector === 'Power & Transmission', buys: 'Turbines, transformers, switchgear, cables and balance-of-plant' },
];

// rows -> one entry per deal (several builders on one deal stay one row)
function deals(rows, theme, from) {
  const out = [];
  for (const r of rows) {
    if (String(r.report_date) < from || /\b(charter|CCS|carbon capture|drilling|rigs?)\b/i.test(r.project_name) || !String(r.stage || '').startsWith('S5') || NOT_BUILD_EVENT.test(r.event_type || '') || !theme.test(r)) continue;
    const b = parties(r.contractors).filter((x) => x?.name && BUILDER.test(x.role || '') && !NOT_BUILDER.test(x.role || '')).map((x) => co(x.name)).filter((n) => n && !unnamed(n));
    if (!b.length) continue;
    const owner = co(String(r.owner || '').split(/\s*[,;]\s*/)[0]);
    const d = { builders: [...new Set(b)].slice(0, 2), project: clean(r.project_name), client: unnamed(owner) ? 'Unnamed owner' : owner, country: place(r.country), date: r.report_date, usd: usd(r), source: clean(r.source_name), key_dates: r.key_dates };
    const ow = (x) => x.client.toLowerCase().split(/\s+/)[0];
    const dup = out.find((x) => x.builders[0] === d.builders[0] && ((x.country && x.country === d.country) || (ow(x) === ow(d) && x.client !== 'Unnamed owner') || (x.usd && d.usd && Math.abs(x.usd - d.usd) / Math.max(x.usd, d.usd) < 0.05)));
    if (dup) continue;   // the same order reported twice under two names
    out.push(d);
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
// status: a future key date ("delivery Sep 2029") beats "awarded 25 Nov"
function status(d, today) {
  const kd = parties(d.key_dates).filter((x) => /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(x?.date || '') && String(x.date) > today && x.label).sort((a, b) => a.date.localeCompare(b.date))[0];
  const when = kd ? new Date(kd.date.slice(0, 7) + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const what = kd ? clean(kd.label).toLowerCase().replace(/\b(planned|expected|scheduled|targeted|target)\s+/g, '').slice(0, 22) : '';
  return { main: `awarded ${day(d.date)}`, sub: kd ? `${what} ${when}` : '' };
}

// the market with the most builders this month (needs >= 4 deals and >= 3 builders); avoid = yesterday's theme key
export function pickTheme(rows, today, { avoid = '', days = 30 } = {}) {
  const from = new Date(Date.parse(today + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10);
  const opts = THEMES.map((t) => ({ t, d: deals(rows, t, from) })).map((x) => ({ ...x, builders: new Set(x.d.flatMap((d) => d.builders)).size }))
    .filter((x) => x.d.length >= 4 && x.builders >= 3 && ![].concat(avoid).includes(x.t.key)).sort((a, b) => b.builders - a.builders || b.d.length - a.d.length);
  return opts[0] ? { theme: opts[0].t, deals: opts[0].d.slice(0, 8), all: opts[0].d, from, today } : null;
}

export function whoBuildsHtml(pick, logo) {
  const { theme, deals: rows, all, today } = pick;
  const total = all.reduce((s, d) => s + d.usd, 0), priced = all.filter((d) => d.usd).length;
  const builders = [...new Set(rows.flatMap((d) => d.builders))];
  const countries = new Set(all.map((d) => d.country).filter(Boolean));
  const flags = [...countries].map((c) => isoOf(c).toLowerCase()).filter(Boolean).slice(0, 4);
  const tiles = [[String(all.length), `contracts in ${new Set(all.flatMap((d) => d.builders)).size === 1 ? '' : 'our tracker, '}last 30 days`],
    priced ? [money(total), `published value of ${priced} of them`] : [String(new Set(all.flatMap((d) => d.builders)).size), 'builders named'],
    [String(countries.size), countries.size === 1 ? 'country' : 'client countries']];
  const names = builders.slice(0, 4);
  const so = `${theme.buys} are usually bought through ${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]} — get on their lists now.`;
  const srcs = [...new Set(rows.map((d) => d.source).filter(Boolean))].slice(0, 6).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=IBM+Plex+Sans:wght@500;600;700&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0b1626;--navy:#0f2d5e;--teal:#0f7c86;--gold:#e0bd4c;--bg:#eef4f6;--line:#cfdde3}
body{width:1080px;height:1350px;background:#fff;font-family:'IBM Plex Sans',sans-serif;color:var(--ink);display:flex;flex-direction:column;overflow:hidden}
.hd{display:flex;justify-content:space-between;align-items:flex-start;padding:40px 44px 0}
h1{font:900 76px/.9 'Barlow Condensed';text-transform:uppercase;color:var(--ink);max-width:760px}
.sub{font:600 24px/1.2 'IBM Plex Sans';color:#4a5a72;padding:14px 44px 0}
.rt{display:flex;flex-direction:column;align-items:flex-end;gap:12px}
.rt .lg{background:var(--navy);border-radius:10px;padding:8px 14px}.rt .lg img{height:44px;display:block}
.rt .fl{display:flex;gap:6px}.rt .fl img{height:34px;border-radius:3px;box-shadow:0 0 0 1px rgba(15,45,94,.25)}
table{margin:22px 44px 0;border-collapse:separate;border-spacing:0;width:calc(100% - 88px);border:2px solid var(--teal);border-radius:12px;overflow:hidden}
th{background:var(--teal);color:#fff;font:700 24px 'Barlow Condensed';text-align:left;padding:10px 14px;letter-spacing:.03em}
td{font:600 20px/1.18 'IBM Plex Sans';padding:9px 14px;border-top:1px solid var(--line);vertical-align:middle}
tr:nth-child(even) td{background:#f6fafb}
td.b{font:800 26px/1.05 'Barlow Condensed';color:var(--navy);width:250px}
td.p{width:290px}td.c{width:250px;color:#33445e}td.s small{display:block;font:500 17px/1.2 'IBM Plex Sans';color:#5a6a82;margin-top:3px}
td .f{height:16px;border-radius:2px;vertical-align:-1px;margin-right:6px;box-shadow:0 0 0 1px rgba(15,45,94,.2)}
.kp{margin:22px 44px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.kp div{background:var(--bg);border-radius:12px;padding:14px;text-align:center}
.kp b{display:block;font:900 58px/1 'Barlow Condensed';color:var(--teal)}
.kp span{display:block;font:600 19px/1.2 'IBM Plex Sans';color:#2b3a52;margin-top:4px}
.so{margin:20px 44px 0;background:var(--navy);color:#fff;border-radius:12px;padding:18px 26px;font:700 30px/1.15 'Barlow Condensed';text-align:center}
.so b{color:var(--gold)}
.sp{flex:1}
.ft{margin:14px 44px 18px;display:flex;justify-content:space-between;gap:18px;font:500 14px/1.35 'IBM Plex Sans';color:#5a6a82}
.ft div:last-child{border-left:2px solid var(--line);padding-left:16px;min-width:270px}.ft b{color:var(--navy)}
</style></head><body>
<div class="hd"><h1>${esc(theme.title)}</h1><div class="rt"><div class="lg"><img src="${logo}"></div><div class="fl">${flags.map((i) => `<img src="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/${i}.svg">`).join('')}</div></div></div>
<div class="sub">Contracts awarded in the last 30 days · status ${esc(monthYear(today))}</div>
<table><tr><th>Builder</th><th>Project</th><th>Client · country</th><th>Status</th></tr>
${rows.map((d) => { const s = status(d, today), i = isoOf(d.country).toLowerCase(); return `<tr><td class="b">${esc(d.builders.join(' + '))}</td><td class="p">${esc(d.project.length > 48 ? d.project.slice(0, 46).replace(/\s+\S*$/, '') + '…' : d.project)}</td><td class="c">${i ? `<img class="f" src="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/4x3/${i}.svg">` : ''}${esc(d.client)}${d.country ? ' · ' + esc(d.country) : ''}</td><td class="s">${esc(s.main)}${d.usd ? ' · ' + money(d.usd) : ''}${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</td></tr>`; }).join('')}
</table>
<div class="kp">${tiles.map(([b, s]) => `<div><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div>
<div class="so"><b>SO WHAT:</b> ${esc(so)}</div>
<div class="sp"></div>
<div class="ft"><div>Sources: ${esc(srcs)}; World Trade Pro project tracker (verified contract awards, ${esc(day(pick.from))} – ${esc(day(today))}; values as published, other currencies at approx. rates; our sums).</div><div><b>Own infographic © World Trade Pro Research</b><br>Share with credit · worldtradepro.com</div></div>
</body></html>`;
}

const tag = (s) => { const t = co(s).replace(/&/g, ' and ').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1))).join(''); return t.length >= 2 && t.length <= 26 ? t : ''; };
const listOf = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
export function whoBuildsPost(pick, ctaLine = '') {
  const { theme, deals: rows, all } = pick;
  const builders = [...new Set(rows.flatMap((d) => d.builders))];
  const total = all.reduce((s, d) => s + d.usd, 0), priced = all.filter((d) => d.usd).length;
  const lead = `${builders.length > 4 ? builders.slice(0, 4).join(', ') + ' and others are' : listOf(builders) + (builders.length > 1 ? ' are' : ' is')} ${theme.title.replace(/^Who builds /, 'building ')}: ${all.length} contracts in our tracker in the last 30 days${priced ? `, ${money(total)} published across ${priced} of them` : ''}.`;
  const facts = rows.map((d) => `• ${day(d.date)}: ${d.client === 'Unnamed owner' ? 'An unnamed owner' : d.client} awards ${d.project.toLowerCase().startsWith(d.client.toLowerCase() + ' ') ? 'its ' + d.project.slice(d.client.length + 1) : d.project} to ${d.builders.join(' and ')}${d.country ? ' (' + d.country + ')' : ''}${d.usd ? ', ' + money(d.usd) : ''}${d.source ? ' (' + d.source + ')' : ''}`);
  const why = `${theme.buys} are usually bought through the builder, not the client. The vendor lists that matter this month are ${listOf(builders.slice(0, 4).map((b) => b + "'s"))}.`;
  const tags = [...new Set([...builders.map(tag), 'Infrastructure'].filter(Boolean))].slice(0, 5).map((t) => '#' + t).join(' ');
  return [lead, ['Key facts', ...facts].join('\n'), ['Why it matters', why].join('\n'), 'Details and sources on the card. Counts and sums: World Trade Pro project tracker.', ctaLine, tags].filter(Boolean).join('\n\n');
}

// render, dropping the oldest rows until the card fits 1350 px (keeps at least 4)
export async function renderWhoBuilds(page, pick, logo, out) {
  let p = { ...pick };
  for (;;) {
    await page.setViewportSize({ width: 1080, height: 1350 });
    await page.setContent(whoBuildsHtml(p, logo), { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h <= 1350 || p.deals.length <= 4) break;
    p = { ...p, deals: p.deals.slice(0, -1) };
  }
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
  return p;   // the rows actually shown (the post text lists the same ones)
}
