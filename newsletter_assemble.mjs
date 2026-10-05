// World Trade Pro Weekly: one issue, assembled per reader.
//   newsletter.mjs builds the week's content once as tagged BLOCKS (newsletter/out/<date>-weekly.blocks.json);
//   ses_send.mjs calls assemble(blocks, reader) for every subscriber, so a reader who follows metals gets the metals
//   items first and expanded, and the other sectors folded into one line. No sectors chosen = the full issue.
//   Also used by newsletter.mjs itself for the default (no-preference) HTML and the preview files.
// Sector keys and labels mirror wtp_nl_sectors() in the site's newsletter snippet (64) - keep the two in step.

export const SECTORS = {
  energy: 'Oil, gas & LNG', power: 'Power & renewables', metals: 'Metals & mining', agri: 'Agriculture & food',
  chem: 'Chemicals & fertilizers', infra: 'Infrastructure & construction', shipping: 'Shipping, ports & logistics',
  equipment: 'Industrial equipment', recycling: 'Scrap & recycled materials',
};
export const SECTOR_ORDER = Object.keys(SECTORS);
// one colour per sector, used everywhere the sector appears (pill, card edge, folded line) so a reader learns it fast
// Report discipline (MGI / BP): one dark, one accent, greys. Sectors are told apart by their LABEL, not by nine colours.
export const SECTOR_COLOR = {};
export const colorOf = () => '#1F6FEB';

// Which of the 9 reader sectors a pipeline item belongs to. The radar's own labels are broader (Energy / Logistics &
// Infrastructure / ...), so the subsector and the title decide. Order matters: fertilizer before agri, rail before infra.
export function sectorKeyOf(it) {
  const t = `${it.subsector || ''} | ${it.sector || ''} | ${it.project_name || ''}`.toLowerCase();
  if (/scrap|recycl|secondary (alumin|copper|steel)/.test(t)) return 'recycling';
  // hydrocarbons first: an LNG terminal is energy even though it is a port; a refinery is energy even though it is petrochemical
  if (/\blng\b|\bnlng\b|lng train|refiner|refining|oil & gas|oil and gas|\bfpso\b|upstream|gas processing|gas field|oilfield|\bcrude\b|tanker|gas pipeline|pipelines? & storage/.test(t)) return 'energy';
  if (/fertili[sz]er|\burea\b|potash|phosphate|\bchemical|petrochemical plant|methanol|polymer|plastics?\b/.test(t)) return 'chem';
  if (/\bmine\b|mining|smelt|\bore\b|lithium|copper|nickel|cobalt|iron ore|\bsteel\b|alumin|bauxite|\bgold\b|rare earth|graphite|zinc|manganese/.test(t)) return 'metals';
  if (/grain|wheat|corn|soy|sugar|coffee|cocoa|palm oil|rice\b|irrigation|\bfood\b|agri|livestock|dairy|fisher/.test(t)) return 'agri';
  if (/shipyard|fleet|vessel|newbuild|\bships?\b|\bport\b|ports|terminal|harbou?r|dredg|\brail|metro|logistics (hub|park|cent)|freight|container|bulker|canal|strait|shipping|warehouse/.test(t)) return 'shipping';
  if (/\bpower\b|transmission|\bgrid\b|substation|renewable|solar|\bwind\b|nuclear|hydro(?!gen|carbon)|geothermal|battery|energy storage|interconnector/.test(t)) return 'power';
  if (/\boil\b|\bgas\b|\blng\b|refin|pipeline|upstream|offshore|drill|fpso|hydrogen|ammonia|petroleum|fuel|coal/.test(t)) return 'energy';
  if (/construction|water|desalin|infrastructure|industrial (park|zone)|cement|building/.test(t)) return 'infra';
  const s = (it.sector || '').toLowerCase();
  if (s.startsWith('energy')) return 'energy';
  if (s.startsWith('mining') || s.startsWith('metals')) return 'metals';
  if (s.startsWith('agri')) return 'agri';
  if (s.startsWith('chem')) return 'chem';
  if (s.startsWith('shipping')) return 'shipping';
  return 'infra';   // incl. the radar's "Logistics & Infrastructure" items that named no mode of transport
}

// ---------------------------------------------------------------- html helpers (inline styles: e-mail clients)
export const C = { ink: '#111827', text: '#374151', muted: '#6B7280', faint: '#9CA3AF', line: '#E5E7EB', soft: '#F3F4F6', bg: '#f5f6f8', card: '#ffffff', accent: '#1F6FEB', accent2: '#9DB4D6', navy: '#0B2545', gold: '#c8a94a', sand: '#f4efe4' };
export const font = 'font-family:Segoe UI,Helvetica,Arial,sans-serif;';
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const row = (inner, pad = '0') => `<tr><td style="padding:${pad};${font}">${inner}</td></tr>`;
export const h2 = (t, sub) => row(`<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};">${t}</div>${sub ? `<div style="font-size:13px;color:${C.muted};padding-top:2px;">${sub}</div>` : ''}`, '26px 0 8px');
export const para = (html, pad = '0 0 8px') => row(`<div style="font-size:15px;line-height:1.55;color:${C.text};">${html}</div>`, pad);
export const link = (label, href, color = C.accent) => `<a href="${esc(href)}" style="color:${color};font-weight:700;text-decoration:none;">${label}</a>`;
export const button = (label, href) => row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};border-radius:6px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;${font}font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${label}</a></td></tr></table>`, '14px 0 4px');
export const box = (html, bg, border) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};${border ? `border:1px solid ${border};` : ''}border-radius:8px;"><tr><td style="padding:14px 18px;${font}font-size:14px;line-height:1.55;">${html}</td></tr></table>`, '18px 0 0');
export const pill = (label, color = C.navy, filled = false) => `<span style="display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${filled ? '#ffffff' : color};background:${filled ? color : 'transparent'};border:1px solid ${color};border-radius:3px;padding:1px 7px;">${esc(label)}</span>`;
export const sectorPill = (k) => pill(SECTORS[k] || k, C.muted);
export const badge = (label, color) => `<span style="display:inline-block;font-size:12px;font-weight:700;color:${color};white-space:nowrap;">${label}</span>`;

// ---------------------------------------------------------------- the reader
// reader = { sectors: 'metals,energy' | ['metals'], role: 'epc' | ... } (both optional, as the subscriber export returns them)
export function readerOf(r = {}) {
  const raw = Array.isArray(r.sectors) ? r.sectors : String(r.sectors || '').split(',');
  const sectors = SECTOR_ORDER.filter((k) => raw.map((x) => String(x).trim().toLowerCase()).includes(k));
  return { sectors, role: String(r.role || '').toLowerCase() };
}
export const BUYER = ['procurement', 'owner'], SUPPLIER = ['equipment', 'service', 'epc'], FLOWFIRST = ['trader', 'shipping'];
// EPC contractors bid for work AND buy equipment: they read like a supplier (who is buying) - the buyer line is for owners / procurement.
export const isBuyer = (role) => BUYER.includes(role);
// One masthead for everyone - each reader finds their word in it: suppliers "who's buying", owners and procurement
// "who won" (reference prices, who is booked), traders and charterers "what moved". The role line underneath does the rest.
export function titleFor(role, base) { return base || "Who's buying, who won, what moved"; }
// One sentence under the masthead that tells this reader why the issue is arranged the way it is.
export function roleLine(role) {
  if (isBuyer(role)) return 'For buyers: what comparable work just cost, who is now booked, what moved your landed cost.';
  if (SUPPLIER.includes(role)) return 'For suppliers and contractors: who is buying, who just won, where the open tenders are.';
  if (FLOWFIRST.includes(role)) return 'For traders and charterers: what moved on the water, and the projects that will move it next.';
  if (role === 'finance') return 'For finance: new projects and awards are next year\'s financing, insurance and hedging demand.';
  return '';
}

// ---------------------------------------------------------------- assemble
// blocks (from newsletter.mjs):
//   head { kicker, title, sub, issue, week, from, to }        sponsor { html } | null
//   calls    [ { key, sector, html } ]      ranked deals worth a call; key = sector key
//   projects [ { key, count, rows:[html], moreUrl } ]         new projects grouped by sector key
//   flows    { lanes: html, items:[ { key, html } ] }          lane board + the signals that changed
//   moves    html | ''                                         stage moves (short)
//   tail     [ html ]                                          sourcing box, sponsor line, promo
//   links    { projects, map, manage }                         utm'd site links (manage gets ?t= appended by the sender)
export function assemble(b, readerLike = {}, opts = {}) {
  if (!opts.full) return assembleTeaser(b, readerLike, opts);
  return assembleFull(b, readerLike, opts);
}

// ---------------------------------------------------------------- teaser (the e-mail since 2026-10-06)
const money = (usd) => (!usd ? '' : usd >= 1e9 ? `US$${(usd / 1e9).toFixed(1)}bn` : `US$${Math.round(usd / 1e6)}m`);
function assembleTeaser(b, readerLike = {}) {
  const reader = readerOf(readerLike);
  const mine = new Set(reader.sectors);
  const st = b.stats || {}, dl = st.deltas || {}, D = b.dash || {};
  const out = [];
  const delta = (d) => (d === undefined || d === null ? '' : d > 0 ? `<span style="color:#15803d;">▲ ${d}</span>` : d < 0 ? `<span style="color:#b42318;">▼ ${-d}</span>` : `<span style="color:${C.muted};">=</span>`);
  const tile = (n, label, color, d) => `<td width="25%" style="padding:0 3px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border-top:3px solid ${color};"><tr><td style="padding:10px 6px 8px;text-align:center;${font}"><div style="font-size:26px;font-weight:800;color:${C.navy};line-height:1.1;">${n}</div><div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.muted};padding-top:2px;">${label}</div><div style="font-size:11.5px;font-weight:700;padding-top:3px;">${delta(d)}</div></td></tr></table></td>`;
  const sectorsLine = `<span style="font-size:12px;color:${C.muted};">Your sectors:</span> ${reader.sectors.length ? reader.sectors.map((k) => pill(SECTORS[k], C.navy, true)).join(' ') : pill('All sectors', C.navy, true)} <a href="${esc(b.links.manage)}" style="color:${C.accent};font-size:12px;font-weight:700;text-decoration:none;">&nbsp;change ›</a>`;
  const rl = roleLine(reader.role);
  // masthead
  out.push(`<tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};border-radius:10px 10px 0 0;"><tr><td style="padding:26px 24px 22px;${font}">
      <div style="font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:${C.gold};font-weight:700;">${esc(b.head.kicker)}</div>
      <div style="font-size:30px;font-weight:800;color:#ffffff;padding-top:8px;line-height:1.12;letter-spacing:-.01em;">${esc(b.head.title)}</div>
      <div style="font-size:13.5px;color:rgba(255,255,255,.72);padding-top:10px;line-height:1.5;">${esc(b.head.sub)}</div>
      ${rl ? `<div style="font-size:13.5px;color:#ffffff;padding-top:10px;line-height:1.5;border-top:1px solid rgba(255,255,255,.18);margin-top:12px;"><span style="color:${C.gold};font-weight:700;">▸</span> ${esc(rl)}</div>` : ''}
    </td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0 0;${font}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -3px;"><tr>${tile(st.epc ?? 0, 'new projects', C.navy, dl.epc)}${tile(st.tenders ?? 0, 'tenders', C.accent, dl.tenders)}${tile(st.awards ?? 0, 'awards', C.navy, dl.awards)}${tile(st.flow ?? 0, 'flow signals', C.accent2, dl.flow)}</tr></table>
      <div style="padding:12px 0 4px;border-bottom:1px solid ${C.line};">${sectorsLine}</div>
    </td></tr></table>
  </td></tr>`);
  if (b.sponsor?.html) out.push(row(b.sponsor.html, '12px 0 0'));
  if (b.editor) out.push(b.editor);
  // the two main buttons right after the judgement: this is what the e-mail is for
  const btn = (label, href, bg, fg = '#ffffff') => `<td style="padding:0 4px 8px 0;"><a href="${esc(href)}" style="display:inline-block;padding:12px 18px;${font}font-size:14px;font-weight:700;color:${fg};background:${bg};border:1px solid ${bg === '#ffffff' ? C.navy : bg};border-radius:6px;text-decoration:none;white-space:nowrap;">${label}</a></td>`;
  out.push(row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr>${btn('Read the full issue →', b.links.issue, C.navy)}${b.links.pdf ? btn('Download the PDF report', b.links.pdf, '#ffffff', C.navy) : ''}</tr></table>`, '16px 0 0'));

  const head = (t, sub) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};padding:8px 14px;${font}font-size:12.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;">${t}</td></tr></table>${sub ? `<div style="font-size:12.5px;color:${C.muted};padding:6px 2px 0;">${sub}</div>` : ''}`, '26px 0 6px');
  // dashboard 1: by sector (the reader's own sectors in bold navy), with the web anchor on each row
  if (b.chart) {
    out.push(head('New projects by sector', b.chartTitle ? esc(b.chartTitle) : ''));
    out.push(b.chart);
    const reg = (D.regions || []).filter((r) => r.name !== 'Unknown').slice(0, 4), stg = (D.stages || []).filter((r) => r.n);
    if (reg.length || stg.length) out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" valign="top" style="padding:6px 8px 0 0;${font}font-size:13px;color:${C.text};"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};padding-bottom:4px;">By region</div>${reg.map((r) => `<div style="padding:2px 0;border-top:1px solid ${C.line};">${esc(r.name)} <b style="float:right;color:${C.ink};">${r.n}</b></div>`).join('')}</td>
      <td width="50%" valign="top" style="padding:6px 0 0 8px;${font}font-size:13px;color:${C.text};"><div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};padding-bottom:4px;">By stage</div>${stg.map((r) => `<div style="padding:2px 0;border-top:1px solid ${C.line};">${esc(r.label)} <b style="float:right;color:${C.ink};">${r.n}</b></div>`).join('')}</td>
    </tr></table>`, '10px 0 0'));
  }
  // dashboard 2: the largest contracts as one-liners, the reader's sectors first
  const top = [...(D.topDeals || [])].sort((x, y) => ((mine.size && !mine.has(sectorKey(x.sector))) ? 1 : 0) - ((mine.size && !mine.has(sectorKey(y.sector))) ? 1 : 0)).slice(0, 5);
  if (top.length) {
    out.push(head('Largest contracts of the week', `${money(D.totalUsd) ? money(D.totalUsd) + ' of named contract value in total · ' : ''}awards = reference prices and who is now buying; tenders = open windows`));
    out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${top.map((d, i) => `<tr><td valign="top" width="18" style="${font}font-size:12px;color:${C.faint};font-weight:700;padding:7px 0;border-top:1px solid ${C.line};">${i + 1}</td><td valign="top" style="${font}padding:7px 0;border-top:1px solid ${C.line};"><a href="${esc(d.url)}" style="color:${C.ink};text-decoration:none;font-weight:600;font-size:14px;line-height:1.35;">${esc(d.name.length > 64 ? d.name.slice(0, 62).replace(/\s+\S*$/, '') + '…' : d.name)}</a><div style="font-size:12px;color:${C.muted};padding-top:2px;">${esc(d.sector)} · ${esc(d.country)}${d.who ? ` · ${d.tender ? 'buyer' : 'won by'} ${esc(d.who.length > 40 ? d.who.slice(0, 38).replace(/\s+\S*$/, '') + '…' : d.who)}` : ''}</div></td><td valign="top" align="right" style="${font}padding:7px 0 7px 10px;border-top:1px solid ${C.line};white-space:nowrap;"><div style="font-size:15px;font-weight:800;color:${C.navy};">${esc(d.value)}</div><div style="font-size:11px;font-weight:700;color:${d.tender ? C.accent : '#15803d'};">${d.tender ? 'TENDER' : 'AWARDED'}</div></td></tr>`).join('')}</table>`));
    out.push(para(`<span style="font-size:13px;">${link('All ten, plus every new project by sector ›', b.links.issue)}${b.calendarCount ? ` &nbsp;·&nbsp; ${link(`${b.calendarCount} bid deadline${b.calendarCount === 1 ? '' : 's'} in the next 14 days ›`, b.links.issue + '#deadlines')}` : ''}</span>`, '8px 0 0'));
  }
  // dashboard 3: lane pressure (traders / charterers) - compact
  const lanes = (D.lanes || []).filter((l) => l.n).slice(0, 4);
  if (lanes.length) {
    out.push(head('Trade flows', `${st.flow ?? 0} signals, ${st.critical ?? 0} critical · lane pressure from this week's signals`));
    out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lanes.map((l) => { const col = l.status === 'High' ? '#b42318' : l.status === 'Elevated' ? '#b45309' : C.muted; return `<tr><td style="${font}font-size:14px;color:${C.text};padding:6px 0;border-top:1px solid ${C.line};"><a href="${esc(l.url)}" style="color:${C.ink};text-decoration:none;font-weight:600;">${esc(l.name)}</a> <span style="color:${C.muted};font-size:12px;">· ${l.n} signal${l.n === 1 ? '' : 's'}</span></td><td style="${font}font-size:13px;padding:6px 0;border-top:1px solid ${C.line};text-align:right;white-space:nowrap;"><span style="color:${col};font-weight:700;">●</span> ${esc(l.status)} ${l.p > l.pp ? `<span style="color:#b42318;font-weight:700;">▲</span>` : l.p < l.pp ? `<span style="color:#027a48;font-weight:700;">▼</span>` : ''}</td></tr>`; }).join('')}</table>`));
    out.push(para(`<span style="font-size:13px;">${link('What moved and what it means ›', b.links.issue + '#flows')}</span>`, '8px 0 0'));
  }
  // close: the same two buttons + tail + footer
  out.push(row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr>${btn('Read the full issue →', b.links.issue, C.navy)}${b.links.pdf ? btn('Download the PDF report', b.links.pdf, '#ffffff', C.navy) : ''}</tr></table>`, '22px 0 0'));
  for (const t of b.tail) out.push(t);
  if (b.footer) out.push(footerRow(b));
  return out.join('\n');
}
const sectorKey = (label) => Object.keys(SECTORS).find((k) => SECTORS[k] === label) || '';
const footerRow = (b) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};"><tr>
    <td width="50%" valign="top" style="padding:14px 8px 0 0;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.footer.forward)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Forward to a colleague →</a><br><a href="${esc(b.footer.add)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Add your project or tender →</a></td>
    <td width="50%" valign="top" style="padding:14px 0 0 8px;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.links.manage)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Choose your sectors →</a><br><a href="${esc(b.footer.archive)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Past issues →</a></td>
  </tr></table>`, '20px 0 0');

// ---------------------------------------------------------------- full (the web page / previews)
function assembleFull(b, readerLike = {}, opts = {}) {
  const reader = readerOf(readerLike);
  const mine = new Set(reader.sectors);
  const follows = (k) => mine.size === 0 || mine.has(k);
  const rank = (k) => (mine.size === 0 ? 0 : mine.has(k) ? 0 : 1);
  const perSector = opts.perSector || 5, callsN = opts.calls || 3, flowsN = opts.flows || 3;

  const out = [];
  const buyer = isBuyer(reader.role);
  // masthead: kicker, role-specific title, four stat tiles, the reader's sectors
  const st = b.stats || {}, dl = st.deltas || {};
  const delta = (d) => (d === undefined || d === null ? '' : d > 0 ? `<span style="color:#15803d;">▲ ${d}</span>` : d < 0 ? `<span style="color:#b42318;">▼ ${-d}</span>` : `<span style="color:${C.muted};">= last week</span>`);
  const tile = (n, label, color, d) => `<td width="25%" style="padding:0 3px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border-top:3px solid ${color};"><tr><td style="padding:10px 6px 8px;text-align:center;${font}"><div style="font-size:26px;font-weight:800;color:${C.navy};line-height:1.1;">${n}</div><div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.muted};padding-top:2px;">${label}</div><div style="font-size:11.5px;font-weight:700;padding-top:3px;">${delta(d)}</div></td></tr></table></td>`;
  const sectorsLine = `<span style="font-size:12px;color:${C.muted};">Your sectors:</span> ${reader.sectors.length ? reader.sectors.map((k) => pill(SECTORS[k], C.navy, true)).join(' ') : pill('All sectors', C.navy, true)} <a href="${esc(b.links.manage)}" style="color:${C.accent};font-size:12px;font-weight:700;text-decoration:none;">&nbsp;change ›</a>`;
  const rl = roleLine(reader.role);
  out.push(`<tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};border-radius:10px 10px 0 0;"><tr><td style="padding:26px 24px 22px;${font}">
      <div style="font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:${C.gold};font-weight:700;">${esc(b.head.kicker)}</div>
      <div style="font-size:30px;font-weight:800;color:#ffffff;padding-top:8px;line-height:1.12;letter-spacing:-.01em;">${esc(titleFor(reader.role, b.head.title))}</div>
      <div style="font-size:13.5px;color:rgba(255,255,255,.72);padding-top:10px;line-height:1.5;">${esc(b.head.sub)}</div>
      ${b.promise ? `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.gold};font-weight:700;padding-top:12px;">${esc(b.promise)}</div>` : ''}
      ${rl ? `<div style="font-size:13.5px;color:#ffffff;padding-top:10px;line-height:1.5;border-top:1px solid rgba(255,255,255,.18);margin-top:12px;"><span style="color:${C.gold};font-weight:700;">▸</span> ${esc(rl)}</div>` : ''}
    </td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0 0;${font}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -3px;"><tr>${tile(st.epc ?? 0, 'new projects', C.navy, dl.epc)}${tile(st.tenders ?? 0, 'tenders', C.accent, dl.tenders)}${tile(st.awards ?? 0, 'awards', C.navy, dl.awards)}${tile(st.flow ?? 0, 'flow signals', C.accent2, dl.flow)}</tr></table>
      <div style="padding:12px 0 4px;border-bottom:1px solid ${C.line};">${sectorsLine}</div>
      ${b.openThese ? `<div style="font-size:13.5px;color:${C.text};padding:10px 0 0;line-height:1.6;"><b style="color:${C.navy};">Open these three:</b> ${b.openThese}</div>` : ''}
    </td></tr></table>
  </td></tr>`);
  if (b.sponsor?.html) out.push(row(b.sponsor.html, '12px 0 0'));
  if (b.editor) out.push(b.editor);

  const sectionHead = (t, sub) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};padding:9px 14px;${font}font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;">${t}</td></tr></table>${sub ? `<div style="font-size:12.5px;color:${C.muted};padding:6px 2px 0;">${sub}</div>` : ''}`, '30px 0 6px');
  const callsSec = () => {
    const picked = [...b.calls].sort((x, y) => (rank(x.key) + (x.strong ? 0 : 1)) - (rank(y.key) + (y.strong ? 0 : 1))).slice(0, callsN);
    if (!picked.length) return;
    out.push(sectionHead('Deals of the week', buyer ? 'Awards = reference prices and who is now booked. Tenders = what your peers are buying.' : 'Tenders and awards with a counterparty, a value or a deadline.'));
    picked.forEach((c, i) => out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" id="d${i + 1}" style="border-left:4px solid ${C.accent};background:${C.soft};"><tr><td style="padding:12px 16px 14px;${font}">
      <div><span style="font-size:11px;color:${C.faint};font-weight:700;">${i + 1} / ${picked.length}</span> &nbsp;${sectorPill(c.key)}</div>${c.html}${c.why ? '' : (buyer ? c.buyer || '' : c.call || '')}</td></tr></table>`, '8px 0 0')));
  };
  const projectsSec = () => {
    const groups = [...b.projects].sort((x, y) => rank(x.key) - rank(y.key) || y.count - x.count);
    if (!groups.length) return;
    const total = groups.reduce((n, g) => n + g.count, 0);
    out.push(sectionHead(`New projects this week <span style="color:${C.muted};font-weight:400;">· ${total}</span>`, mine.size ? 'Your sectors in full; the rest in one line below' : 'Largest first, by sector'));
    const folded = [];
    for (const g of groups) {
      if (!follows(g.key)) { folded.push(g); continue; }
      out.push(row(`<div style="border-bottom:2px solid ${C.navy};padding-bottom:4px;font-size:13px;font-weight:800;color:${C.navy};">${esc(SECTORS[g.key])} <span style="color:${C.muted};font-weight:400;">· ${g.count}</span></div>`, '14px 0 2px'));
      g.rows.slice(0, perSector).forEach((h) => out.push(h));
      if (g.count > perSector) out.push(para(`<span style="font-size:13px;">${link(`All ${g.count} ${esc(SECTORS[g.key].toLowerCase())} projects ›`, g.moreUrl, colorOf(g.key))}</span>`, '6px 0 0'));
    }
    if (folded.length) out.push(row(`<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.muted};padding-bottom:6px;">Also this week</div>${folded.map((g) => `<a href="${esc(g.moreUrl)}" style="text-decoration:none;display:inline-block;margin:0 6px 6px 0;">${pill(`${SECTORS[g.key]} · ${g.count}`, C.navy)}</a>`).join('')}`, '16px 0 0'));
  };
  const flowsSec = () => {
    if (!b.flows || (!b.flows.items.length && !b.flows.lanes)) return;
    out.push(sectionHead('Flows that moved', buyer ? 'Freight, routes and supply moves that change your landed cost' : 'Where cargo is moving differently this week, and what it means'));
    const items = [...b.flows.items].sort((x, y) => rank(x.key) - rank(y.key)).slice(0, flowsN);
    items.forEach((f) => out.push(f.html));
    if (b.flows.lanes) out.push(b.flows.lanes);
  };
  const overviewSec = () => {
    if (!b.chart && !b.callout) return;
    out.push(sectionHead('The week in one look'));
    if (b.chartTitle) out.push(row(`<div style="font-size:17px;font-weight:700;color:${C.ink};line-height:1.35;">${esc(b.chartTitle)}</div><div style="font-size:12.5px;color:${C.muted};padding-top:2px;">New projects by sector · tenders / awards / earlier stage · value where the notice names one</div>`, '8px 0 0'));
    if (b.chart) out.push(b.chart);
    if (b.callout) out.push(b.callout);
  };
  const calendarSec = () => {
    if (!b.calendar) return;
    out.push(sectionHead(buyer ? 'Bid deadlines your peers set' : 'Bid deadlines, next 14 days', 'Soonest first. Red = this week.'));
    out.push(b.calendar);
  };
  if (b.directory) out.push(b.directory);   // "new on the supplier directory" - only when the week had listings
  const order = FLOWFIRST.includes(reader.role) ? [overviewSec, flowsSec, callsSec, calendarSec, projectsSec] : [overviewSec, callsSec, calendarSec, projectsSec, flowsSec];
  order.forEach((f) => f());
  if (b.moves) out.push(b.moves);
  out.push(button('Browse every project, with filters →', b.links.projects));
  for (const t of b.tail) out.push(t);
  // footer four-piece (forward / add your project / sectors / past issues); "sectors" is this reader's own preferences link
  if (b.footer) out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};"><tr>
    <td width="50%" valign="top" style="padding:14px 8px 0 0;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.footer.forward)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Forward to a colleague →</a><br><a href="${esc(b.footer.add)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Add your project or tender →</a></td>
    <td width="50%" valign="top" style="padding:14px 0 0 8px;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.links.manage)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Choose your sectors →</a><br><a href="${esc(b.footer.archive)}" style="color:${C.navy};font-weight:700;text-decoration:none;">Past issues →</a></td>
  </tr></table>`, '20px 0 0'));
  return out.join('\n');
}

// Full document around the assembled body. preview = hidden preheader text.
export function document(b, bodyHtml) {
  const pre = esc(b.preview) + '&#8199;&#65279;&#847;'.repeat(40);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(b.head.kicker)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:${C.card};border-radius:10px;"><tr><td style="padding:0 18px 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${bodyHtml}
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;
}
