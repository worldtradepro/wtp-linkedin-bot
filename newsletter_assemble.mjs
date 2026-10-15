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
// 2026-10-15: DESIGN.md direction C (editorial): white page, black ink, hairline rules, Newsreader for headlines and numbers,
// IBM Plex Sans for UI, Plex Mono for dates; square black buttons; no gold, pills, shadows, rounded boxes or all-caps labels.
// The old keys stay (newsletter_weekly.mjs uses them) but point at the DESIGN.md tokens: navy = ink, accent = link navy.
export const C = { ink: '#000000', text: '#1A1A1A', muted: '#555555', faint: '#555555', line: '#CCCCCC', soft: '#F5F5F3', bg: '#FFFFFF', card: '#FFFFFF', accent: '#0F2D5E', accent2: '#999999', navy: '#000000', gold: '#000000', sand: '#F5F5F3',
  link: '#0F2D5E', up: '#2E6B4F', down: '#B4412E', tender: '#B26B00', awarded: '#2E6B4F', planned: '#999999' };
// web fonts load where the client allows (Apple Mail, iOS); Gmail falls back to Helvetica/Arial + Georgia; Outlook gets the
// mso <style> in document() (it would otherwise drop to Times New Roman on an unknown first font). Serif elements carry class="s".
export const font = "font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;";
export const serif = "font-family:Newsreader,Georgia,'Times New Roman',serif;font-weight:400;";
export const mono = "font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;";
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const row = (inner, pad = '0') => `<tr><td style="padding:${pad};${font}">${inner}</td></tr>`;
// the one ornament: a 28x2px black rule above a 13px sentence-case kicker (a table cell, so Outlook draws it too)
export const rule28 = `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="28" height="2" style="background:#000000;font-size:0;line-height:2px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;
export const kicker = (t) => `${rule28}<div style="${font}font-size:13px;font-weight:600;color:${C.ink};padding-top:8px;">${t}</div>`;
// section opening: kicker, then (optional) a Newsreader line that states the point, then a muted dek
export const h2 = (t, sub) => section(t, '', sub);
export const section = (t, title, sub) => row(`${kicker(t)}${title ? `<div class="s" style="${serif}font-size:21px;line-height:1.25;color:${C.ink};padding-top:8px;">${title}</div>` : ''}${sub ? `<div style="font-size:13px;line-height:1.5;color:${C.muted};padding-top:4px;">${sub}</div>` : ''}`, '40px 0 12px');
export const para = (html, pad = '0 0 8px') => row(`<div style="font-size:15px;line-height:1.55;color:${C.text};">${html}</div>`, pad);
// text action: underlined; black by default (navy only for links inside running text)
export const link = (label, href, color = C.ink) => `<a href="${esc(href)}" style="color:${color};font-weight:600;text-decoration:underline;">${label}</a>`;
// square button; the table floats left so a second button wraps under the first on phones instead of widening the page
export const btn = (label, href, primary = true) => `<table role="presentation" align="left" cellpadding="0" cellspacing="0" style="margin:0 8px 8px 0;"><tr><td style="background:${primary ? '#000000' : '#FFFFFF'};border:1px solid #000000;"><a href="${esc(href)}" style="display:inline-block;padding:13px 20px;${font}font-size:15px;line-height:18px;font-weight:600;color:${primary ? '#FFFFFF' : '#000000'};text-decoration:none;">${label}</a></td></tr></table>`;
export const button = (label, href) => row(btn(label, href), '16px 0 4px');
// quiet panel: soft fill with a 2px black top rule, square
export const box = (html) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border-top:2px solid #000000;"><tr><td style="padding:16px 18px;${font}font-size:15px;line-height:1.55;color:${C.text};">${html}</td></tr></table>`, '24px 0 0');
// no pills: an attribute is written as text (DESIGN.md section 4 "Tags/chips")
export const pill = (label, color = C.muted, strong = false) => `<span style="font-size:13px;font-weight:600;color:${strong ? C.ink : color};">${esc(label)}</span>`;
export const sectorPill = (k) => pill(SECTORS[k] || k, C.muted);
export const badge = (label, color = C.text) => `<span style="font-size:13px;font-weight:600;color:${color};white-space:nowrap;">${label}</span>`;
// a stage written as a word with a small square marker (tender / awarded / planned colours from DESIGN.md section 2)
export const stageMark = (label) => { const c = { Tender: C.tender, Awarded: C.awarded }[label] || C.planned; return `<span style="white-space:nowrap;"><span style="color:${c};font-size:11px;">■</span>&nbsp;${esc(label)}</span>`; };   // a text glyph: Outlook ignores sized inline-blocks
// change as text: ▲ +36 (green) / ▼ -66 (red) / 0 (muted); invert = true where a rise is bad news (lane pressure)
export const chg = (d, invert = false, suffix = '') => (d === undefined || d === null ? '' : d === 0 ? `<span style="color:${C.muted};">0${suffix}</span>`
  : `<span style="color:${(d > 0) !== invert ? C.up : C.down};white-space:nowrap;">${d > 0 ? '▲ +' : '▼ -'}${Math.abs(d)}${suffix}</span>`);
// links inside model/editor HTML get the inline-link style (navy, underlined)
export const styleLinks = (html) => String(html || '').replace(/<a (?![^>]*style=)/g, `<a style="color:${C.link};text-decoration:underline;" `);

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
function assembleTeaser(b) {
  const reader = readerOf({});   // same issue for everyone
  const mine = new Set(reader.sectors);
  const st = b.stats || {}, dl = st.deltas || {}, D = b.dash || {};
  const out = [];
  const hair = `border-top:1px solid ${C.line};`;
  // masthead (DESIGN.md: logo, kicker, Newsreader headline, dek, date in Plex Mono), then the key numbers row:
  // label ABOVE the figure, Newsreader 40px (30px on phones), 1px hair between, 1px black rule above and below
  const num = (n, label, d, first) => `<td class="kc" width="25%" valign="top" style="padding:12px 0 12px ${first ? '0' : '12px'};${first ? '' : `border-left:1px solid ${C.line};`}${font}"><div style="font-size:13px;line-height:1.3;color:${C.muted};">${label}</div><div class="s kn" style="${serif}font-size:40px;line-height:1.1;color:${C.ink};white-space:nowrap;padding-top:4px;">${n}</div><div style="font-size:13px;line-height:1.3;padding-top:2px;">${chg(d)}</div></td>`;
  out.push(`<tr><td style="padding:0;${font}">
    <a href="${esc(b.links.home || 'https://worldtradepro.com/')}" style="text-decoration:none;"><img src="${esc(b.links.logo || 'https://worldtradepro.com/wp-content/themes/basic-child/img/brand/wtp-logo-horizontal-color-240.png')}" width="165" height="24" alt="World Trade Pro" style="display:block;border:0;width:165px;height:24px;"></a>
    <div style="padding-top:32px;">${kicker(esc(b.head.kicker))}</div>
    <div class="s kh" style="${serif}font-size:40px;line-height:1.1;letter-spacing:-0.5px;color:${C.ink};padding-top:8px;">${esc(b.head.title)}</div>
    <div style="font-size:15px;line-height:1.5;color:${C.muted};padding-top:16px;">${esc(String(b.head.sub).replace(/^[^·]*·\s*/, ''))}</div>
    <div style="${mono}font-size:13px;color:${C.muted};padding-top:8px;">${esc(String(b.head.sub).split(' · ')[0])}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #000000;border-bottom:1px solid #000000;"><tr>${num(st.epc ?? 0, 'New projects', dl.epc, true)}${num(st.tenders ?? 0, 'Tenders', dl.tenders)}${num(st.awards ?? 0, 'Awards', dl.awards)}${num(st.flow ?? 0, 'Flow signals', dl.flow)}</tr></table>
    <div style="font-size:12px;color:${C.muted};padding-top:6px;">Change vs the week before</div>
  </td></tr>`);
  if (b.sponsor?.html) out.push(row(b.sponsor.html, '16px 0 0'));
  if (b.editor) out.push(b.editor);
  // the two main buttons right after the judgement: this is what the e-mail is for
  const buttons = (pad) => row(`${btn('Read the full issue →', b.links.issue)}${b.links.pdf ? btn('Download the PDF report', b.links.pdf, false) : ''}`, pad);
  out.push(buttons('24px 0 0'));

  // dashboard 1: by sector, then region and stage as two hairline lists
  if (b.chart) {
    out.push(section('New projects by sector', b.chartTitle ? esc(b.chartTitle) : ''));
    out.push(b.chart);
    const reg = (D.regions || []).filter((r) => r.name !== 'Unknown').slice(0, 4), stg = (D.stages || []).filter((r) => r.n);
    const list = (title, rows) => `<div style="font-size:13px;font-weight:600;color:${C.ink};padding-bottom:6px;border-bottom:2px solid #000000;">${title}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([l, n], i) => `<tr><td style="${font}font-size:15px;color:${C.text};padding:6px 0;${i ? hair : ''}">${l}</td><td align="right" style="${font}font-size:15px;color:${C.ink};padding:6px 0;${i ? hair : ''}font-variant-numeric:tabular-nums;">${n}</td></tr>`).join('')}</table>`;
    if (reg.length || stg.length) out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="col" width="50%" valign="top" style="padding:24px 12px 0 0;${font}">${list('By region', reg.map((r) => [esc(r.name), r.n]))}</td>
      <td class="col" width="50%" valign="top" style="padding:24px 0 0 12px;${font}">${list('By stage', stg.map((r) => [stageMark(r.label), r.n]))}</td>
    </tr></table>`));
  }
  // dashboard 2: the largest contracts, as the signature table (2px black header rule, hairline rows)
  const top = [...(D.topDeals || [])].sort((x, y) => ((mine.size && !mine.has(sectorKey(x.sector))) ? 1 : 0) - ((mine.size && !mine.has(sectorKey(y.sector))) ? 1 : 0)).slice(0, 5);
  if (top.length) {
    out.push(section('Largest contracts of the week', money(D.totalUsd) ? `${money(D.totalUsd)} of named contract value in total` : '', 'Awards are reference prices and show who is now buying; tenders are open windows.'));
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 2).replace(/\s+\S*$/, '') + '…' : s);
    out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td colspan="2" style="${font}font-size:13px;font-weight:600;color:${C.ink};padding:0 0 6px;border-bottom:2px solid #000000;">Contract</td><td align="right" style="${font}font-size:13px;font-weight:600;color:${C.ink};padding:0 0 6px;border-bottom:2px solid #000000;">Value</td></tr>
      ${top.map((d, i) => `<tr><td valign="top" width="22" style="${mono}font-size:13px;color:${C.muted};padding:10px 0;${i ? hair : ''}">${i + 1}</td><td valign="top" style="${font}padding:10px 0;${i ? hair : ''}"><a href="${esc(d.url)}" class="s" style="${serif}color:${C.ink};text-decoration:none;font-size:17px;line-height:1.3;">${esc(cut(d.name, 64))}</a><div style="font-size:13px;line-height:1.45;color:${C.muted};padding-top:4px;">${esc(d.sector)} · ${esc(d.country)}${d.who ? ` · ${d.tender ? 'buyer' : 'won by'} ${esc(cut(d.who, 40))}` : ''}</div></td><td valign="top" align="right" style="${font}padding:10px 0 10px 12px;${i ? hair : ''}white-space:nowrap;"><div class="s" style="${serif}font-size:21px;line-height:1.1;color:${C.ink};">${esc(d.value)}</div><div style="font-size:13px;color:${C.text};padding-top:4px;">${stageMark(d.tender ? 'Tender' : 'Awarded')}</div></td></tr>`).join('')}</table>`));
    out.push(para(`<span style="font-size:15px;">${link('All ten, plus every new project by sector →', b.links.issue)}${b.calendarCount ? `<br>${link(`${b.calendarCount} bid deadline${b.calendarCount === 1 ? '' : 's'} in the next 14 days →`, b.links.issue + '#deadlines')}` : ''}</span>`, '12px 0 0'));
  }
  // dashboard 3: lane pressure (traders / charterers) - compact; a rise in pressure is bad news, so ▲ is red here
  const lanes = (D.lanes || []).filter((l) => l.n).slice(0, 4);
  if (lanes.length) {
    out.push(section('Trade flows', `${st.flow ?? 0} signals this week, ${st.critical ?? 0} of them critical`, 'Lane pressure from this week\'s signals, against the week before.'));
    out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="${font}font-size:13px;font-weight:600;color:${C.ink};padding:0 0 6px;border-bottom:2px solid #000000;">Lane</td><td align="right" style="${font}font-size:13px;font-weight:600;color:${C.ink};padding:0 0 6px;border-bottom:2px solid #000000;">Pressure</td></tr>
      ${lanes.map((l, i) => `<tr><td style="${font}font-size:15px;color:${C.text};padding:8px 0;${i ? hair : ''}"><a href="${esc(l.url)}" style="color:${C.ink};text-decoration:none;font-weight:600;">${esc(l.name)}</a><br><span style="color:${C.muted};font-size:13px;">${l.n} signal${l.n === 1 ? '' : 's'}</span></td><td align="right" valign="top" style="${font}font-size:15px;padding:8px 0;${i ? hair : ''}white-space:nowrap;color:${l.status === 'High' ? C.down : C.text};">${esc(l.status)}<br><span style="font-size:13px;">${l.p > l.pp ? `<span style="color:${C.down};">▲ rising</span>` : l.p < l.pp ? `<span style="color:${C.up};">▼ easing</span>` : `<span style="color:${C.muted};">unchanged</span>`}</span></td></tr>`).join('')}</table>`));
    out.push(para(`<span style="font-size:15px;">${link('What moved and what it means →', b.links.issue + '#flows')}</span>`, '12px 0 0'));
  }
  // close: the same two buttons + tail + footer
  out.push(buttons('32px 0 0'));
  for (const t of b.tail) out.push(t);
  if (b.footer) out.push(footerRow(b));
  return out.join('\n');
}
const sectorKey = (label) => Object.keys(SECTORS).find((k) => SECTORS[k] === label) || '';
const footerRow = (b) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #000000;"><tr>
    <td style="padding:16px 0 0;${font}font-size:13px;line-height:1.9;color:${C.text};"><a href="${esc(b.footer.forward)}" style="color:${C.ink};font-weight:600;text-decoration:underline;">Forward to a colleague</a> &nbsp;·&nbsp; <a href="${esc(b.footer.archive)}" style="color:${C.ink};font-weight:600;text-decoration:underline;">Past issues</a><br><a href="${esc(b.footer.add)}" style="color:${C.ink};font-weight:600;text-decoration:underline;">Sell to these projects? Free Project Leads preview</a></td>
  </tr></table>`, '32px 0 0');

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
  const tile = (n, label, color, d) => `<td width="25%" valign="top" style="padding:12px 8px 12px 0;${font}"><div style="font-size:13px;color:${C.muted};">${label}</div><div class="s" style="${serif}font-size:40px;color:${C.ink};line-height:1.1;white-space:nowrap;">${n}</div><div style="font-size:13px;">${chg(d)}</div></td>`;
  const sectorsLine = `<span style="font-size:12px;color:${C.muted};">Your sectors:</span> ${reader.sectors.length ? reader.sectors.map((k) => pill(SECTORS[k], C.navy, true)).join(' ') : pill('All sectors', C.navy, true)} <a href="${esc(b.links.manage)}" style="color:${C.accent};font-size:12px;font-weight:700;text-decoration:none;">&nbsp;change ›</a>`;
  const rl = roleLine(reader.role);
  out.push(`<tr><td style="padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" ><tr><td style="padding:0 0 16px;${font}">
      ${kicker(esc(b.head.kicker))}
      <div class="s" style="${serif}font-size:40px;color:${C.ink};padding-top:8px;line-height:1.1;letter-spacing:-0.5px;">${esc(titleFor(reader.role, b.head.title))}</div>
      <div style="font-size:15px;color:${C.muted};padding-top:16px;line-height:1.5;">${esc(b.head.sub)}</div>
      ${b.promise ? `<div style="font-size:12px;font-size:13px;color:${C.muted};font-weight:600;padding-top:12px;">${esc(b.promise)}</div>` : ''}
      ${rl ? `<div style="font-size:15px;color:${C.text};padding-top:12px;line-height:1.5;border-top:1px solid ${C.line};margin-top:12px;">${esc(rl)}</div>` : ''}
    </td></tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 0 0;${font}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #000000;border-bottom:1px solid #000000;"><tr>${tile(st.epc ?? 0, 'new projects', C.navy, dl.epc)}${tile(st.tenders ?? 0, 'tenders', C.accent, dl.tenders)}${tile(st.awards ?? 0, 'awards', C.navy, dl.awards)}${tile(st.flow ?? 0, 'flow signals', C.accent2, dl.flow)}</tr></table>
      <div style="padding:12px 0 4px;border-bottom:1px solid ${C.line};">${sectorsLine}</div>
      ${b.openThese ? `<div style="font-size:13.5px;color:${C.text};padding:10px 0 0;line-height:1.6;"><b style="color:${C.ink};">Open these three:</b> ${b.openThese}</div>` : ''}
    </td></tr></table>
  </td></tr>`);
  if (b.sponsor?.html) out.push(row(b.sponsor.html, '12px 0 0'));
  if (b.editor) out.push(b.editor);

  const sectionHead = (t, sub) => section(t, '', sub);
  const callsSec = () => {
    const picked = [...b.calls].sort((x, y) => (rank(x.key) + (x.strong ? 0 : 1)) - (rank(y.key) + (y.strong ? 0 : 1))).slice(0, callsN);
    if (!picked.length) return;
    out.push(sectionHead('Deals of the week', buyer ? 'Awards = reference prices and who is now booked. Tenders = what your peers are buying.' : 'Tenders and awards with a counterparty, a value or a deadline.'));
    picked.forEach((c, i) => out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" id="d${i + 1}" style="border-top:1px solid ${C.line};"><tr><td style="padding:12px 0 14px;${font}">
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
      out.push(row(`<div style="border-bottom:2px solid ${C.navy};padding-bottom:4px;font-size:13px;font-weight:600;color:${C.ink};">${esc(SECTORS[g.key])} <span style="color:${C.muted};font-weight:400;">· ${g.count}</span></div>`, '14px 0 2px'));
      g.rows.slice(0, perSector).forEach((h) => out.push(h));
      if (g.count > perSector) out.push(para(`<span style="font-size:13px;">${link(`All ${g.count} ${esc(SECTORS[g.key].toLowerCase())} projects ›`, g.moreUrl, colorOf(g.key))}</span>`, '6px 0 0'));
    }
    if (folded.length) out.push(row(`<div style="font-size:13px;font-weight:600;color:${C.ink};padding-bottom:6px;">Also this week</div>${folded.map((g) => `<a href="${esc(g.moreUrl)}" style="text-decoration:none;display:inline-block;margin:0 6px 6px 0;">${pill(`${SECTORS[g.key]} · ${g.count}`, C.navy)}</a>`).join('')}`, '16px 0 0'));
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
    <td width="50%" valign="top" style="padding:14px 8px 0 0;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.footer.forward)}" style="color:${C.navy};font-weight:600;text-decoration:underline;">Forward to a colleague →</a><br><a href="${esc(b.footer.add)}" style="color:${C.navy};font-weight:600;text-decoration:underline;">Sell to these projects? Free Project Leads preview →</a></td>
    <td width="50%" valign="top" style="padding:14px 0 0 8px;${font}font-size:13px;line-height:1.7;color:${C.text};"><a href="${esc(b.footer.archive)}" style="color:${C.navy};font-weight:600;text-decoration:underline;">Past issues →</a></td>
  </tr></table>`, '20px 0 0'));
  return out.join('\n');
}

// Full document around the assembled body. preview = hidden preheader text.
export function document(b, bodyHtml) {
  const pre = esc(b.preview) + '&#8199;&#65279;&#847;'.repeat(40);
  // head: web fonts for clients that load them (not Outlook), phone sizes for clients that read <style>, and Outlook's
  // fallbacks (Arial for UI, Georgia for class="s"). The body works without any of it: everything is inline.
  return `<!doctype html><html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(b.head.kicker)}</title>
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&family=Newsreader:opsz,wght@6..72,400&display=swap" rel="stylesheet"><!--<![endif]-->
<style>a:focus{outline:2px solid #000;outline-offset:2px}@media (max-width:480px){.kh{font-size:30px!important}.kn{font-size:30px!important}.kc{padding-left:8px!important}.col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}}</style>
<!--[if mso]><style>body,table,td,div,a,span{font-family:Arial,Helvetica,sans-serif!important}.s{font-family:Georgia,'Times New Roman',serif!important}</style><![endif]--></head>
<body style="margin:0;padding:0;background:#FFFFFF;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:24px 16px 32px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;"><tr><td style="padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${bodyHtml}
</table>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}
