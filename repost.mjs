// Re-post the WEEKLY cards outside the daily run (used by the repost-weekly workflow).
//   node repost.mjs prune     -> after generate.mjs --weekly: keep only the Infrastructure weekly post (the rest of the day's queue is dropped)
//   node repost.mjs finalize  -> after render + sharecards: give the posts fresh ids / image names (so Buffer state and the CDN cache treat
//                                them as new) and set the publish time
// Env: REPOST_WHICH = both | main | infra   REPOST_AT = "now" (in ~20 min) or "HH:MM" UTC today
import { readFileSync, writeFileSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WHICH = process.env.REPOST_WHICH || 'both';
const AT = (process.env.REPOST_AT || 'now').trim();
const DATE = new Date().toISOString().slice(0, 10);
const DIR = join(HERE, 'queue', DATE);
const phase = process.argv[2];

if (phase === 'prune') {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    if (f === 'infra-card-weekly.json' && WHICH !== 'main') continue;
    rmSync(join(DIR, f));
  }
  console.log('kept:', readdirSync(DIR).filter((f) => f.endsWith('.json')).join(', ') || '(none - main weekly is made by sharecards.mjs)');
} else if (phase === 'finalize') {
  const now = Date.now();
  let due = now + 20 * 60 * 1000;
  const m = /^(d{1,2}):(d{2})$/.exec(AT);
  if (m) { const t = Date.parse(DATE + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00Z'); if (t > now + 15 * 60 * 1000) due = t; }
  const tag = 'r' + new Date(now).toISOString().slice(11, 16).replace(':', '');
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) { console.error('nothing to repost'); process.exit(1); }
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    if (!/weekly/.test(p.id)) { rmSync(join(DIR, f)); continue; }
    const old = p.id;
    p.id = old + '-' + tag;
    p.imagePath = 'images/' + p.id + '.png';
    p.scheduledAtUtc = new Date(due).toISOString();
    if (existsSync(join(DIR, 'images', old + '.png'))) renameSync(join(DIR, 'images', old + '.png'), join(DIR, 'images', p.id + '.png'));
    writeFileSync(join(DIR, p.id + '.json'), JSON.stringify(p, null, 2));
    rmSync(join(DIR, f));
    console.log(old + ' -> ' + p.id + ' at ' + p.scheduledAtUtc);
  }
} else { console.error('usage: node repost.mjs prune|finalize'); process.exit(1); }
