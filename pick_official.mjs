// Photo first (owner 2026-10-25): with accounts.infra.officialPhotos=true, generate.mjs writes up to photoCandidates ranked Infrastructure
// project posts ("candidate": rank). This step looks for each candidate's official photo (official_photo.mjs) in rank order and keeps the
// projectsPerDay best-ranked candidates that have one, topped up by rank when fewer have a photo (those get the fact card). The kept posts
// become infra-1..n with the day's slots, carry the photo for render.mjs, and are the only ones marked used (state/used.json).
// Usage: node pick_official.mjs [--date YYYY-MM-DD]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { officialPhoto } from './official_photo.mjs';
import { closeOcr } from './image_search.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const DIR = join(HERE, 'queue', DATE), IMG = join(DIR, 'images');
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const A = cfg.accounts.infra;
const BUDGET_MS = (A.photoSearchMinutes || 20) * 60000;   // the whole step; each candidate also stops after 2 minutes

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
const cands = files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))).filter((p) => p.candidate).sort((a, b) => a.candidate - b.candidate);
if (!cands.length) { console.log('No candidate project posts (photo first is off): nothing to do.'); process.exit(0); }
const N = A.projectsPerDay;

// same 30-day "image already used" memory as render.mjs
const IMG_STATE = join(HERE, 'state', 'images_used.json');
const imgUsed = (existsSync(IMG_STATE) ? JSON.parse(readFileSync(IMG_STATE, 'utf8')).items || [] : [])
  .filter((x) => x.date >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const imgSeen = (url, buf) => imgUsed.find((x) => (url && x.url === (url || '').replace(/[?#].*$/, '')) || (buf && x.hash === sha1(buf)));

mkdirSync(IMG, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', locale: 'en-US' });
const start = Date.now(), hits = [];
for (const p of cands) {
  if (hits.length >= N) break;
  if (Date.now() - start > BUDGET_MS) { console.log(`time budget used up after ${cands.indexOf(p)} candidates`); break; }
  const log = (m) => console.log(`  #${p.candidate} ${p.headline.slice(0, 50)}: ${m}`);
  const r = await officialPhoto(ctx, p.meta.facts, { seen: imgSeen }, log).catch((e) => { log('failed: ' + String(e.message || e).slice(0, 80)); return null; });
  p.officialChecked = true;   // render.mjs does not search again
  if (!r) continue;
  // two posts the same day: different sector or country, like generate.mjs's strict pass
  if (hits.some((h) => h.meta.sector === p.meta.sector && h.meta.country === p.meta.country)) { log('photo found, but same sector and country as an earlier pick'); continue; }
  const file = `official-${p.candidate}.jpg`;
  writeFileSync(join(IMG, file), r.jpeg);
  p.officialPhoto = { file, url: r.url, mime: r.mime, w: r.w, h: r.h, credit: r.credit, note: r.note, page: r.page };
  hits.push(p);
  log(`HIT ${r.note}`);
}
await closeOcr();
await browser.close();

// keep the photo posts, top up by rank, then put them back in rank order for the slots
const kept = [...hits, ...cands.filter((p) => !hits.includes(p))].slice(0, N).sort((a, b) => a.candidate - b.candidate);
for (const f of files) { const p = JSON.parse(readFileSync(join(DIR, f), 'utf8')); if (p.candidate) rmSync(join(DIR, f)); }
kept.forEach((p, k) => {
  const slot = A.slotsUtc[k % A.slotsUtc.length];
  Object.assign(p, { id: `infra-${k + 1}`, scheduledAtUtc: `${DATE}T${slot}:00Z` });
  p.rank = p.candidate; delete p.candidate;
  writeFileSync(join(DIR, p.id + '.json'), JSON.stringify(p, null, 2));
});
for (const p of cands) if (!kept.includes(p) && p.officialPhoto) rmSync(join(IMG, p.officialPhoto.file), { force: true });

const STATE_FILE = join(HERE, 'state', 'used.json');
const used = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')).urls || [] : [];
writeFileSync(STATE_FILE, JSON.stringify({ urls: [...new Set([...used, ...kept.map((p) => p.sourceUrl).filter(Boolean)])].slice(-600) }, null, 2));
console.log(`Checked ${cands.filter((p) => p.officialChecked).length} of ${cands.length} candidates, ${hits.length} official photo(s). Kept: ${kept.map((p) => `${p.id} = #${p.rank}${p.officialPhoto ? ' (photo)' : ' (fact card)'} ${p.headline}`).join(' | ')}`);
