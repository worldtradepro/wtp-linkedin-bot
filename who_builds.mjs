// "Who builds X" market card + post (owner 2026-11-27, pointing at a London BD consultancy's "WHO BUILDS BRAZIL'S NEXT FPSOS" post, 112 reactions:
// "不是让你研究下这个吗？"). One market, several builders: table Builder | Project | Client · country | Status, three market tiles,
// a "So what" bar that names the packages and the builders whose vendor lists matter, dated sources. No logos (trademarks).
// Every row is a verified contract award in our own tracker (last 30 days); counts and sums are ours.
import { shortCo } from './fact_card.mjs';
import { isoOf } from './common.mjs';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const esc = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// keep the suffix when the rest would not name the company ("China State Shipbuilding" -> not "China State")
const KEEP_SUFFIX = /^(China|Korea|Japan|India|National|State|China State|General|United|International)$/i;
const co = (s) => { const base = shortCo(s).replace(/(\s+(Co|S|S\.A)\.?)+$/, '').replace(/\s+(joint venture|consortium|JV)$/i, ' JV').replace(/[\s,]+$/, '').trim();
  const cut = base.replace(/\s+(Shipbuilding|Shipyard|Dockyard|Industries|Group|Holdings?)$/i, '').trim(); return KEEP_SUFFIX.test(cut) ? base : cut; };
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
    const b = parties(r.contractors).filter((x) => x?.name && BUILDER.test(x.role || '') && !NOT_BUILDER.test(x.role || '')).map((x) => co(x.name)).filter((n) => n && n.length > 2 && !/^[a-z]/.test(n) && !unnamed(n));
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

export function whoBuildsTableHtml(pick, logo) {
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

// Card v2 (owner 2026-11-28 '学习一下他的设计感' -> '换新版'): layout learned from a "Mozambique: the global race for gas"
// infographic - two-level headline with a yellow ribbon, series kicker, world MAP as the hero (client countries filled,
// flag pills in two side columns with arcs to the pins), one highlight panel, icon KPI strip, red numbers. Pins = CLIENT
// country (we do not hold builders' home countries). The old table card stays as whoBuildsTableHtml.
const SHORT = { 'United Kingdom': 'UK', 'United States': 'USA', 'United States of America': 'USA', 'United Arab Emirates': 'UAE', 'Saudi Arabia': 'Saudi Arabia' };
const TITLE = { floatlng: ['FLOATING LNG:', 'WHO WON THE HULLS'], tankers: ['NEW TANKERS:', 'WHO WON THE ORDERS'], ships: ['NEW SHIPS:', 'WHO WON THE ORDERS'],
  offshoreog: ['OFFSHORE OIL & GAS:', 'WHO WON THE WORK'], lng: ['LNG:', 'WHO WON THE WORK'], offwind: ['OFFSHORE WIND:', 'WHO WON THE WORK'],
  ports: ['PORTS & TERMINALS:', 'WHO WON THE WORK'], power: ['POWER & GRIDS:', 'WHO WON THE WORK'] };
// accent per market (the reference takes its colours from the subject)
const ACCENT = { floatlng: '#0e7490', tankers: '#1d4ed8', ships: '#1d4ed8', offshoreog: '#0f766e', lng: '#0e7490', offwind: '#15803d', ports: '#b45309', power: '#7c3aed' };
const ICON = {
  doc: '<svg viewBox="0 0 48 48" fill="none" stroke="#0b1626" stroke-width="3" stroke-linejoin="round"><path d="M12 4h17l9 9v31H12z"/><path d="M29 4v9h9M18 22h14M18 29h14M18 36h9"/></svg>',
  coin: '<svg viewBox="0 0 48 48" fill="none" stroke="#0b1626" stroke-width="3"><ellipse cx="24" cy="12" rx="15" ry="6"/><path d="M9 12v8c0 3.3 6.7 6 15 6s15-2.7 15-6v-8M9 20v8c0 3.3 6.7 6 15 6s15-2.7 15-6v-8M9 28v8c0 3.3 6.7 6 15 6s15-2.7 15-6v-8"/></svg>',
  globe: '<svg viewBox="0 0 48 48" fill="none" stroke="#0b1626" stroke-width="3"><circle cx="24" cy="24" r="19"/><path d="M5 24h38M24 5c6 6 6 32 0 38M24 5c-6 6-6 32 0 38"/></svg>',
};

export function whoBuildsHtml(pick, logo) {
  const { theme, all } = pick;
  const acc = ACCENT[theme.key] || '#0f766e';
  const [t1, t2] = TITLE[theme.key] || [theme.title.toUpperCase(), ''];
  // one pill per client country (several deals in one country share a pill)
  const byC = new Map();
  for (const d of all) { if (!d.country) continue; if (!byC.has(d.country)) byC.set(d.country, []); byC.get(d.country).push(d); }
  const pills = [...byC.entries()].slice(0, 8).map(([c, ds]) => ({ c, iso: isoOf(c).toLowerCase(), lines: ds.slice(0, 2).map((d) => ({ b: d.builders[0], cl: d.client, v: d.usd ? money(d.usd) : '' })) }));
  const total = all.reduce((s, d) => s + d.usd, 0), priced = all.filter((d) => d.usd).length;
  const big = all.some((d) => d.usd) ? [...all].sort((a, b) => b.usd - a.usd)[0] : all[0];
  const cnt = {}; all.forEach((d) => d.builders.forEach((b) => (cnt[b] = (cnt[b] || 0) + 1)));
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  const names = [...new Set(all.flatMap((d) => d.builders))].slice(0, 4);
  const so = `${theme.buys} usually go through ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. Get on their vendor lists.`;
  const srcs = [...new Set(all.map((d) => d.source).filter(Boolean))].slice(0, 5).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;0,900;1,800;1,900&family=IBM+Plex+Sans:wght@500;600;700&display=block" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0b1626;--acc:${acc};--red:#d62828;--gold:#f5c518;--cream:#fdf8ec}
body{width:1080px;height:1350px;background:#fff;font-family:'IBM Plex Sans',sans-serif;color:var(--ink);position:relative;overflow:hidden}
.top{display:flex;align-items:center;gap:26px;padding:34px 44px 0}
.lg{background:#0f2d5e;border-radius:10px;padding:8px 14px;flex:none}.lg img{height:46px;display:block}
.bar{width:3px;height:120px;background:var(--ink);flex:none}
h1{font:900 100px/.86 'Barlow Condensed';letter-spacing:-.01em}
.rib{display:inline-block;margin-top:8px;background:var(--gold);padding:4px 26px 2px 18px;transform:skewX(-10deg);font:italic 900 52px/1 'Barlow Condensed';color:var(--ink)}
.rib span{display:inline-block;transform:skewX(10deg)}
.kick{display:flex;align-items:center;gap:16px;margin:20px 44px 0;font:italic 600 22px 'IBM Plex Sans';color:#33445e}
.kick:before,.kick:after{content:'';flex:1;height:2px;background:var(--red)}
.kick b{font-weight:700;color:var(--ink)}
#map{position:absolute;left:0;top:262px;width:1080px;height:560px}
.pill{position:absolute;width:212px;background:#fff;border-radius:12px;box-shadow:0 3px 10px rgba(11,22,38,.18);border:1.5px solid #d9e2ea;overflow:visible}
.pill .tab{display:flex;align-items:center;gap:8px;background:var(--ink);color:#fff;border-radius:999px;margin:-14px 10px 0 -8px;padding:3px 14px 3px 4px;font:800 21px/1 'Barlow Condensed';letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}
.pill .tab img{width:30px;height:30px;border-radius:50%;object-fit:cover;border:2px solid #fff}
.pill .ln{padding:6px 12px 0;text-align:center}.pill .ln:last-child{padding-bottom:8px}
.pill .ln b{display:block;font:800 23px/1.05 'Barlow Condensed'}
.pill .ln small{display:block;font:500 15px/1.2 'IBM Plex Sans';color:#4a5a72}.pill .ln small i{font-style:normal;color:var(--red);font-weight:700}
.key{position:absolute;left:44px;right:44px;top:836px;background:var(--cream);border:2px solid #ead9a8;border-radius:16px;display:grid;grid-template-columns:1fr 2px 1fr;padding:30px 0 20px}
.key .lb{position:absolute;left:-2px;top:-22px;background:var(--acc);color:#fff;font:900 28px/1 'Barlow Condensed';padding:9px 26px 7px;border-radius:12px 12px 12px 0;letter-spacing:.03em}
.key .sep{background:var(--ink)}
.key div.c{padding:0 26px;font:600 22px/1.25 'IBM Plex Sans'}
.key div.c em{display:inline-block;background:var(--red);color:#fff;font:italic 900 22px/1 'Barlow Condensed';padding:5px 14px;border-radius:8px;transform:skewX(-8deg);margin-bottom:8px;letter-spacing:.03em}
.key b.n{font:900 50px/1 'Barlow Condensed';color:var(--red)}
.kp{position:absolute;left:44px;right:44px;top:1066px;display:grid;grid-template-columns:repeat(3,1fr);border-top:2px dotted #9aa7b8;padding-top:20px}
.kp div{display:flex;align-items:center;gap:14px;padding:0 18px;border-left:2px solid #c9d2dc}.kp div:first-child{border-left:0;padding-left:0}
.kp svg{width:52px;height:52px;flex:none}
.kp b{font:900 60px/.9 'Barlow Condensed';color:var(--red)}
.kp span{font:600 18px/1.15 'IBM Plex Sans'}
.so{position:absolute;left:0;right:0;top:1160px;background:var(--ink);color:#fff;padding:20px 44px 20px 60px;font:700 27px/1.18 'Barlow Condensed'}
.so:before{content:'';position:absolute;left:0;top:0;bottom:0;width:16px;background:var(--gold)}
.so b{color:var(--gold)}
.ft{position:absolute;left:44px;right:44px;bottom:16px;display:flex;justify-content:space-between;gap:18px;font:500 13.5px/1.35 'IBM Plex Sans';color:#5a6a82}
.ft div:last-child{text-align:right;min-width:260px}.ft b{color:#0f2d5e}
</style></head><body>
<div class="top"><div class="lg"><img src="${logo}"></div><div class="bar"></div><div><h1>${esc(t1)}</h1>${t2 ? `<div class="rib"><span>${esc(t2)}</span></div>` : ''}</div></div>
<div class="kick"><span><b>Who Builds</b> | Market spotlight — contracts awarded ${esc(day(pick.from))} – ${esc(day(pick.today))}</span></div>
<svg id="map"></svg>
<div id="pills"></div>
<div class="key"><div class="lb">BIGGEST AWARDS</div>
<div class="c"><em>${big.usd ? 'LARGEST PUBLISHED' : 'LATEST AWARD'}</em><br><b>${esc(big.builders[0])}</b> for ${esc(big.client.length > 22 ? big.client.split(' ').slice(0, 2).join(' ') : big.client)}<br><b class="n">${big.usd ? money(big.usd) : esc(day(big.date))}</b><br><span style="font-size:18px;color:#4a5a72">${esc(big.project.length > 52 ? big.project.slice(0, 50).replace(/\s+\S*$/, '') + '…' : big.project)}</span></div>
<div class="sep"></div>
${top[1] > 1 ? `<div class="c"><em>MOST NAMED BUILDER</em><br><b>${esc(top[0])}</b><br><b class="n">${top[1]}</b> <span style="font-size:22px">contracts</span><br><span style="font-size:18px;color:#4a5a72">in this market, last 30 days</span></div>` : `<div class="c"><em>NO ONE BUILDER LEADS</em><br><b class="n">${Object.keys(cnt).length}</b> <span style="font-size:22px">different builders</span><br><span style="font-size:18px;color:#4a5a72">split the ${all.length} contracts</span></div>`}</div>
<div class="kp"><div>${ICON.doc}<b>${all.length}</b><span>contracts in our tracker</span></div>
<div>${ICON.coin}<b>${priced ? money(total) : Object.keys(cnt).length}</b><span>${priced ? `published value<br>of ${priced} deals` : 'builders named'}</span></div>
<div>${ICON.globe}<b>${byC.size}</b><span>client<br>countries</span></div></div>
<div class="so"${so.length > 150 ? ' style="font-size:23px"' : so.length > 125 ? ' style="font-size:25px"' : ''}><b>SO WHAT:</b> ${esc(so)}</div>
<div class="ft"><div>Sources: ${esc(srcs)}; World Trade Pro project tracker (verified contract awards; values as published; our sums).</div><div><b>Own infographic © World Trade Pro Research</b><br>Share with credit · worldtradepro.com</div></div>
<script>
{
const PILLS = ${JSON.stringify(pills.map((p) => ({ ...p, short: SHORT[p.c] || p.c })))};
const FIX = { Qatar: [51.2, 25.3], Singapore: [103.8, 1.35], Bahrain: [50.55, 26.07], 'United States': [-98, 39], 'Hong Kong': [114.2, 22.3], Malta: [14.4, 35.9] };
const ALIAS = { 'United States': 'United States of America', 'Czech Republic': 'Czechia', 'South Korea': 'South Korea', 'Ivory Coast': "Côte d'Ivoire" };
(async () => {
  const topo = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json').then((r) => r.json());
  const land = topojson.feature(topo, topo.objects.countries);
  const W = 1080, H = 560, svg = d3.select('#map').attr('viewBox', '0 0 ' + W + ' ' + H);
  const proj = d3.geoNaturalEarth1().fitExtent([[120, 0], [960, 560]], { type: 'Sphere' });
  const path = d3.geoPath(proj);
  const hit = new Set(PILLS.map((p) => ALIAS[p.c] || p.c));
  const defs = svg.append('defs');
  const g = defs.append('linearGradient').attr('id', 'sea').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
  g.append('stop').attr('offset', 0).attr('stop-color', '#eef6f5'); g.append('stop').attr('offset', 1).attr('stop-color', '#ffffff');
  svg.append('path').datum({ type: 'Sphere' }).attr('d', path).attr('fill', 'url(#sea)');
  svg.append('g').selectAll('path').data(land.features).join('path').attr('d', path)
    .attr('fill', (f) => (hit.has(f.properties.name) ? '${acc}' : '#a9cfc6')).attr('stroke', '#fff').attr('stroke-width', 0.6);
  // pin per pill
  const pts = PILLS.map((p) => { const f = land.features.find((x) => x.properties.name === (ALIAS[p.c] || p.c)); const ll = FIX[p.c] || (f ? d3.geoCentroid(f) : null); return ll ? { ...p, xy: proj(ll) } : null; }).filter(Boolean);
  // pills in two side columns (west half left, east half right), each column ordered by latitude, like the reference
  const L = pts.filter((p) => p.xy[0] < W / 2).sort((a, b) => a.xy[1] - b.xy[1]), R = pts.filter((p) => p.xy[0] >= W / 2).sort((a, b) => a.xy[1] - b.xy[1]);
  const byX = (a, b) => a.xy[0] - b.xy[0];
  while (L.length > 4) { L.sort(byX); R.push(L.pop()); } while (R.length > 4) { R.sort(byX); L.push(R.shift()); }
  L.sort((a, b) => a.xy[1] - b.xy[1]); R.sort((a, b) => a.xy[1] - b.xy[1]);
  const box = document.getElementById('pills'); const lines = svg.append('g');
  const place = (col, x) => { let y = 262 + 34; const els = []; col.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'pill';
    el.innerHTML = '<div class="tab">' + (p.iso ? '<img src="https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/1x1/' + p.iso + '.svg">' : '') + p.short + '</div>' +
      p.lines.map((l) => '<div class="ln"><b>' + l.b + '</b><small>for ' + l.cl + (l.v ? ' · <i>' + l.v + '</i>' : '') + '</small></div>').join('');
    box.appendChild(el);
    el.style.left = x + 'px'; el.style.top = y + 'px'; y += el.getBoundingClientRect().height + 26; els.push([el, p]); });
    if (y > 262 + 560 + 10) { y = 262 + 34; els.forEach(([el, p]) => { const ln = el.querySelectorAll('.ln'); if (ln.length > 1) { ln[1].innerHTML = '<small>+ ' + (p.lines.length - 1) + ' more</small>'; } el.style.top = y + 'px'; y += el.getBoundingClientRect().height + 26; }); }
    const gap = Math.max(0, (262 + 560 - y) / (els.length + 1)); let k = 1;
    els.forEach(([el, p]) => { el.style.top = (parseFloat(el.style.top) + gap * k++) + 'px';
    const r = el.getBoundingClientRect(); const ax = x < W / 2 ? r.right : r.left, ay = r.top + r.height / 2 - 262;
    const [px, py] = p.xy;
    lines.append('path').attr('d', 'M' + ax + ',' + ay + ' Q' + (ax + px) / 2 + ',' + (Math.min(ay, py) - 40) + ' ' + px + ',' + py)
      .attr('fill', 'none').attr('stroke', '#e0a800').attr('stroke-width', 3).attr('stroke-linecap', 'round');
    lines.append('circle').attr('cx', px).attr('cy', py).attr('r', 9).attr('fill', '#fff').attr('stroke', '${acc}').attr('stroke-width', 4);
    lines.append('circle').attr('cx', ax).attr('cy', ay).attr('r', 5).attr('fill', '#e0a800');
  }); };
  place(L, 30); place(R, 1080 - 30 - 212);
  window.done = true;
})();
}
</script>
</body></html>`;
}

// render the map card (waits for the map script); returns the pick with the deals the card shows, for the post text
export async function renderWhoBuilds(page, pick, logo, out) {
  await page.setViewportSize({ width: 1080, height: 1350 });
  await page.setContent(whoBuildsHtml(pick, logo), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.done === true, null, { timeout: 45000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
  const shownC = [...new Set(pick.all.map((d) => d.country).filter(Boolean))].slice(0, 8);
  return { ...pick, deals: pick.all.filter((d) => shownC.includes(d.country)).slice(0, 8) };
}
