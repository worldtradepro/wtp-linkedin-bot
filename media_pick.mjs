// Picks legally usable, good-quality photos for a slot and files them in the shared media library
// (../media_library, used by the web reports, the carousel, the newsletter and the LinkedIn videos).
//
// Rules (agreed 2026-09-27, see ../linkedin_video/photo_whitelist.md):
//   - never a photo taken from a news article; "credit the source" is not a licence
//   - sources: Wikimedia Commons (PD / CC0 / CC BY / CC BY-SA only), Pixabay (needs env PIXABAY_KEY),
//     and the 5 whitelisted company press libraries (added by hand with --add, only for that company's own news)
//   - quality gate: original >= 1600 px wide for a hero, >= 1200 for inline; landscape; no maps, logos, diagrams,
//     drawings, flags, soldiers, portraits; old photos only when the caption says archive
//   - a generic photo must be captioned "Illustrative", never passed off as the event
// Every file in the library has a ledger row (source page, author, licence, licence URL, retrieved date,
// caption, tags, size) in media_library/ledger.json, so any use can be traced back to its licence.
//
//   node media_pick.mjs search <slot-name> "<query>" ["<query>" ...] [--min 1600] [--must word,word]
//        -> downloads the best candidates to media_library/candidates/<slot>/ + contact.png with scores
//   node media_pick.mjs keep <slot-name> <candidate-id> --caption "..." --tags a,b [--illustrative]
//        -> moves the candidate into the library and writes its ledger row; prints the library id
//   node media_pick.mjs list [tag]

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = process.env.MEDIA_LIBRARY || join(HERE, 'media_library');   // in the repo, so the GitHub workflow has it too
const LEDGER = join(LIB, 'ledger.json');
const UA = 'WorldTradePro-media-picker/1.0 (https://worldtradepro.com; contact@worldtradepro.com)';
mkdirSync(join(LIB, 'candidates'), { recursive: true });
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : [];
const saveLedger = () => writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

const LICENSE_OK = /^(cc0|public domain|pd|cc by(-sa)? ?\d(\.\d)?( [a-z-]+)?|cc by(-sa)?|attribution|pixabay content license)$/i;
const REJECT = /\b(map|maps|diagram|chart|graph|logo|flag|coat of arms|emblem|seal|stamp|poster|drawing|painting|illustration|sketch|render(ing)?|screenshot|infographic|soldiers?|troops?|military|army|navy|warship|portrait|selfie|protest|svg|satellite|sentinel|landsat|astronaut)\b/i;

async function commons(q, limit = 40) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u, { headers: { 'user-agent': UA } })).json();
  return Object.values(j.query?.pages || {}).map((p) => {
    const ii = p.imageinfo?.[0] || {}, m = ii.extmetadata || {};
    const v = (k) => strip(m[k]?.value);
    return { source: 'wikimedia', id: 'wm-' + p.pageid, title: p.title.replace(/^File:/, ''), page: ii.descriptionurl, url: ii.thumburl || ii.url, orig: ii.url,
      w: ii.width, h: ii.height, mime: ii.mime, license: v('LicenseShortName'), licenseUrl: v('LicenseUrl'), author: v('Artist'),
      desc: v('ImageDescription'), cats: v('Categories'), date: v('DateTimeOriginal') || v('DateTime'), q };
  });
}
async function pixabay(q) {
  const KEY = process.env.PIXABAY_KEY;
  if (!KEY) return [];
  const u = `https://pixabay.com/api/?key=${KEY}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=30`;
  const j = await (await fetch(u)).json();
  return (j.hits || []).map((h) => ({ source: 'pixabay', id: 'px-' + h.id, title: h.tags, page: h.pageURL, url: h.largeImageURL, orig: h.largeImageURL,
    w: h.imageWidth, h: h.imageHeight, mime: 'image/jpeg', license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/',
    author: h.user, desc: h.tags, cats: '', date: '', q }));
}

// Openverse (openverse.org): CC-licensed images from Flickr and other providers, filtered to commercial use + modification.
// Credentials: env OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET, or ../.openverse.json (outside this public repo).
let ovToken = null;
async function openverse(q) {
  let id = process.env.OPENVERSE_CLIENT_ID, secret = process.env.OPENVERSE_CLIENT_SECRET;
  const f = join(HERE, '..', '.openverse.json');
  if ((!id || !secret) && existsSync(f)) ({ client_id: id, client_secret: secret } = JSON.parse(readFileSync(f, 'utf8')));
  if (!id || !secret) return [];
  if (!ovToken) {
    const t = await fetch('https://api.openverse.org/v1/auth_tokens/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
    ovToken = (await t.json()).access_token;
    if (!ovToken) return [];
  }
  const u = new URL('https://api.openverse.org/v1/images/');
  Object.entries({ q, license_type: 'commercial,modification', page_size: '40', mature: 'false' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u, { headers: { authorization: 'Bearer ' + ovToken, 'user-agent': UA } })).json().catch(() => ({}));
  const LIC = { cc0: 'CC0', pdm: 'Public domain', by: 'CC BY', 'by-sa': 'CC BY-SA' };
  return (j.results || []).filter((r) => r.source !== 'wikimedia' && LIC[r.license] && r.width && r.height).map((r) => ({
    source: 'openverse:' + r.source, id: 'ov-' + r.id.slice(0, 12), title: r.title || '', page: r.foreign_landing_url, url: r.url, orig: r.url,
    w: r.width, h: r.height, mime: /png/i.test(r.filetype || r.url) ? 'image/png' : 'image/jpeg',
    license: LIC[r.license] + (r.license_version && !/cc0|pdm/.test(r.license) ? ' ' + r.license_version : ''), licenseUrl: r.license_url,
    author: r.creator || 'unknown', desc: (r.tags || []).map((t) => t.name).join(' '), cats: '', date: '', q }));
}

function rate(c, min, must) {
  const text = `${c.title} ${c.desc} ${c.cats}`.toLowerCase();
  const why = [];
  if (!LICENSE_OK.test(c.license || '')) return { ok: false, why: ['licence: ' + (c.license || 'unknown')] };
  if (!/jpeg|png|webp/.test(c.mime || '')) return { ok: false, why: ['not a photo file'] };
  if ((c.w || 0) < min) return { ok: false, why: [`too small ${c.w}px`] };
  const ar = c.w / c.h;
  if (ar < 1.25 || ar > 2.4) return { ok: false, why: [`shape ${ar.toFixed(2)}`] };
  if (REJECT.test(`${c.title} ${c.desc}`)) return { ok: false, why: ['looks like ' + `${c.title} ${c.desc}`.match(REJECT)[0]] };
  if (must.length && !must.some((w) => text.includes(w))) return { ok: false, why: ['none of: ' + must.join('/')] };
  let s = 0;
  const words = c.q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const hit = words.filter((w) => text.includes(w)).length;
  s += hit * 10; why.push(`${hit}/${words.length} query words`);
  if (must.length) { const m = must.filter((w) => text.includes(w)).length; s += m * 15; why.push(`${m} must-words`); }
  s += Math.min(20, (c.w - min) / 200); why.push(`${c.w}px`);
  const y = parseInt((c.date || '').match(/(19|20)\d\d/)?.[0] || '0', 10);
  if (y && y < 2000 && !/archive|histor/.test(text)) { s -= 25; why.push(`old ${y}`); } else if (y >= 2015) { s += 5; why.push(String(y)); }
  if (c.source === 'wikimedia' && /featured|quality images|valued images/i.test(c.cats)) { s += 15; why.push('Commons quality pick'); }
  return { ok: true, s, why };
}

async function contactSheet(dir, rows) {
  const html = `<html><body style="margin:0;background:#f2f4f7;font:13px/1.35 Segoe UI,Arial;display:grid;grid-template-columns:repeat(3,420px);gap:10px;padding:10px">
${rows.map((r, i) => `<div style="background:#fff;border-radius:6px;overflow:hidden"><img src="file:///${join(dir, r.file).replace(/\\/g, '/')}" style="width:420px;height:236px;object-fit:cover;display:block">
<div style="padding:6px 8px"><b>#${i + 1} ${r.id}</b> · score ${r.score.toFixed(0)} · ${r.w}×${r.h} · ${r.license}<br><span style="color:#555">${r.title.slice(0, 90)}</span></div></div>`).join('')}
</body></html>`;
  writeFileSync(join(dir, 'contact.html'), html);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  await p.goto('file:///' + join(dir, 'contact.html').replace(/\\/g, '/')); await p.waitForTimeout(800);
  await p.screenshot({ path: join(dir, 'contact.png'), fullPage: true }); await b.close();
}

const cmd = args[0];
if (cmd === 'search') {
  const slot = args[1];
  const queries = [];
  for (let i = 2; i < args.length; i++) { if (args[i].startsWith('--')) i++; else queries.push(args[i]); }
  const min = parseInt(opt('--min', '1600'), 10), must = (opt('--must', '') || '').toLowerCase().split(',').filter(Boolean), N = parseInt(opt('--n', '9'), 10);
  const seen = new Map(), rejected = {};
  for (const q of queries) for (const c of [...await commons(q), ...await pixabay(q), ...await openverse(q)]) {
    if (seen.has(c.id) || ledger.some((l) => l.sourceId === c.id)) continue;
    const r = rate(c, c.source.startsWith('openverse') ? Math.min(min, 1000) : min, must);   // Openverse serves Flickr at 1024 px: enough for a 1080-wide slide banner
    if (!r.ok) { rejected[r.why[0].split(' ')[0]] = (rejected[r.why[0].split(' ')[0]] || 0) + 1; continue; }
    seen.set(c.id, { ...c, score: r.s, why: r.why });
  }
  // one shot per series (same file name before the trailing number / date), so the sheet shows real alternatives
  const stem = (t) => t.toLowerCase().replace(/\.(jpe?g|png|webp)$/, '').replace(/[\s,_-]*(\(\d+\)|\d{1,3}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{4}.*)$/g, '').replace(/[\s,_-]*\d{1,3}$/, '').slice(0, 40);
  const series = new Set();
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score).filter((c) => { const k = stem(c.title); if (series.has(k)) return false; series.add(k); return true; });
  // Openverse (Flickr, 1024 px) always loses the size bonus to Commons originals: reserve ~40% of the sheet for it
  const ov = ranked.filter((c) => c.source.startsWith('openverse')), rest = ranked.filter((c) => !c.source.startsWith('openverse'));
  const nOv = Math.min(ov.length, Math.floor(N * 0.4));
  const best = [...rest.slice(0, N - nOv), ...ov.slice(0, nOv)].concat(rest.slice(N - nOv)).slice(0, N);
  const dir = join(LIB, 'candidates', slot); mkdirSync(dir, { recursive: true });
  for (const c of best) {
    const ext = /png/.test(c.mime) ? 'png' : 'jpg';
    const buf = Buffer.from(await (await fetch(c.url, { headers: { 'user-agent': UA } })).arrayBuffer());
    c.file = `${c.id}.${ext}`; writeFileSync(join(dir, c.file), buf);
  }
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(best, null, 2));
  if (best.length) await contactSheet(dir, best);
  console.log(`${slot}: ${best.length} candidates (rejected: ${JSON.stringify(rejected)}) -> ${dir}`);
  best.forEach((c, i) => console.log(`#${i + 1} ${c.id} ${c.score.toFixed(0)} ${c.w}x${c.h} ${c.license} | ${c.title.slice(0, 80)} | ${c.why.join(', ')}`));
} else if (cmd === 'keep') {
  const [slot, id] = [args[1], args[2]];
  const dir = join(LIB, 'candidates', slot);
  const c = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')).find((x) => x.id === id);
  if (!c) throw new Error('no candidate ' + id);
  const caption = opt('--caption', ''); if (!caption) throw new Error('--caption is required (what and where)');
  const illustrative = args.includes('--illustrative');
  renameSync(join(dir, c.file), join(LIB, c.file));
  const credit = c.source === 'pixabay' ? `Photo: ${c.author} / Pixabay` : c.source.startsWith('openverse:') ? `Photo: ${c.author} · ${c.license} · ${c.source.slice(10).replace(/^flickr$/, 'Flickr')}` : `Photo: ${c.author || 'Wikimedia Commons'} · ${c.license} · Wikimedia Commons`;
  const row = { id: c.id, file: c.file, sourceId: c.id, source: c.source, page: c.page, original: c.orig, author: c.author, license: c.license, licenseUrl: c.licenseUrl,
    retrieved: new Date().toISOString().slice(0, 10), width: c.w, height: c.h, title: c.title, caption: (illustrative && !/^illustrative:/i.test(caption) ? 'Illustrative: ' : '') + caption, credit,
    tags: (opt('--tags', '') || '').split(',').filter(Boolean), illustrative, usedIn: [] };
  ledger.push(row); saveLedger();
  console.log('kept', row.id, '->', join(LIB, row.file), '\n', row.credit);
} else if (cmd === 'list') {
  const tag = args[1];
  ledger.filter((l) => !tag || l.tags.includes(tag)).forEach((l) => console.log(l.id, l.width + 'x' + l.height, l.license, '|', l.caption, '|', l.tags.join(',')));
} else {
  console.log('usage: search <slot> "<query>"... [--min 1600] [--must a,b] | keep <slot> <id> --caption ".." --tags a,b [--illustrative] | list [tag]');
}
