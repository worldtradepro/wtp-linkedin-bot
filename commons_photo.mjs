// Wikimedia Commons photo of the facility itself (owner 2026-11-06: too many fact cards; second photo source after the project party's own site).
// Many tracked projects are expansions or upgrades of an existing plant, refinery, port or power station, and Commons often has a real photo
// of exactly that site. Rules:
//   - licence: public domain, CC0, CC BY or CC BY-SA only (Commons hosts no NC/ND); shown unedited, credited "<author> / Wikimedia Commons, <licence>";
//   - relevance: the file name must carry the project's own proper name (not a country / place word alone) and one more word of the
//     project name, so "Dangote Refinery" matches "Dangote_Refinery_Lekki.jpg" but "1.3-GW Wind Farm in Victoria" matches nothing;
//   - no maps, logos, diagrams, flags; the usual photo checks (loadPhoto) and the detail check (official_photo.mjs).
import { loadPhoto } from './image_search.mjs';
import { detailOf, MIN_DETAIL } from './official_photo.mjs';

const UA = 'wtp-linkedin-bot/1.0 (https://worldtradepro.com; contact@worldtradepro.com)';   // Wikimedia API policy: identify the client
const OK_LICENCE = /^(cc0|pd|public domain|cc[ -]by(-sa)?[ -]\d)/i;
const NOT_PHOTO = /\b(map|locator|logo|diagram|chart|graph|flag|coat of arms|seal|plan|layout|scheme|schematic|icon|svg|render(ing)?|drawing|poster|stamp|banknote)\b/i;
// words of a project name that do not identify a facility
const PLAIN = /^(project|projects|plant|phase|one|two|three|new|the|and|for|with|order|contract|contracts|epc|expansion|development|construction|facility|scheme|upgrade|revamp|unit|units|tender|tenders|award|loan|green|billion|million|deliveries|crude|data|centre|center|campus|pipeline|plans|plan|programme|program|capacity|auction|procurement|strategy|enhancement|acquisition|campaign|drilling|buildout|financing|gas|oil|solar|wind|farm|power|energy|storage|battery|hydrogen|ammonia|terminal|port|mine|refinery|station|park|zone|line|lines|rail|railway|metro|road|bridge|dam|hub|site|works|complex|cluster)$/i;
const REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
const PLACES = new Set();
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) { try { const n = REGIONS.of(String.fromCharCode(a, b)); if (n && !/^[A-Z]{2}$/.test(n)) n.toLowerCase().split(/\s+/).forEach((w) => PLACES.add(w)); } catch { /* not a region */ } }
for (const w of 'north south east west northern southern eastern western central upper lower greater new gulf sea ocean bay coast island islands state province region county city district valley victoria queensland texas california alberta ontario quebec bavaria'.split(' ')) PLACES.add(w);

const words = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// the identifying words of a project: proper names (capitalised in the name, not a place, not a plain word) -> 'dangote'
export function properNames(name, facts = {}) {
  const local = new Set([...words(facts.country), ...words(facts.city)].map((w) => w.toLowerCase()));
  return [...new Set(words(name).filter((w) => /^[A-Z]/.test(w) && w.length >= 3 && !/^\d/.test(w)).map((w) => w.toLowerCase())
    .filter((w) => !PLAIN.test(w) && !PLACES.has(w) && !local.has(w)))];
}

// same hard time limit as official_photo.mjs: a picture check that never returns must not hold up the day's posts
export async function commonsPhoto(ctx, facts, opts = {}, log = () => {}) {
  let timer;
  const limit = new Promise((res) => { timer = setTimeout(() => { log('commons lookup stopped after ' + (opts.timeoutMs || 60000) / 1000 + ' s'); res(null); }, opts.timeoutMs || 60000); });
  try { return await Promise.race([findCommons(ctx, facts, opts, log), limit]); } finally { clearTimeout(timer); }
}
async function findCommons(ctx, facts, { seen = () => false } = {}, log = () => {}) {
  const proper = properNames(facts.name, facts);
  if (!proper.length) return null;   // nothing that names a specific facility: a Commons hit would be a look-alike
  const owner = (facts.parties || []).find((p) => p.role === 'owner')?.name || facts.owner || '';
  const ownerWords = words(owner.replace(/\([^)]*\)/g, ' ')).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !PLAIN.test(w) && !PLACES.has(w)
    && !/^(limited|group|holding|holdings|company|corporation|international|global|national|digital|development|developments|renewable|renewables|resources|industries|infrastructure|partners|capital)$/.test(w));
  const all = words(facts.name).map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !/^\d/.test(w));
  // short query: the proper names + the facility word ("Dangote Refinery", "Drax Power Station"); the whole project name found nothing (2026-11-06 test)
  const nameWords = words(facts.name);
  const facility = (/\b(power station|refinery|terminal|lng|port|harbou?r|mine|smelter|dam|substation|pipeline|wind farm|solar farm|field|plant|railway|station|shipyard|data cent(?:er|re))\b/i.exec(facts.name) || [])[1] || '';
  const qw = nameWords.filter((w) => proper.includes(w.toLowerCase()));
  const q = [...qw, ...(facility && !qw.some((w) => facility.toLowerCase().split(' ').includes(w.toLowerCase())) ? [facility] : [])].join(' ');
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600&gsrsearch=' + encodeURIComponent(q);
  let pages = [];
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(api, { headers: { 'user-agent': UA }, signal: ac.signal }).finally(() => clearTimeout(t));
    pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  } catch (e) { log('commons search failed: ' + String(e.message || e).slice(0, 60)); return null; }
  log(`commons: ${pages.length} files for "${q}"`);
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0]; if (!ii) continue;
    const title = pg.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
    const tw = new Set(words(title).map((w) => w.toLowerCase()));
    if (!/jpe?g/i.test(ii.mime || '') || NOT_PHOTO.test(title.replace(/_/g, ' '))) continue;
    if (!proper.every((w) => tw.has(w)) || all.filter((w) => tw.has(w)).length < 2) continue;   // its own name + one more word of the project name
    // one proper name may be a place we do not know ("Johor"): then the owner must be in the file name too ("Data centre in Johor" is someone else's)
    if (proper.length < 2 && ownerWords.length && !ownerWords.some((w) => tw.has(w))) continue;
    const m = ii.extmetadata || {}, lic = strip(m.LicenseShortName?.value) || strip(m.License?.value);
    if (!OK_LICENCE.test(lic)) { log(`commons ${title}: licence "${lic}" not accepted`); continue; }
    const ph = await loadPhoto(ctx, ii.thumburl || ii.url, 'https://commons.wikimedia.org/');
    if (!ph) { log(`commons ${title}: picture rejected`); continue; }
    if (seen(ph.url, ph.jpeg)) { log(`commons ${title}: already used`); continue; }
    if ((await detailOf(ctx, ph.jpeg)) < MIN_DETAIL) { log(`commons ${title}: abstract / blurred`); continue; }
    const author = strip(m.Artist?.value).replace(/\s*\(talk\)$/i, '').slice(0, 60) || 'unknown author';
    const licence = /^pd|public domain/i.test(lic) ? 'public domain' : lic.replace(/^cc/i, 'CC').toUpperCase().replace(/^CC0$/, 'CC0');
    return { ...ph, credit: `${author} / Wikimedia Commons, ${licence}`, page: ii.descriptionurl, source: 'commons', note: `Commons photo (${title}, ${licence})` };
  }
  return null;
}
