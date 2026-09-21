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

const warn = (m) => console.log(`::warning::sharecards: ${m}`);

function makeCard(format, id, pickUrls) {
  const out = join(HERE, 'queue', DATE, '_share', id);
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
  const meta = JSON.parse(readFileSync(join(out, readdirSync(out).find((f) => f.endsWith('.json') && f !== 'picks.json')), 'utf8'));
  return { png: join(out, meta.file), caption: meta.caption, link: meta.link };
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

// ---- main account: Trade Flow flash (weekdays) / weekly (Mondays) ----
const flashSlot = A.main.flashCardSlotUtc, weeklySlot = A.main.weeklyCardSlotUtc;
if (flashSlot && !isWeekend) {
  const c = makeCard('flash', 'main-card-flash', null);
  if (c) mainPost('main-card-flash', 'flash', flashSlot, 'Trade Flow daily flash', c); else warn('Trade Flow daily flash could not be made - not posted today');
}
if (weeklySlot && isMonday) {
  const c = makeCard('weekly', 'main-card-weekly', null);
  if (c) mainPost('main-card-weekly', 'weekly', weeklySlot, 'Trade Flow weekly update', c); else warn('Trade Flow weekly update could not be made - not posted today');
}

// ---- infra: replace the hand-drawn daily card image with the map's projects card (same projects as the post text) ----
const infraFile = join(DIR, 'infra-card-daily.json');
if (existsSync(infraFile)) {
  const p = JSON.parse(readFileSync(infraFile, 'utf8'));
  if (p.shareFormat === 'projects' && p.pickUrls?.length) {
    if (!process.env.WTP_BOT_SECRET) warn('WTP_BOT_SECRET missing - keeping the hand-drawn Infrastructure card');
    else {
      const c = makeCard('projects', 'infra-card-daily', p.pickUrls);
      if (c) {
        copyFileSync(c.png, join(IMG, 'infra-card-daily.png'));
        p.renderNote = 'Intelligence Map share card (projects)';
        writeFileSync(infraFile, JSON.stringify(p, null, 2));
        console.log('infra-card-daily: image replaced by the map projects card');
      } else warn('Infrastructure map card could not be made - keeping the hand-drawn card');
    }
  }
}
