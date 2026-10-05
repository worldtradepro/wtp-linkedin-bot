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
export const C = { ink: '#101828', text: '#344054', muted: '#667085', line: '#eaecf0', bg: '#f5f6f8', card: '#ffffff', accent: '#0b4a6f', navy: '#0f2d5e', gold: '#c8a94a', sand: '#f4efe4' };
export const font = 'font-family:Segoe UI,Helvetica,Arial,sans-serif;';
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const row = (inner, pad = '0') => `<tr><td style="padding:${pad};${font}">${inner}</td></tr>`;
export const h2 = (t, sub) => row(`<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};">${t}</div>${sub ? `<div style="font-size:13px;color:${C.muted};padding-top:2px;">${sub}</div>` : ''}`, '26px 0 8px');
export const para = (html, pad = '0 0 8px') => row(`<div style="font-size:15px;line-height:1.55;color:${C.text};">${html}</div>`, pad);
export const link = (label, href, color = C.accent) => `<a href="${esc(href)}" style="color:${color};font-weight:700;text-decoration:none;">${label}</a>`;
export const button = (label, href) => row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};border-radius:6px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;${font}font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${label}</a></td></tr></table>`, '14px 0 4px');
export const box = (html, bg, border) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};${border ? `border:1px solid ${border};` : ''}border-radius:8px;"><tr><td style="padding:14px 18px;${font}font-size:14px;line-height:1.55;">${html}</td></tr></table>`, '18px 0 0');
export const pill = (label, color = C.accent) => `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${color};border:1px solid ${color};border-radius:100px;padding:1px 8px;">${esc(label)}</span>`;

// ---------------------------------------------------------------- the reader
// reader = { sectors: 'metals,energy' | ['metals'], role: 'epc' | ... } (both optional, as the subscriber export returns them)
export function readerOf(r = {}) {
  const raw = Array.isArray(r.sectors) ? r.sectors : String(r.sectors || '').split(',');
  const sectors = SECTOR_ORDER.filter((k) => raw.map((x) => String(x).trim().toLowerCase()).includes(k));
  return { sectors, role: String(r.role || '').toLowerCase() };
}
const BUYER = ['epc', 'procurement', 'owner'], SUPPLIER = ['equipment', 'service'], FLOWFIRST = ['trader', 'shipping'];
// One sentence under the masthead that tells this reader why the issue is arranged the way it is.
export function roleLine(role) {
  if (BUYER.includes(role)) return 'Buyer\'s view: the tenders and awards tell you who is buying, and when.';
  if (SUPPLIER.includes(role)) return 'Supplier\'s view: an awarded contract means the winner is now buying equipment and placing subcontracts. Those are your calls.';
  if (FLOWFIRST.includes(role)) return 'Trader\'s view: the flows that moved this week come first, then the projects that will move them next.';
  if (role === 'finance') return 'Finance view: new projects and awards are tomorrow\'s financing, insurance and hedging demand.';
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
  const reader = readerOf(readerLike);
  const mine = new Set(reader.sectors);
  const follows = (k) => mine.size === 0 || mine.has(k);
  const rank = (k) => (mine.size === 0 ? 0 : mine.has(k) ? 0 : 1);
  const perSector = opts.perSector || 5, callsN = opts.calls || 3, flowsN = opts.flows || 3;

  const out = [];
  // masthead
  const sectorsLine = reader.sectors.length ? `Your sectors: <b style="color:${C.ink};">${reader.sectors.map((k) => esc(SECTORS[k])).join(', ')}</b> · ${link('change', b.links.manage, C.muted).replace('font-weight:700;', 'font-weight:400;')}` : `All sectors · ${link('choose yours', b.links.manage, C.muted).replace('font-weight:700;', 'font-weight:400;')}`;
  const rl = roleLine(reader.role);
  out.push(`<tr><td style="${font}padding-bottom:8px;border-bottom:3px solid ${C.navy};">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700;">${esc(b.head.kicker)}</div>
    <div style="font-size:26px;font-weight:700;color:${C.ink};padding-top:6px;line-height:1.2;">${esc(b.head.title)}</div>
    <div style="font-size:13px;color:${C.muted};padding:6px 0 2px;">${esc(b.head.sub)}</div>
    <div style="font-size:13px;color:${C.muted};">${sectorsLine}</div>
    ${rl ? `<div style="font-size:14px;line-height:1.5;color:${C.text};padding-top:8px;">${esc(rl)}</div>` : ''}
  </td></tr>`);
  if (b.sponsor?.html) out.push(row(b.sponsor.html, '12px 0 0'));

  // the three sections, in the order this role reads them
  const callsSec = () => {
    // a reader's own sector comes first, but only a STRONG deal (value, or counterparty + deadline) may jump the queue
    const picked = [...b.calls].sort((x, y) => (rank(x.key) + (x.strong ? 0 : 1)) - (rank(y.key) + (y.strong ? 0 : 1))).slice(0, callsN);
    if (!picked.length) return;
    out.push(h2('Worth a call this week', 'Tenders and awards with a name, a value or a deadline. Ranked for your sectors.'));
    picked.forEach((c, i) => out.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-left:4px solid ${mine.has(c.key) ? C.gold : C.navy};border-radius:8px;"><tr><td style="padding:12px 16px;${font}">
      <div style="font-size:11px;color:${C.muted};font-weight:700;">${i + 1} / ${picked.length} &nbsp; ${pill(SECTORS[c.key] || c.sector)}</div>${c.html}</td></tr></table>`, '8px 0 0')));
  };
  const projectsSec = () => {
    const groups = [...b.projects].sort((x, y) => rank(x.key) - rank(y.key) || y.count - x.count);
    if (!groups.length) return;
    const total = groups.reduce((n, g) => n + g.count, 0);
    out.push(h2(`New projects this week <span style="color:${C.muted};font-weight:400;">· ${total}</span>`, mine.size ? 'Your sectors in full; the rest in one line at the end' : 'Largest first, by sector'));
    const folded = [];
    for (const g of groups) {
      if (!follows(g.key)) { folded.push(g); continue; }
      out.push(row(`<div style="font-size:13px;font-weight:700;color:${C.ink};border-bottom:2px solid ${mine.has(g.key) ? C.gold : C.navy};padding-bottom:3px;">${esc(SECTORS[g.key])} <span style="color:${C.muted};font-weight:400;">· ${g.count}</span></div>`, '14px 0 2px'));
      g.rows.slice(0, perSector).forEach((h) => out.push(h));
      if (g.count > perSector) out.push(para(`<span style="font-size:13px;">${link(`+ ${g.count - perSector} more ${esc(SECTORS[g.key].toLowerCase())} projects →`, g.moreUrl)}</span>`, '6px 0 0'));
    }
    if (folded.length) out.push(para(`<span style="font-size:13px;color:${C.muted};"><b>Also this week:</b> ${folded.map((g) => `${link(esc(SECTORS[g.key]), g.moreUrl, C.muted).replace('font-weight:700;', 'font-weight:600;')} ${g.count}`).join(' · ')}</span>`, '14px 0 0'));
  };
  const flowsSec = () => {
    if (!b.flows || (!b.flows.items.length && !b.flows.lanes)) return;
    out.push(h2('Flows that changed', 'Where cargo is moving differently this week and what it means for buyers and shippers'));
    const items = [...b.flows.items].sort((x, y) => rank(x.key) - rank(y.key)).slice(0, flowsN);
    items.forEach((f) => out.push(f.html));
    if (b.flows.lanes) out.push(b.flows.lanes);
  };
  const order = FLOWFIRST.includes(reader.role) ? [flowsSec, callsSec, projectsSec] : [callsSec, projectsSec, flowsSec];
  order.forEach((f) => f());
  if (b.moves) out.push(b.moves);
  out.push(button('Browse every project, with filters →', b.links.projects));
  for (const t of b.tail) out.push(t);
  return out.join('\n');
}

// Full document around the assembled body. preview = hidden preheader text.
export function document(b, bodyHtml) {
  const pre = esc(b.preview) + '&#8199;&#65279;&#847;'.repeat(40);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(b.head.kicker)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:${C.card};border-radius:10px;"><tr><td style="padding:22px 18px 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${bodyHtml}
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;
}
