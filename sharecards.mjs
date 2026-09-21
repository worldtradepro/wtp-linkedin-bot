// Step between render.mjs and the image publish: builds the day's "map cards" with the Intelligence Map's own
// Share card (see share_card.mjs) and adds / upgrades posts in queue/YYYY-MM-DD/:
//   main  : Trade Flow daily flash (weekdays)  +  weekly update (Mondays)   -> new posts main-card-flash / main-card-weekly
//   infra : the daily "new projects" post already exists (generate.mjs); its hand-drawn card is replaced by the
//           map's projects card showing exactly the projects named in the post text.
// A card that cannot be made never stops the day: a failed main card is simply not posted, a failed infra card keeps
// the hand-drawn image. Failures are printed as GitHub warnings.
//   node sharecards.mjs [--date YYYY-MM-DD]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const DIR = join(HERE, 'queue', DATE);
const IMG = join(DIR, 'images');
mkdirSync(IMG, { recursive: true });
const dow = new Date(DATE + 'T00:00:00Z').getUTCDay();
const isWeekend = dow === 0 || dow === 6;
const isMonday = dow === 1 || args.includes('--weekly');
const A = cfg.accounts;
const WHICH = process.env.REPOST_WHICH || 'both';   // repost-weekly workflow: both | main | infra

const warn = (m) => console.log(`::warning::sharecards: ${m}`);

function readCard(out) {
  const jf = existsSync(out) && readdirSync(out).find((f) => f.endsWith('.json') && f !== 'picks.json');
  if (!jf) return null;
  const meta = JSON.parse(readFileSync(join(out, jf), 'utf8'));
  return existsSync(join(out, meta.file)) ? { png: join(out, meta.file), caption: meta.caption, link: meta.link } : null;
}

function makeCard(format, id, pickUrls) {
  const out = join(HERE, 'queue', DATE, '_share', id);
  const done = readCard(out);
  if (done) { console.log(id + ': reusing the card made earlier today'); return done; }   // the flash card is made BEFORE generate.mjs (news posts avoid its stories)
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const env = { ...process.env, OUT_DIR: out };
  if (pickUrls && pickUrls.length) { const f = join(out, 'picks.json'); writeFileSync(f, JSON.stringify(pickUrls)); env.PICK_FILE = f; }
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {   // one retry: the shared host / CDNs occasionally hiccup
    r = spawnSync(process.execPath, [join(HERE, 'share_card.mjs'), format], { cwd: HERE, env, encoding: 'utf8', timeout: 240000 });
    if (r.status === 0) break;
    console.log(`${id}: attempt ${attempt} failed (exit ${r.status}) ${String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  }
  if (r.status !== 0) return null;
  return readCard(out);
}
function mainPost(id, format, slot, headline, card) {
  const p = {
    account: 'main', type: 'card', id, scheduledAtUtc: `${DATE}T${slot}:00Z`,
    headline, blocks: [card.caption], descIndex: 0, text: card.caption, firstComment: '',
    image: 'card', imageKind: 'card', imagePath: 'images/' + id + '.png', sourceUrl: null, sourceName: '',
    renderNote: 'Intelligence Map share card', meta: { format, link: card.link },
  };
  copyFileSync(card.png, join(IMG, id + '.png'));
  writeFileSync(join(DIR, id + '.json'), JSON.stringify(p, null, 2));
  console.log(`${id}: made (${format}) -> ${slot} UTC`);
}

// ---- --flash-only: run first in the workflow, so generate.mjs can keep the flash stories out of the news posts ----
if (args.includes('--flash-only')) {
  if (A.main.flashCardSlotUtc && !isWeekend && !isMonday) { if (!makeCard('flash', 'main-card-flash', null)) warn('Trade Flow daily flash could not be made (news posts will not avoid it)'); }
  process.exit(0);
}

// ---- main account: Trade Flow flash (weekdays) / weekly (Mondays) ----
const flashSlot = A.main.flashCardSlotUtc, weeklySlot = A.main.weeklyCardSlotUtc;
if (flashSlot && !isWeekend && !isMonday) {   // a weekly-card day (Monday) has no daily card
  const c = makeCard('flash', 'main-card-flash', null);
  if (c) mainPost('main-card-flash', 'flash', flashSlot, 'Trade Flow daily flash', c); else warn('Trade Flow daily flash could not be made - not posted today');
}
if (weeklySlot && isMonday && WHICH !== 'infra') {
  const c = makeCard('weekly', 'main-card-weekly', null);
  if (c) mainPost('main-card-weekly', 'weekly', weeklySlot, 'Trade Flow weekly update', c); else warn('Trade Flow weekly update could not be made - not posted today');
}

// ---- infra: replace the hand-drawn cards' images with the map's projects card (same projects as the post text) ----
for (const id of ['infra-card-daily', 'infra-card-weekly']) {
  if (WHICH === 'main') continue;
  const infraFile = join(DIR, id + '.json');
  if (!existsSync(infraFile)) continue;
  const p = JSON.parse(readFileSync(infraFile, 'utf8'));
  if (!p.shareFormat || !p.pickUrls?.length) continue;
  if (!process.env.WTP_BOT_SECRET) { warn('WTP_BOT_SECRET missing - keeping the hand-drawn Infrastructure card'); continue; }
  const c = makeCard(p.shareFormat, id, p.pickUrls);
  if (c) {
    copyFileSync(c.png, join(IMG, id + '.png'));
    p.renderNote = 'Intelligence Map share card (' + p.shareFormat + ')';
    writeFileSync(infraFile, JSON.stringify(p, null, 2));
    console.log(id + ': image replaced by the map card (' + p.shareFormat + ')');
  } else warn(id + ': map card could not be made - keeping the hand-drawn card');
}
