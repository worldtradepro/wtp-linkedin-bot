// Deep card hero variants (owner 2026-11-21: "深度卡不是只是排名吧"). Each returns { hero, tiles, head, so } for deep_card.mjs deepCardHtml,
// or null when our tracker has too little to say. Everything is computed from our own verified rows - no model writes numbers.
//   orderBook   - the project's contractor: its other wins in our tracker (last 90 days)   -> who is busy buying now
//   costPerMw   - US$ per MW against priced same-sector peers (last 90 days)                 -> is the budget tight or generous
//   pipeline    - all projects in the same country by stage (last 30 days)                   -> how big the market behind this one is
//   timeline    - the project's own key dates (FID, financial close, start, completion)      -> when buying happens
import { usdOf, curCode } from './deep_card.mjs';
import { sameDeal } from './deep_post.mjs';
import { stageName } from './fact_card.mjs';
import { CAPEX_REF, refFor } from './capex_ref.mjs';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cut = (t, n) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');
const money = (usd) => (usd >= 1e9 ? `$${+(usd / 1e9).toFixed(usd >= 1e10 ? 0 : 1)}bn` : `$${Math.round(usd / 1e6)}m`);
const parties = (v) => { let a = v; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } } return (Array.isArray(a) ? a : []).map((x) => clean(typeof x === 'string' ? x : x?.name)).filter(Boolean); };
const key = (n) => clean(n).toLowerCase().replace(/\([^)]*\)/g, '').replace(/\b(limited|ltd|inc|corp|corporation|company|co|group|plc|sa|ag|se|llc)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const sameName = (a, b) => { const x = key(a), y = key(b); return !!x && !!y && (x === y || (x.length >= 5 && y.startsWith(x)) || (y.length >= 5 && x.startsWith(y))); };
const dedupe = (rows) => { const seen = new Set(); return rows.filter((r) => { const k = key(r.project_name).slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; }); };
const isMe = (f, r) => key(r.project_name).slice(0, 40) === key(f.name).slice(0, 40);
const mwOf = (cap) => { const m = /([\d.,]+)\s*(GW|MW)\b/i.exec(cap || ''); if (!m) return 0; const n = Number(m[1].replace(/,/g, '')); return m[2].toUpperCase() === 'GW' ? n * 1000 : n; };

// 1. the contractor's order book
export function orderBook(f, rows90) {
  const con = (f.contractors || '').split(', ')[0];
  if (!con) return null;
  // one bar per deal: the same order often sits in the tracker twice under other names (2026-11-27, Hanwha VLCCs) - deep_post.mjs sameDeal
  const wins = [{ project_name: f.name, country: f.country, owner: f.owner, value_amount: f.valueAmount, value_unit: f.valueUnit, value_currency: f.valueCurrency }];
  for (const r of rows90.filter((r) => parties(r.contractors).some((p) => sameName(p, con))).sort((a, b) => String(b.report_date).localeCompare(String(a.report_date))))
    if (!wins.some((w) => sameDeal(w, r))) wins.push(r);
  if (wins.length < 3) return null;
  const priced = wins.map((r) => ({ r, usd: usdOf(r) })).sort((a, b) => b.usd - a.usd);
  const total = priced.reduce((s, x) => s + x.usd, 0), countries = new Set(wins.map((r) => r.country).filter(Boolean)).size;
  const top = priced.slice(0, 6); const mi = priced.findIndex((x) => isMe(f, x.r)); if (mi >= 6) top[5] = priced[mi];
  const short = con.replace(/\s*\(.*\)$/, '');
  return {
    head: `${short} is named as contractor on ${wins.length} projects in 90 days`,
    hero: { title: `${short}: projects naming it as contractor in our tracker, last 90 days (US$, approx.)`, legend: 'Flag = the project\'s country · "no price" = value not published',
      bars: top.map((x) => ({ label: cut(clean(x.r.project_name), 48), country: x.r.country, v: x.usd / 1e6 || 0.0001, show: x.usd ? money(x.usd) : 'no price', me: isMe(f, x.r) })) },
    tiles: [[String(wins.length), 'projects, last 90 days'], [total ? money(total) : '—', 'published value of those projects'], [String(countries), countries === 1 ? 'country' : 'countries']],
    so: `${short} is lined up for ${wins.length} projects at once. Its buyers will need suppliers.`,
  };
}

// 2. cost per MW against peers
const BUILD = /^(Award|Tender|FID|Financing|Construction start|Study\/FEED)$/;
export function costPerMw(f, rows90) {
  const mine = mwOf(f.capacity), usd = usdOf(f);
  if (!mine || !usd || (f.eventType && !BUILD.test(f.eventType))) return null;
  // same subsector first; too few there -> the whole sector (like the peer ranking)
  const peerRows = (same) => dedupe(rows90.filter((r) => same(r) && !isMe(f, r) && (!r.event_type || BUILD.test(r.event_type))));
  let bySector = false, peers = peerRows((r) => (f.subsector ? r.subsector === f.subsector : r.sector === f.sector)).map((r) => ({ r, mw: mwOf(r.capacity), usd: usdOf(r) })).filter((x) => x.mw >= 5 && x.usd > 0);
  if (peers.length < 3) return null;
  const all = [...peers, { r: { project_name: f.name, country: f.country }, mw: mine, usd, me: true }].map((x) => ({ ...x, per: x.usd / x.mw / 1e6 })).sort((a, b) => b.per - a.per);
  const sorted = peers.map((x) => x.usd / x.mw / 1e6).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const myPer = usd / mine / 1e6, cheaper = sorted.filter((p) => p > myPer).length;
  let top = all.slice(0, 6); const mi = all.findIndex((x) => x.me); if (mi >= 6) top[5] = all[mi];
  const fmt = (p) => `$${p >= 10 ? Math.round(p) : +p.toFixed(2)}m`;
  const sector = ((bySector ? f.sector : f.subsector) || f.sector || 'project').toLowerCase();
  return {
    head: `${fmt(myPer)} per MW: ${myPer < median ? 'below' : 'above'} the ${sector} median`,
    hero: { title: `US$ million per MW, priced ${sector} projects in our tracker, last 90 days (approx.)`, legend: 'Value ÷ capacity as published · flag = the project\'s country · scope differs project to project',
      bars: top.map((x) => ({ label: cut(clean(x.r.project_name), 48), country: x.r.country, v: x.per, show: fmt(x.per), me: !!x.me })) },
    tiles: [[fmt(myPer), 'per MW, this project'], [fmt(median), `median of ${peers.length} peers`], [`${cheaper} of ${peers.length}`, 'peers cost more per MW']],
    so: myPer < median ? 'A tight budget per MW: expect hard price talks on equipment.' : 'More money per MW than most peers: room for higher-spec equipment.',
  };
}

// 3. the country's pipeline by stage
export function pipeline(f, rows30) {
  if (!f.country) return null;
  const here = dedupe(rows30.filter((r) => r.country === f.country && r.sector === f.sector));
  if (here.length < 5) return null;
  const sectorName = String(f.sector || 'projects').replace(/\b([A-Z][a-z]+)\b/g, (w) => w.toLowerCase());
  const stages = ['S1', 'S2', 'S3', 'S4', 'S5'].map((k) => ({ k, n: here.filter((r) => String(r.stage || '').startsWith(k)).length }));
  if (stages.filter((s) => s.n).length < 3) return null;   // two bars say little
  const mine = String(f.stage || '').slice(0, 2), early = stages.filter((s) => ['S1', 'S2', 'S3'].includes(s.k)).reduce((a, s) => a + s.n, 0);
  const priced = here.map((r) => usdOf(r)).reduce((a, b) => a + b, 0);
  const subs = {}; for (const r of here) if (r.subsector) subs[r.subsector] = (subs[r.subsector] || 0) + 1;
  const topSub = Object.entries(subs).sort((a, b) => b[1] - a[1])[0];
  return {
    head: `${f.country}: ${here.length} ${sectorName} projects in 30 days, ${early} before tender`,
    hero: { title: `${f.country}: ${sectorName} projects in our tracker by stage, last 30 days`, legend: 'Highlighted = the stage of this project',
      bars: stages.filter((s) => s.n).map((s) => ({ label: stageName(s.k), country: '', v: s.n, show: String(s.n), me: s.k === mine })) },
    tiles: [[String(here.length), `${sectorName} projects, last 30 days`], [String(early), 'still before tender'], [f.subsector && subs[f.subsector] ? String(subs[f.subsector]) : priced ? `$${(priced / 1e9).toFixed(1)}bn` : '—', f.subsector && subs[f.subsector] ? `in ${f.subsector.toLowerCase()}` : 'published value']],
    so: `${early} ${sectorName} projects in ${f.country} are still before tender. That is the time to get on vendor lists.`,
  };
}

// 4. key dates (fields v3 key_dates: [{label, date}]) -> [{ when, what }] for the timeline strip
export function timelineOf(raw) {
  let a = raw; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
  const items = (Array.isArray(a) ? a : []).map((x) => ({ date: clean(x?.date), label: clean(x?.label) })).filter((x) => /^\d{4}/.test(x.date) && x.label);
  const when = (d) => (/^\d{4}-\d{2}/.test(d) ? new Date(d.slice(0, 7) + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : d.slice(0, 4));
  const what = (l) => cut(l.replace(/\s*\([^)]*\)/g, '').replace(/\b(scheduled|expected|targeted|target|planned)\b/gi, '').replace(/\s+/g, ' ').trim(), 26);
  const out = []; for (const x of items.sort((a, b) => a.date.localeCompare(b.date))) { const w = when(x.date); if (!out.some((o) => o.when === w)) out.push({ when: w, what: what(x.label) }); }
  return out.length >= 2 ? out : [];
}

// pick the most telling hero (order book > what it buys > peer ranking > pipeline), avoiding yesterday's kind.
// costPerMw is kept but not offered: project unit costs vs a norm are easy to get wrong and can offend (owner 2026-11-21)
export function pickHero(f, { rows30, rows90, peerChart, avoid = '' }) {
  const options = [['orderBook', () => orderBook(f, rows90)], ['packages', () => packages(f)], ['pipeline', () => pipeline(f, rows30)], ['ranking', () => (peerChart?.bars?.length >= 3 ? {} : null)]];   // ranking last: owner doubted readers care about 'priced projects in our tracker' (2026-11-21)
  const ok = options.map(([k, fn]) => [k, fn()]).filter(([, v]) => v);
  const pick = ok.find(([k]) => k !== avoid) || ok[0];
  return pick ? { kind: pick[0], ...pick[1] } : null;
}
export { curCode };

// 5. what the project buys (owner 2026-11-21: "先做A"): typical cost shares by procurement package from a published reference
// (capex_ref.mjs, one table per project type, every share with its source). Shares are the industry's typical split, not a claim about
// this project; US$ per package only when the value is the whole build cost (award / FID / construction start), never for a loan.
const WHOLE = /^(Award|FID|Construction start|Tender)$/;
const lc = (s) => s.replace(/\b([A-Z][a-z]+)\b/g, (w) => w.toLowerCase());   // keep acronyms: HRSG, EPC
// owner 2026-11-21: no project-specific numbers here - a unit cost "above the norm" is easy to get wrong (the value may be a loan, a
// first phase or one contract) and easy to offend; US$ per package has the same problem. Typical shares from the reference only.
export function packages(f) {
  const ref = refFor(f); if (!ref) return null;
  const bars = ref.packages.map((p, i) => ({ label: p.name, country: '', v: p.share, show: `${p.share}%`, me: i === 0 }));
  const [top, second] = ref.packages;
  return {
    hero: { title: `${ref.label}: typical share of build cost by package`, legend: 'Typical split for this type of plant · highlighted = the biggest package', bars },
    tiles: [],   // owner 2026-11-21: tiles repeated the chart's own numbers (26% / 19%) - this card has no tile row
    // owner 2026-11-21: a So what line only repeated the chart's biggest bar - this card ends with the Project Alerts call to action
    cta: 'projects like this that match your product, sent the same day on WhatsApp.',
    footnote: `Chart: typical split from ${ref.source}. Not this project's contract.`,
  };
}
export { CAPEX_REF };
