// Push one e-mail edition (built by newsletter.mjs) to Kit as a broadcast for that edition's subscribers.
//   Recipients = subscribers carrying the edition's tag (config.newsletter.kit.tags: weekly / daily), which
//   the site's signup box sets from the subscriber's own choice. Missing tags are created on first use.
//   config.newsletter.kit.mode = "draft"     -> saved as a draft in Kit, a human presses Send (safe first runs)
//                              = "schedule"  -> scheduled for the edition's sendTimeUtc (or in 10 minutes if that has passed)
// Needs env KIT_API_KEY (Kit -> Settings -> Developer -> API key v4). Kit adds the unsubscribe link + postal address footer.
// One broadcast per date and edition: state/newsletter.json remembers what was already pushed.
//
// Usage:  node kit_push.mjs [--edition weekly|daily] [--date YYYY-MM-DD] [--dry]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const kit = nl.kit;
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const EDITION = args.includes('--edition') ? args[args.indexOf('--edition') + 1] : 'weekly';
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-${EDITION}`;
const STATE = join(HERE, 'state', 'newsletter.json');
const API = 'https://api.kit.com/v4';

const meta = JSON.parse(readFileSync(join(HERE, 'newsletter', 'out', NAME + '.json'), 'utf8'));
if (meta.skip) { console.log(`${NAME}: marked skip (too few signals) - nothing sent`); process.exit(0); }
const page = readFileSync(join(HERE, 'newsletter', 'out', NAME + '.html'), 'utf8');
const content = (page.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, page])[1].trim();  // Kit wraps it in its own template

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
if (state[NAME]) { console.log(`already pushed ${NAME}: broadcast ${state[NAME].id} (${state[NAME].status}) - nothing to do`); process.exit(0); }

function sendAt() {
  if (kit.mode !== 'schedule') return null;
  const [h, m] = (nl[EDITION]?.sendTimeUtc || nl.sendTimeUtc).split(':').map(Number);
  const t = new Date(TODAY + 'T00:00:00Z'); t.setUTCHours(h, m);
  return new Date(Math.max(t.getTime(), Date.now() + 10 * 60e3)).toISOString();
}

const KEY = process.env.KIT_API_KEY;
async function kitFetch(path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { 'X-Kit-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Kit ${init.method || 'GET'} ${path} -> ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}
async function tagId(name) {
  let after = null;
  do {
    const j = await kitFetch('/tags?per_page=1000' + (after ? '&after=' + encodeURIComponent(after) : ''));
    const hit = (j.tags || []).find((t) => t.name === name);
    if (hit) return hit.id;
    after = j.pagination?.has_next_page ? j.pagination.end_cursor : null;
  } while (after);
  const made = await kitFetch('/tags', { method: 'POST', body: JSON.stringify({ name }) });
  console.log(`created Kit tag "${name}" (${made.tag?.id})`);
  return made.tag.id;
}

const tagName = kit.tags[EDITION];
const body = {
  subject: meta.subject,
  preview_text: meta.preview,
  description: `WTP ${EDITION} ${TODAY}`,
  content,
  public: false,
  send_at: sendAt(),
};

if (DRY) { console.log(JSON.stringify({ ...body, content: `<${content.length} chars>`, recipients: `tag "${tagName}"` }, null, 2)); process.exit(0); }
if (!KEY) { console.error('KIT_API_KEY is not set'); process.exit(1); }

body.subscriber_filter = [{ all: [{ type: 'tag', ids: [await tagId(tagName)] }] }];
const res = await kitFetch('/broadcasts', { method: 'POST', body: JSON.stringify(body) });
const b = res.broadcast || {};
state[NAME] = { id: b.id, status: body.send_at ? 'scheduled' : 'draft', send_at: body.send_at, subject: meta.subject, tag: tagName };
writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
console.log(`Kit broadcast ${b.id} created as ${state[NAME].status}${body.send_at ? ' for ' + body.send_at : ''} to tag "${tagName}": "${meta.subject}"`);
