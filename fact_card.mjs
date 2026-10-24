// Infrastructure "fact card" (2026-10-24 owner): the project post picture is our own infographic, in the style of the website's blog
// infographics (navy header, Barlow Condensed, gold accents, light panel, navy footer). Everything on it comes from our database
// (epc_radar fields v3): owner, capacity, value, contractors, financing, stage, location. No photo, so no licence question.
// The illustration is drawn per subsector (a data centre is never drawn as a port), and the map is the project's country
// (Natural Earth 1:50m, public domain: assets/world50m.json, made by a one-off script from ne_50m_admin_0_countries.geojson v5.1.2).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clean, countryName } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGO = 'data:image/png;base64,' + readFileSync(join(HERE, 'assets', 'logo_white_v2.png')).toString('base64');
let WORLD = null;
const world = () => (WORLD ||= JSON.parse(readFileSync(join(HERE, 'assets', 'world50m.json'), 'utf8')));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- locator map
const ALIAS = { 'türkiye': 'Turkey', 'turkiye': 'Turkey', 'czechia': 'Czech Republic', 'ivory coast': "Côte d'Ivoire", 'cote d\'ivoire': "Côte d'Ivoire",
  'usa': 'United States', 'us': 'United States', 'united states of america': 'United States', 'uk': 'United Kingdom', 'drc': 'Dem. Rep. Congo',
  'democratic republic of the congo': 'Dem. Rep. Congo', 'congo (drc)': 'Dem. Rep. Congo', 'republic of the congo': 'Congo', 'south korea': 'South Korea',
  'korea': 'South Korea', 'uae': 'United Arab Emirates', 'eswatini': 'eSwatini', 'bosnia & herzegovina': 'Bosnia and Herzegovina', 'north macedonia': 'North Macedonia' };
function findCountry(name) {
  if (!name) return null;
  const want = (ALIAS[name.toLowerCase()] || name).toLowerCase();
  return world().find((c) => c.n.some((x) => x.toLowerCase() === want)) || null;
}
const ringArea = (f) => { let a = 0; for (let i = 0; i < f.length - 2; i += 2) a += f[i] * f[i + 3] - f[i + 2] * f[i + 1]; return Math.abs(a / 2); };
const ringBox = (f) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (let i = 0; i < f.length; i += 2) { b[0] = Math.min(b[0], f[i]); b[2] = Math.max(b[2], f[i]); b[1] = Math.min(b[1], f[i + 1]); b[3] = Math.max(b[3], f[i + 1]); } return b; };

// Equirectangular with the x axis shrunk by cos(mid latitude): close enough to true shape at country scale, and no projection library.
export function locatorSvg(countryName, W, H) {
  const c = findCountry(countryName);
  if (!c) return '';
  // frame the main landmass (France's or the US's overseas parts would otherwise zoom the map out to the whole world)
  const main = c.p.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a), c.p[0]);
  const mb = ringBox(main);
  const boxes = c.p.map(ringBox).filter((b) => b[0] > mb[0] - 8 && b[2] < mb[2] + 8 && b[1] > mb[1] - 8 && b[3] < mb[3] + 8);
  let [x0, y0, x1, y1] = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], mb);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, k = Math.cos((cy * Math.PI) / 180);
  let sw = Math.max((x1 - x0) * k * 1.9, 16), sh = Math.max((y1 - y0) * 1.9, 16 * (H / W));   // country fills about half the frame; small countries get regional context
  if (sw / sh > W / H) sh = sw * (H / W); else sw = sh * (W / H);
  const s = W / sw, px = (lon) => ((lon - cx) * k * s + W / 2).toFixed(1), py = (lat) => (H / 2 - (lat - cy) * s).toFixed(1);
  const vx0 = cx - sw / 2 / k, vx1 = cx + sw / 2 / k, vy0 = cy - sh / 2, vy1 = cy + sh / 2;
  const path = (f) => { let d = ''; for (let i = 0; i < f.length; i += 2) d += (i ? 'L' : 'M') + px(f[i]) + ' ' + py(f[i + 1]); return d + 'Z'; };
  const inView = (b) => b[2] > vx0 && b[0] < vx1 && b[3] > vy0 && b[1] < vy1;
  let others = '';
  for (const o of world()) { if (o === c) continue; const d = o.p.filter((r) => inView(ringBox(r))).map(path).join(''); if (d) others += d; }
  const mine = c.p.filter((r) => inView(ringBox(r))).map(path).join('');
  // mini world in the corner: where on the globe this is
  const mw = 150, mh = 76, mpx = (lon) => (((lon + 180) / 360) * mw).toFixed(1), mpy = (lat) => (((84 - lat) / 144) * mh).toFixed(1);
  let mini = '';
  for (const o of world()) for (const r of o.p) { if (ringArea(r) < 4) continue; let d = ''; for (let i = 0; i < r.length; i += 8) d += (i ? 'L' : 'M') + mpx(r[i]) + ' ' + mpy(r[i + 1]); mini += d + 'Z'; }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#dfe8f3"/>
    <path d="${others}" fill="#c3d0e2" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="${mine}" fill="#e0bd4c" stroke="#0f2d5e" stroke-width="2.5" stroke-linejoin="round"/>
    <g transform="translate(${W - mw - 14} ${H - mh - 14})"><rect x="-6" y="-6" width="${mw + 12}" height="${mh + 12}" rx="6" fill="#fff" fill-opacity=".92"/>
      <path d="${mini}" fill="#9fb1cb"/><circle cx="${mpx(cx)}" cy="${mpy(cy)}" r="6" fill="#e0bd4c" stroke="#0f2d5e" stroke-width="2"/></g>
  </svg>`;
}

// ---------------------------------------------------------------- subsector illustrations (original line art, 480x240, ground at y=210)
const T = (x, base, top, L, rot) => {   // wind turbine
  const blades = [0, 120, 240].map((a) => { const r = ((a + rot) * Math.PI) / 180; return `<line x1="${x}" y1="${top}" x2="${(x + L * Math.sin(r)).toFixed(1)}" y2="${(top - L * Math.cos(r)).toFixed(1)}"/>`; }).join('');
  return `<path d="M${x - 5} ${base} L${x - 2} ${top} L${x + 2} ${top} L${x + 5} ${base}"/>${blades}<circle class="g" cx="${x}" cy="${top}" r="6"/>`;
};
const tank = (x, w, h) => `<rect x="${x}" y="${210 - h}" width="${w}" height="${h}" rx="4"/><path d="M${x} ${210 - h} Q${x + w / 2} ${210 - h - w * 0.22} ${x + w} ${210 - h}"/>`;
const sphere = (x, r) => `<circle cx="${x}" cy="${210 - r - 22}" r="${r}"/><line x1="${x - r * 0.7}" y1="${210 - r - 22 + r * 0.7}" x2="${x - r * 0.8}" y2="210"/><line x1="${x + r * 0.7}" y1="${210 - r - 22 + r * 0.7}" x2="${x + r * 0.8}" y2="210"/>`;
const column = (x, w, h) => `<rect x="${x}" y="${210 - h}" width="${w}" height="${h}" rx="${w / 2.4}"/>` + [0.25, 0.5, 0.75].map((f) => `<line x1="${x}" y1="${210 - h * f}" x2="${x + w}" y2="${210 - h * f}"/>`).join('');
const box = (x, y, w, h, gold) => `<rect${gold ? ' class="g"' : ''} x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`;
const pylon = (x, top) => `<path d="M${x - 22} 210 L${x} ${top} L${x + 22} 210 M${x - 14} ${top + 50} L${x + 14} ${top + 50} M${x - 30} ${top + 18} L${x + 30} ${top + 18} M${x - 8} ${top + 100} L${x + 8} ${top + 100}"/>`;
const ART = {
  datacenter: () => box(40, 70, 400, 140) + [0, 1, 2, 3, 4, 5].map((i) => box(62 + i * 62, 92, 46, 102) + [0, 1, 2, 3].map((j) => `<line x1="${70 + i * 62}" y1="${106 + j * 22}" x2="${98 + i * 62}" y2="${106 + j * 22}"/><circle class="g" cx="${101 + i * 62}" cy="${106 + j * 22}" r="2.5"/>`).join('')).join('')
    + [0, 1, 2].map((i) => `<rect x="${80 + i * 120}" y="46" width="80" height="24" rx="3"/><circle cx="${104 + i * 120}" cy="58" r="8"/><circle cx="${136 + i * 120}" cy="58" r="8"/>`).join(''),
  solar: () => `<circle class="g" cx="404" cy="58" r="26"/>` + [0, 1, 2].map((r) => [0, 1, 2, 3].map((i) => { const y = 104 + r * 38, x = 24 + i * 100 + r * 22; return `<path d="M${x} ${y + 26} L${x + 22} ${y} L${x + 92} ${y} L${x + 70} ${y + 26} Z"/><line x1="${x + 46}" y1="${y + 26}" x2="${x + 46}" y2="${y + 34}"/>`; }).join('')).join(''),
  wind: () => T(110, 210, 70, 62, 15) + T(250, 210, 104, 46, 75) + T(380, 210, 60, 70, 40) + `<path d="M0 210 Q120 190 240 205 T480 200" />`,
  battery: () => [0, 1, 2, 3].map((i) => box(28 + i * 108, 112, 92, 98) + `<rect class="g" x="${54 + i * 108}" y="140" width="40" height="22" rx="3"/><rect x="${94 + i * 108}" y="146" width="5" height="10"/>` + `<line x1="${40 + i * 108}" y1="186" x2="${108 + i * 108}" y2="186"/>`).join('') + pylon(452, 80),
  hydrogen: () => [0, 1, 2].map((i) => box(24 + i * 92, 128, 80, 82) + `<line x1="${36 + i * 92}" y1="150" x2="${92 + i * 92}" y2="150"/><line x1="${36 + i * 92}" y1="170" x2="${92 + i * 92}" y2="170"/>`).join('') + sphere(340, 40) + sphere(430, 30)
    + `<text x="340" y="154" class="tx" text-anchor="middle">H₂</text>`,
  lng: () => tank(26, 120, 112) + tank(160, 120, 112) + `<path d="M296 196 L470 196 L458 210 L308 210 Z"/>` + [0, 1, 2, 3].map((i) => `<path class="g" d="M${318 + i * 36} 196 A16 16 0 0 1 ${350 + i * 36} 196 Z"/>`).join('') + `<rect x="442" y="168" width="18" height="28"/>`,
  oilgas: () => `<path d="M60 210 L80 120 M160 210 L140 120 M60 210 L160 120 M160 210 L60 120"/>` + box(48, 96, 124, 24) + box(70, 64, 54, 32) + `<path d="M150 96 L168 30 L180 96"/><path class="g" d="M172 30 Q176 14 186 22 Q182 30 172 30 Z"/>`
    + `<path d="M260 210 L300 210 L300 150"/><path d="M262 132 L400 96 L408 110 L270 146 Z"/><line x1="330" y1="120" x2="330" y2="210"/><circle cx="330" cy="120" r="10" class="g"/><path d="M400 110 L400 200"/><rect x="384" y="190" width="32" height="20"/>`,
  refinery: () => column(40, 30, 150) + column(84, 24, 112) + column(122, 36, 172) + `<path d="M170 210 L170 40"/><path class="g" d="M170 40 Q174 22 184 30 Q180 38 170 40 Z"/>` + tank(210, 80, 60) + tank(300, 80, 60) + tank(390, 70, 44) + `<line x1="30" y1="118" x2="160" y2="118"/>`,
  gaspower: () => box(40, 110, 240, 100) + `<path d="M84 110 L84 70 L240 70 L240 110"/>` + box(300, 40, 30, 170, true) + box(346, 70, 26, 140) + pylon(430, 70) + `<line x1="40" y1="160" x2="280" y2="160"/>`,
  power: () => pylon(80, 60) + pylon(240, 50) + pylon(400, 60) + `<path d="M50 78 Q160 112 210 68 Q320 112 370 78 M110 78 Q160 100 270 68 Q350 100 430 78"/>` + box(150, 170, 60, 40, true) + box(300, 170, 60, 40),
  water: () => tank(30, 110, 84) + tank(156, 110, 84) + `<path d="M140 160 L156 160 M266 160 L300 160 L300 120 L420 120"/>` + box(300, 136, 150, 74) + [0, 1, 2, 3].map((i) => `<line x1="${316 + i * 34}" y1="150" x2="${316 + i * 34}" y2="196"/>`).join('') + `<path class="w" d="M0 228 Q30 218 60 228 T120 228 T180 228 T240 228 T300 228 T360 228 T420 228 T480 228"/>`,
  port: () => `<path d="M90 210 L110 70 L124 70 L118 210 M170 210 L150 70 L164 70 L190 210 M40 70 L330 70 M110 70 L134 20 L150 70 M134 20 L330 70 M134 20 L40 70"/><line x1="270" y1="70" x2="270" y2="110"/>` + box(256, 110, 28, 18, true)
    + [[300, 182], [346, 182], [392, 182], [438, 182], [323, 156], [369, 156], [415, 156], [346, 130], [392, 130]].map(([x, y], i) => box(x - 14, y, 42, 26, i % 3 === 1)).join(''),
  rail: () => `<line x1="0" y1="210" x2="480" y2="210"/><line x1="0" y1="56" x2="480" y2="56"/>` + [60, 240, 420].map((x) => `<line x1="${x}" y1="40" x2="${x}" y2="210"/>`).join('')
    + `<path d="M30 196 L30 110 Q30 92 52 92 L300 92 L360 120 L380 196 Z"/>` + [0, 1, 2, 3, 4].map((i) => box(52 + i * 50, 108, 36, 28)).join('') + `<path class="g" d="M300 92 L360 120 L300 120 Z"/><path d="M180 92 L200 56 L220 92"/>` + [70, 130, 250, 320].map((x) => `<circle cx="${x}" cy="200" r="10"/>`).join(''),
  ship: () => `<path d="M20 160 L440 160 L404 210 L54 210 Z"/>` + box(46, 104, 70, 56) + box(60, 80, 42, 24) + [0, 1, 2, 3, 4, 5].map((i) => box(140 + i * 46, 126, 40, 34, i === 2)).join('') + [0, 1, 2, 3].map((i) => box(186 + i * 46, 92, 40, 34, i === 0)).join('')
    + `<path d="M440 20 L440 160 M300 20 L470 20 M300 20 L300 60"/>`,
  pipeline: () => `<line x1="0" y1="140" x2="300" y2="140"/><line x1="0" y1="158" x2="300" y2="158"/>` + [30, 110, 190, 270].map((x) => `<path d="M${x - 14} 210 L${x} 158 L${x + 14} 210"/>`).join('') + `<circle class="g" cx="150" cy="130" r="9"/>` + tank(320, 70, 110) + tank(400, 70, 80),
  mine: () => `<path d="M0 210 L60 150 L130 150 L170 110 L250 110 L280 80" /><path d="M80 210 L120 52 L136 52 L176 210 M96 140 L160 140 M128 52 L128 30"/><circle class="g" cx="128" cy="30" r="14"/>`
    + `<path d="M280 210 L280 150 L380 150 L404 120 L450 120 L462 150 L462 196"/><circle cx="310" cy="196" r="16"/><circle cx="430" cy="196" r="16"/><path class="g" d="M290 150 L300 116 L376 116 L380 150 Z"/>`,
  smelter: () => box(40, 120, 220, 90) + `<path d="M40 120 L150 76 L260 120"/>` + box(80, 30, 26, 90) + box(150, 50, 22, 70) + `<path class="g" d="M290 150 Q290 196 340 196 Q390 196 390 150 Z"/><path d="M310 150 L310 120 M370 150 L370 120 M300 120 L380 120"/>` + tank(410, 50, 70),
  silos: () => [0, 1, 2, 3].map((i) => box(30 + i * 62, 80 + (i % 2) * 20, 54, 130 - (i % 2) * 20) + `<path d="M${30 + i * 62} ${80 + (i % 2) * 20} L${57 + i * 62} ${60 + (i % 2) * 20} L${84 + i * 62} ${80 + (i % 2) * 20}"/>`).join('') + `<path d="M290 210 L290 40 L320 40 L320 210 M320 60 L70 66"/>` + box(350, 150, 110, 60, true),
  irrigation: () => `<path d="M0 210 L480 210"/>` + [0, 1, 2, 3, 4].map((i) => `<path d="M${30 + i * 96} 150 L${78 + i * 96} 150 M${54 + i * 96} 150 L${40 + i * 96} 210 M${54 + i * 96} 150 L${68 + i * 96} 210"/><circle cx="${54 + i * 96}" cy="200" r="10"/>`).join('') + `<line x1="20" y1="140" x2="460" y2="140"/><line x1="20" y1="132" x2="460" y2="132"/>`
    + [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<path class="w" d="M${40 + i * 50} 142 l-6 18 M${40 + i * 50} 142 l6 18"/>`).join(''),
  fertilizer: () => box(40, 30, 60, 180) + `<path d="M40 30 L70 10 L100 30"/>` + `<path d="M130 210 Q130 120 210 120 Q290 120 290 210"/><path d="M300 210 Q300 140 360 140 Q420 140 420 210"/>` + `<path class="g" d="M190 210 L210 170 L230 210 Z"/>` + column(436, 26, 120),
  renewables: () => T(70, 210, 80, 54, 30) + T(170, 210, 104, 40, 80) + [0, 1].map((r) => [0, 1, 2].map((i) => { const y = 150 + r * 30, x = 230 + i * 80 + r * 14; return `<path d="M${x} ${y + 24} L${x + 18} ${y} L${x + 76} ${y} L${x + 58} ${y + 24} Z"/>`; }).join('')).join('') + `<circle class="g" cx="420" cy="60" r="24"/>`,
  default: () => box(30, 110, 90, 100) + box(130, 70, 70, 140) + box(210, 130, 80, 80) + `<path d="M330 210 L330 30 M300 30 L460 30 M330 30 L350 10 L360 30"/><line x1="440" y1="30" x2="440" y2="80"/>` + box(426, 80, 28, 22, true),
};
const ART_LABEL = { renewables: 'Renewables', datacenter: 'Data centre', solar: 'Solar', wind: 'Wind', battery: 'Battery storage', hydrogen: 'Hydrogen & ammonia', lng: 'LNG', oilgas: 'Oil & gas', refinery: 'Refining & petrochemicals',
  gaspower: 'Gas-fired power', power: 'Power & transmission', water: 'Water & desalination', port: 'Ports & terminals', rail: 'Rail', ship: 'Ships & shipyards', pipeline: 'Pipelines & storage',
  mine: 'Mining', smelter: 'Processing & smelting', silos: 'Grain & food', irrigation: 'Irrigation', fertilizer: 'Fertilizer', default: 'Infrastructure' };
export function artKey(sector = '', subsector = '', name = '', capacity = '') {
  // a specific subsector wins ("Offshore Wind CTVs Order" is a ship order); broad ones are refined by the project name and capacity text
  const BROAD = /^(|renewables|power & transmission|oil & gas|energy|irrigation & water|pipelines & storage|mine development|critical minerals)$/i;
  const sub = (subsector || '').toLowerCase(), t = `${BROAD.test(sub) ? '' : sub} ${BROAD.test(sub) ? name + ' ' + capacity : ''}`.toLowerCase(), s = `${sector} ${subsector}`.toLowerCase();
  const rules = [
    [/data ?cent|hyperscale|\bai campus/, 'datacenter'], [/desalin|water treatment|wastewater|\bwater\b(?!.*irrigat)/, 'water'], [/irrigat|\bdam\b|canal/, 'irrigation'],
    [/battery|bess|energy storage/, 'battery'], [/hydrogen|ammonia|electroly/, 'hydrogen'], [/solar|photovolt|\bpv\b/, 'solar'], [/wind|offshore wind/, 'wind'],
    [/\blng\b|liquef|regas|fsru/, 'lng'], [/refin|petrochem|chemical/, 'refinery'], [/fertili[sz]|urea|potash|phosphate/, 'fertilizer'],
    [/combined.cycle|gas.fired|ccgt|gas turbine|thermal power/, 'gaspower'], [/pipeline|storage terminal|tank farm/, 'pipeline'], [/power|transmission|grid|substation|hydro/, 'power'],
    [/shipyard|fleet|vessel|newbuild|\bships?\b|carrier/, 'ship'], [/port|terminal|harbou?r|container/, 'port'], [/rail|metro|tram|train/, 'rail'],
    [/smelt|refinery.*(copper|alumin)|processing/, 'smelter'], [/mine|mining|critical mineral|lithium|copper|gold|iron ore/, 'mine'], [/grain|food|silo/, 'silos'],
    [/oil|gas|upstream|offshore/, 'oilgas'], [/renewable|clean energy|green/, 'renewables'],
  ];
  for (const [re, k] of rules) if (re.test(t)) return k;
  for (const [re, k] of rules) if (re.test(s)) return k;
  return 'default';
}
export const artSvg = (key) => `<svg class="artsvg" viewBox="0 0 480 240" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
  <style>.artsvg *{fill:none;stroke:#fff;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}.artsvg .g{fill:#e0bd4c;stroke:#e0bd4c}.artsvg .w{stroke:#7fb2ea}.artsvg .tx{fill:#e0bd4c;stroke:none;font:800 34px 'Barlow Condensed',sans-serif}</style>
  ${(ART[key] || ART.default)()}<line x1="0" y1="210" x2="480" y2="210" style="stroke-opacity:.5"/></svg>`;
export const artLabel = (key) => ART_LABEL[key] || ART_LABEL.default;

// ---------------------------------------------------------------- big-number tiles
const CUR = { USD: 'US$', EUR: '€', GBP: '£', CNY: 'CN¥', JPY: '¥', INR: '₹', AUD: 'A$', CAD: 'C$', SAR: 'SAR ', AED: 'AED ' };
const UNIT = { million: 'M', billion: 'BN', thousand: 'K' };
export function valueTile(f) {
  const amt = Number(f.valueAmount);
  if (!f.valueAmount || !Number.isFinite(amt) || !UNIT[f.valueUnit]) return null;
  let a = amt, u = f.valueUnit;
  if (u === 'million' && a >= 1000) { a /= 1000; u = 'billion'; }
  const num = a >= 100 ? Math.round(a).toLocaleString('en-US') : String(+a.toFixed(a >= 10 ? 1 : 2));
  const basis = /estimat/i.test(f.valueBasis || '') ? 'Estimated value' : 'Reported value';
  return { big: (CUR[f.valueCurrency] || (f.valueCurrency ? f.valueCurrency + ' ' : '')) + num, unit: UNIT[u], label: f.valueCurrency && !CUR[f.valueCurrency] ? `${basis} (${f.valueCurrency})` : basis };
}
export function capacityTile(f) {
  const c = String(f.capacity || '').trim();
  const m = /^(?:at least\s+)?([\d.,]+)\s*-?\s*(MWp|MWh|MW|GW|GWh|kW|MTPA|Mtpa|mtpa|Mt\/y|Mt|t\/h|tpd|TEU|teu|bpd|barrels per day|million t|tonnes per year|t\/y|km)\b/i.exec(c);
  if (!m) return null;
  const unit = m[2].replace(/^barrels per day$/i, 'BPD').replace(/^mtpa$/i, 'MTPA').toUpperCase().replace('MWP', 'MWp');
  const rest = c.slice(m[0].length).replace(/^[\s,/;-]+/, '');
  return { big: m[1], unit, label: rest && rest.length <= 30 ? 'Capacity · ' + rest : 'Capacity' };
}

// ---------------------------------------------------------------- database row -> card fields (generate.mjs stores this as post.meta.facts)
// contractors / financiers arrive as JSON text: [{"name":"CNCEC","role":"EPC"}]
const parties = (v) => { let a = v; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = a.split(/\s*[;|]\s*/); } }
  return (Array.isArray(a) ? a : []).map((x) => { const n = clean(typeof x === 'string' ? x : x?.name || ''), r = clean(x?.role || '');
    return { n, role: /\bepc/i.test(r) ? 'EPC' : /builder|shipyard/i.test(r) ? 'builder' : '' }; }).filter((x) => x.n).slice(0, 3); };
const names = (v) => parties(v).map((x) => x.n).join(', ');
function contractorLabel(v) {
  const p = parties(v), roles = [...new Set(p.map((x) => x.role))];
  if (roles.length !== 1 || !roles[0]) return p.length > 1 ? 'Contractors' : 'Contractor';
  return roles[0] === 'EPC' ? (p.length > 1 ? 'EPC contractors' : 'EPC contractor') : (p.length > 1 ? 'Shipyards' : 'Shipyard');
}
export function factsOf(it) {
  return { name: clean(it.project_name), owner: clean(it.owner || '').replace(/\s*\((developer|owner|sponsor|client|operator)\)$/i, ''),   // owner field only: company_name can be a supplier
    country: countryName(it.country), city: clean(it.city || ''), sector: it.sector || '', subsector: it.subsector && it.subsector !== '(unspecified)' ? it.subsector : '',
    stage: it.stage || '', capacity: clean(it.capacity || ''), valueAmount: it.value_amount || '', valueUnit: it.value_unit || '', valueCurrency: it.value_currency || '', valueBasis: it.value_basis || '',
    contractors: names(it.contractors), contractorLabel: contractorLabel(it.contractors), financing: names(it.financiers), reportDate: it.report_date || '', scale: clean(it.scale || ''), source: clean(it.source_name || '') };
}

// ---------------------------------------------------------------- the card (1080x1350, LinkedIn portrait)
const STAGE = { S1: 'Earliest lead', S2: 'Development', S3: 'Nearing decision', S4: 'In tender', S5: 'Awarded' };
export const stageName = (s) => STAGE[String(s || '').slice(0, 2)] || String(s || '').replace(/^S\d[-\s]*/, '');
export function factCardHtml(f) {
  const key = artKey(f.sector, f.subsector, f.name, f.capacity);
  const tiles = [valueTile(f), capacityTile(f)].filter(Boolean);
  const stage = stageName(f.stage);
  if (tiles.length < 2 && stage) tiles.push({ big: stage.toUpperCase(), unit: '', label: 'Project stage', text: true });
  const rows = [
    ['Owner', f.owner], [f.contractorLabel || 'Contractors', f.contractors], ['Financing', f.financing],
    ['Location', f.city ? [f.city, f.country].filter(Boolean).join(', ') : ''],
  ].filter(([, v]) => v);
  // thin rows (often only the owner is known): add the scale and who should look, both from our own data
  if (rows.length < 4 && f.scale && !tiles.some((t) => !t.text)) rows.push(['Scale', f.scale[0].toUpperCase() + f.scale.slice(1)]);
  if (rows.length < 4 && f.audience) rows.push(['Worth a look for', f.audience]);
  const name = String(f.name || '');
  const fs = name.length <= 30 ? 74 : name.length <= 50 ? 64 : name.length <= 75 ? 54 : 46;
  const kicker = [key === 'default' && f.subsector ? f.subsector : artLabel(key), f.country].filter(Boolean).join('  ·  ');
  const reported = f.reportDate ? new Date(f.reportDate + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const MAPW = 464, MAPH = 440;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=IBM+Plex+Sans:wght@500;600;700&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0b1626;--navy:#0f2d5e;--gold:#e0bd4c;--blue:#1c4a8a;--bg:#eef3f9}
body{width:1080px;height:1350px;font-family:'IBM Plex Sans',system-ui,sans-serif;background:#fff;overflow:hidden}
.ig{width:1080px;height:1350px;display:flex;flex-direction:column}
.hdr{background:var(--navy);padding:26px 40px 26px;display:flex;align-items:center;gap:30px;min-height:220px}
.hdr img{height:118px;display:block;flex:none}
.hdr .k{font:700 30px/1.05 'Barlow Condensed',sans-serif;color:var(--gold);letter-spacing:.04em;text-transform:uppercase}
.hdr h1{font:800 ${fs}px/0.98 'Barlow Condensed',Impact,sans-serif;color:#fff;text-transform:uppercase;margin-top:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hero{margin:14px 32px 0;display:grid;grid-template-columns:${tiles.length > 1 ? '1fr 1fr' : '1fr'};gap:14px}
.hero div{border-radius:14px;padding:14px 24px 16px;color:#fff;background:var(--navy);height:182px;overflow:hidden}
.hero div+div{background:var(--blue)}
.hero b{display:block;font:800 104px/1 'Barlow Condensed',Impact,sans-serif;white-space:nowrap}
.hero b.t{font-size:84px;line-height:1.2}
.hero b small{font:800 54px/1 'Barlow Condensed',sans-serif;margin-left:8px}
.hero span{display:block;font:700 32px/1.05 'Barlow Condensed',sans-serif;letter-spacing:.03em;text-transform:uppercase;color:#f1dc98;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mid{margin:14px 32px 0;display:grid;grid-template-columns:1fr ${MAPW}px;gap:14px;flex:1;min-height:0}
.facts{background:var(--bg);border:3px solid var(--navy);border-radius:14px;padding:26px 28px;display:flex;flex-direction:column;justify-content:center;gap:26px}
.facts p{font:700 ${rows.length <= 2 ? 30 : 26}px/1 'Barlow Condensed',sans-serif;color:#8a6a0a;letter-spacing:.06em;text-transform:uppercase}
.facts h3{font:700 ${rows.length <= 2 ? 48 : 40}px/1.06 'Barlow Condensed',sans-serif;color:var(--ink);margin-top:4px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.facts hr{border:0;border-top:2px solid #cfdaea}
.right{display:flex;flex-direction:column;gap:14px;min-height:0}
.map{border:3px solid var(--navy);border-radius:14px;overflow:hidden;flex:1;position:relative;background:#dfe8f3}
.map svg{display:block;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
.map i{position:absolute;left:14px;top:12px;font:800 30px/1 'Barlow Condensed',sans-serif;font-style:normal;color:var(--navy);background:rgba(255,255,255,.9);border-radius:8px;padding:6px 12px;text-transform:uppercase;letter-spacing:.03em}
.art{height:250px;flex:none;background:var(--navy);border-radius:14px;padding:12px 20px 10px;display:flex;flex-direction:column;min-height:0}
.art .svg{flex:1;min-height:0}
.art span{font:700 26px/1 'Barlow Condensed',sans-serif;color:var(--gold);letter-spacing:.06em;text-transform:uppercase;margin-top:6px}
.bar{margin:14px 32px 0;background:var(--gold);color:var(--ink);border-radius:12px;text-align:center;padding:10px 12px 12px;font:800 40px/1.05 'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.02em}
.foot{margin-top:14px;background:var(--navy);padding:10px 32px;display:flex;align-items:center;justify-content:space-between;height:96px;gap:20px}
.foot .src{font:500 15px/1.35 'IBM Plex Sans';color:#b9c8de;max-width:660px}
.foot .src b{color:#fff;font-weight:700}
.foot .url{font:800 40px/1 'Barlow Condensed',sans-serif;color:#fff;text-align:right;letter-spacing:.02em}
.foot .url small{display:block;font:600 18px 'IBM Plex Sans';color:var(--gold);margin-top:3px;letter-spacing:0}
</style></head><body><div class="ig">
  <div class="hdr"><img src="${LOGO}" alt=""><div><div class="k">${esc(kicker)}</div><h1>${esc(name)}</h1></div></div>
  ${tiles.length ? `<div class="hero">${tiles.map((t) => `<div><b${t.text ? ' class="t"' : ''}>${esc(t.big)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</b><span>${esc(t.label)}</span></div>`).join('')}</div>` : ''}
  <div class="mid">
    <div class="facts">${rows.map(([k, v], i) => `${i ? '<hr>' : ''}<div><p>${esc(k)}</p><h3>${esc(v)}</h3></div>`).join('')}</div>
    <div class="right">
      <div class="map">${locatorSvg(f.country, MAPW, MAPH)}<i>${esc(f.country || '')}</i></div>
      <div class="art"><div class="svg">${artSvg(key)}</div><span>${esc(f.subsector && f.subsector !== '(unspecified)' ? f.subsector : artLabel(key))}</span></div>
    </div>
  </div>
  <div class="bar">${esc([stage && !tiles.some((t) => t.text) && 'Stage: ' + stage, reported && 'Reported ' + reported].filter(Boolean).join('  ·  ') || 'New project lead')}</div>
  <div class="foot"><div class="src"><b>Project data: World Trade Pro project tracker</b>, compiled from public sources (company filings, tenders, official releases)${f.source ? '. Source: ' + esc(f.source) : ''}. Map: Natural Earth. Drawing: World Trade Pro.</div>
    <div class="url">worldtradepro.com<small>/projects/</small></div></div>
</div></body></html>`;
}
