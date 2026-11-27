// "Who builds" headline + post text for deep data cards (owner 2026-11-27, after a London BD consultancy's infographic posts:
// "研究下这个账号。他的帖子做的不错" -> "改深度卡和帖子文字").
// The contractor is the subject (who builds, who buys the packages). The post reads like a short brief:
//   hook that names the companies and the number -> "Key facts", each line dated and sourced -> "Why it matters" (stage, the typical
//   packages from a published split, whose vendor list to get on) -> source line -> company-name hashtags.
// Every fact comes from our fields (fields v3) or our own tracker; no model writes anything here.
import { valueTile, eventTitle, eventWhat, shortCo, soWhat, artKey } from './fact_card.mjs';
import { refFor } from './capex_ref.mjs';

const BUILDER = /\b(epc|epci|epcc|contractor|construct\w*|build\w*|shipbuild\w*|shipyard|yard|design|install\w*|supplier|integrator|provider|feed|engineering|survey)\b/i;
const NOT_BUILDER = /\b(offtaker|buyer|subsidiary|charterer|lender|investor|owner)\b/i;
const unnamed = (s) => !s || /\b(unnamed|undisclosed|unknown|not named)\b/i.test(s);
// shortCo leaves the "Co." of "Co., Ltd." and the "S." of "S.A.S."
const co = (s) => shortCo(s).replace(/(\s+(Co|S|S\.A)\.?)+$/, '').replace(/[\s,]+$/, '').trim();
const norm = (s) => co(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const poss = (s) => (/s$/.test(s) ? s + "'" : s + "'s");
const place = (c) => (c && !/^(unknown|global|international|various|worldwide)$/i.test(c) ? c : '');
const ownerOf = (f) => co(String(f.owner || '').split(/\s*[,;]\s*/)[0]);

// the first contractor, when it is the one building or supplying (not an offtaker, buyer or the owner itself)
export function builderOf(f) {
  const con = co((f.contractors || '').split(', ')[0]);
  if (!con || unnamed(con) || norm(con) === norm(ownerOf(f))) return '';
  const role = f.contractorRole || '';
  if (NOT_BUILDER.test(role)) return '';
  return BUILDER.test(role) || /^(EPC|Shipyard)/.test(f.contractorLabel || '') ? con : '';
}
// a contract won now - not a delivery, construction start, offtake or financing that happens to sit at stage S5
export const isWin = (f) => !!builderOf(f) && (/^(Award|Study\/FEED|Equipment\/vessel order)$/.test(f.eventType || '') || (!f.eventType && String(f.stage || '').startsWith('S5')));
const isShip = (f) => artKey(f.sector, f.subsector, f.name, f.capacity) === 'ship' || f.eventType === 'Equipment/vessel order';
const valueText = (f) => { const v = valueTile(f); return v ? v.big + (v.unit ? (v.unit === 'BN' ? 'bn' : v.unit === 'M' ? 'm' : ' ' + v.unit) : '') : ''; };

// "Saipem wins Offshore Manifold and Pipeline EPCI from Aramco"; value:true -> "Saipem wins US$650m Offshore ... from Aramco".
// Anything else than a contract won by a named builder -> the usual event headline (owner as subject).
export function whoTitle(f, { value = false } = {}) {
  if (!isWin(f)) return eventTitle(f);
  const con = builderOf(f), who = ownerOf(f), from = unnamed(who) ? '' : who;
  const what = eventWhat(f), val = value && valueText(f) ? valueText(f) + ' ' : '';
  if (f.eventType === 'Study/FEED') return `${con} picked for FEED on ${from ? poss(from) + ' ' : ''}${what}`;
  if (isShip(f)) return `${con} to build ${val}${what}${from ? ' for ' + from : ''}`;
  return `${con} wins ${val}${what}${from ? ' from ' + from : ''}`;
}

const tagOf = (s) => {
  if (unnamed(s)) return '';
  const t = co(s).replace(/&/g, ' and ').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1))).join('');
  return t.length >= 2 && t.length <= 28 ? t : '';
};
const dayText = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : /^\d{4}-\d{2}$/.test(d || '') ? new Date(d + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(d || ''));
const listOf = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const pk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);

// The same deal is often in the tracker twice under different names ("Two VLCC Tanker Newbuild Order" US$272m / "Advantage VLCC Newbuild
// Pair" US$262m, 2026-11-27): same owner word, or a value within 5 % in the same currency, counts as one deal.
const UNIT = { thousand: 1e3, million: 1e6, billion: 1e9 };
const amountOf = (x) => { const n = Number(x.value_amount ?? x.valueAmount), u = UNIT[x.value_unit ?? x.valueUnit]; return n > 0 && u ? n * u : 0; };
const curOf = (x) => String(x.value_currency ?? x.valueCurrency ?? '').replace(/^(\$|US\$)$/, 'USD').toUpperCase();
const ownerWord = (x) => norm(String(x.owner || '').split(/\s*[,;]\s*/)[0]).split(' ').find((w) => w.length >= 4 && !/^(the|unnamed|undisclosed|unknown|consortium)$/.test(w)) || '';
export function sameDeal(a, b) {
  if (pk(a.project_name ?? a.name) === pk(b.project_name ?? b.name)) return true;
  const oa = ownerWord(a), ob = ownerWord(b);
  if (oa && oa === ob) return true;
  const va = amountOf(a), vb = amountOf(b);
  return !!(va && vb && curOf(a) === curOf(b) && Math.abs(va - vb) / Math.max(va, vb) < 0.05);
}
// the builder's other projects in our tracker (rows = last 90 days, verified), newest first, one row per deal
export function otherWins(f, rows) {
  const con = builderOf(f); if (!con || !rows?.length) return [];
  const k = norm(con), out = [], me = { project_name: f.name, owner: f.owner, value_amount: f.valueAmount, value_unit: f.valueUnit, value_currency: f.valueCurrency };
  for (const r of [...rows].sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)))) {
    let a = r.contractors; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
    const hit = (Array.isArray(a) ? a : []).some((x) => { const n = norm(typeof x === 'string' ? x : x?.name); return n && (n === k || (k.length >= 5 && n.length >= 5 && (n.startsWith(k) || k.startsWith(n)))); });
    if (hit && !sameDeal(r, me) && !out.some((o) => sameDeal(o, r))) out.push(r);
  }
  return out;
}

// post blocks (render.mjs joins them with blank lines and adds the photo credit and the Project Alerts line before the hashtags)
export function deepPostBlocks(f, { rows90 = [], source = '', flagPrefix = '' } = {}) {
  const win = isWin(f), con = win ? builderOf(f) : '', who = ownerOf(f), owner = unnamed(who) ? 'The owner' : who, where = place(f.country);
  const src = source || f.source || 'public reports', reported = dayText(f.reportDate), val = valueText(f), v = valueTile(f), what = eventWhat(f);
  const fin = (f.financing || '').split(', ').filter(Boolean).map(co);
  const head = `${flagPrefix ? flagPrefix + ' ' : ''}${whoTitle(f, { value: true })}`.trim();
  const valWords = val ? `, ${(v.label || 'value').toLowerCase()} ${val}` : '';
  const money = fin.length ? ` Money comes from ${listOf(fin)}.` : '';
  const hook = (win
    ? (isShip(f) ? `${owner} has ordered ${what} from ${con}${where ? ' (' + where + ')' : ''}` : `${owner} has picked ${con} for its ${what}${where ? ' in ' + where : ''}`)
    : `${what}${where ? ', ' + where : ''}`) + `${valWords}.${win ? money : ''}`
    + (win ? '' : (() => {   // not a contract won: name every company with its role instead
      const c = co((f.contractors || '').split(', ')[0]), role = String(f.contractorRole || '').replace(/\s*\(.*\)$/, '').toLowerCase();
      const who2 = [!unnamed(who) && `${who} (owner)`, c && !unnamed(c) && norm(c) !== norm(who) && `${c}${role && role.length <= 30 ? ` (${role})` : ''}`, ...fin.map((x) => `${x.replace(/\s+(financing|funding|loans?)$/i, '')} (financing)`)].filter(Boolean);
      return who2.length ? ` Companies involved: ${listOf(who2)}.` : '';
    })()) + (win ? ' Who is involved, and what gets bought next:' : ' The facts, and what usually comes next:');

  const facts = [`• ${reported ? reported + ': ' : ''}${eventTitle(f)}${val ? ', ' + val : ''} (${src})`];
  if (f.capacity && f.capacity.length <= 90) facts.push(`• Capacity: ${f.capacity} (${src})`);
  if (fin.length) facts.push(`• Financing: ${f.financing} (${src})`);
  let kd = f.keyDates; if (typeof kd === 'string') { try { kd = JSON.parse(kd); } catch { kd = []; } }
  for (const x of (Array.isArray(kd) ? kd : []).filter((x) => /^\d{4}/.test(x?.date || '') && x?.label).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 3))
    facts.push(`• ${dayText(x.date)}: ${String(x.label).replace(/\s+/g, ' ').trim()} (${src})`);
  const others = otherWins(f, rows90);
  if (con && others.length) {
    const countries = new Set([f.country, ...others.map((r) => r.country)].map(place).filter(Boolean)).size;
    const eg = others.slice(0, 2).map((r) => { const n = String(r.project_name).replace(/\s+/g, ' ').trim(), c = place(r.country); return c && !n.includes(c) ? `${n} (${c})` : n; });
    facts.push(`• ${con} is named as contractor on ${others.length + 1} projects in our tracker in the last 90 days${countries > 1 ? `, in ${countries} countries` : ''}, including ${listOf(eg)} (World Trade Pro project tracker, our count)`);
  }

  const why = [soWhat(f)];
  const ref = refFor(f);
  if (ref) why.push(`On a ${ref.label.replace(/\s*\(.*\)$/, '').toLowerCase()}, the biggest packages are usually ${listOf(ref.packages.slice(0, 3).map((p) => `${p.name.toLowerCase()} (about ${p.share}% of build cost)`))}.`);
  if (win) why.push(`If you supply ${ref ? 'those packages' : 'equipment, materials or services for this kind of work'}, the vendor list to get on is ${poss(con)}, not only ${unnamed(who) ? "the owner's" : poss(who)}.`);

  const tags = [...new Set([tagOf(con), tagOf(who), tagOf(f.subsector || ''), tagOf(where), /\bEPC/i.test(f.contractorRole || f.contractorLabel || '') ? 'EPC' : 'Infrastructure'].filter(Boolean))].slice(0, 5);
  return [head, hook, ['Key facts', ...facts].join('\n'), ['Why it matters', ...why].join('\n'),
    `Source: ${src}${reported ? ', ' + reported : ''}. Tracker counts: World Trade Pro project tracker.`, tags.map((t) => '#' + t).join(' ')];
}
