// Books the next queued Commodity Decoded video (same R2 queue as LinkedIn / Instagram) onto Buffer as a Pinterest video pin on the
// "Commodity Decoded" board, with the pin link pointing at the free weekly newsletter page (owner 2026-10-06).
//
//   node push_pinterest.mjs --dry-run     # show what would happen, call nothing
//   node push_pinterest.mjs --check       # read-only: find the Buffer Pinterest channel, no post
//   node push_pinterest.mjs               # book ONE pin
//
// Same guardrails as push_video.mjs: pause switch (BOT_PAUSED / config.automation.paused / config.pinterest.paused) · own state
// state/pin_pushed.json (each video pinned at most once; entries can be pre-marked {skipped:true}) · one pin per UTC day, booked one day
// ahead at config.pinterest.slotUtc · only queue entries with status "queued" (held = stop) · video URL checked before Buffer sees it.
// Buffer account/key: the same BUFFER_API_KEY as the LinkedIn bot (that account holds the Pinterest channel "worldtradepro").
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const KEY = process.env.BUFFER_API_KEY || '';
const PC = cfg.pinterest || {};
const VQ = cfg.videoQueue || {};
const BASE = (process.env.VIDEO_QUEUE_BASE || VQ.publicBase || '').replace(/\/$/, '');
const BOARD = PC.boardServiceId || '832884593527622190';           // PinterestBoard.serviceId of "Commodity Decoded" (NOT Buffer's internal id)
const LINK = PC.url || 'https://worldtradepro.com/subscribe/';
const SLOT = PC.slotUtc || '16:30';
const CHANNEL_NAME = PC.channel || 'worldtradepro';
const GAP = ((cfg.buffer || {}).minGapMinutes ?? 180) * 60000;
const STATE_FILE = join(HERE, 'state', 'pin_pushed.json');
const log = (...a) => console.log(...a);
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (process.env.BOT_PAUSED === 'true' || cfg.automation?.paused || PC.paused) { log('Paused - nothing pushed.'); process.exit(0); }
if (!BASE) fail('videoQueue.publicBase (or env VIDEO_QUEUE_BASE) is not set.');
if (!DRY && !KEY) fail('BUFFER_API_KEY is not set.');

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { pushed: {} };
state.pushed ||= {};

async function gql(query, variables) {
  const r = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ query, variables }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) throw new Error(`Buffer API ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function pinterestChannel() {
  if (DRY) return 'DRY_CHANNEL_ID';
  const want = norm(CHANNEL_NAME);
  const orgs = (await gql('query { account { organizations { id } } }')).account.organizations;
  for (const o of orgs) {
    const chans = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
    const pin = chans.filter((c) => /pinterest/i.test(c.service));
    const hit = pin.find((c) => norm(c.name) === want) || pin[0];
    if (hit) return hit.id;
  }
  fail('Buffer Pinterest channel not found.');
}
async function duesFor(channelId) {
  if (DRY || !KEY) return [];
  const out = [];
  try {
    const orgs = (await gql('query { account { organizations { id } } }')).account.organizations;
    for (const o of orgs) {
      const d = await gql('query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 60) { edges { node { status dueAt channelId } } } }', { id: o.id });
      for (const { node: n } of d.posts?.edges || []) {
        const t = Date.parse(n.dueAt || '');
        if (n.channelId === channelId && /^(scheduled|sending|queued)/i.test(String(n.status || '')) && t) out.push(t);
      }
    }
  } catch (e) { log('  (could not read the Buffer schedule: ' + String(e.message).slice(0, 100) + ')'); }
  return out;
}
function placeAt(dues, wantedMs) {
  let t = Math.max(wantedMs, Date.now() + 15 * 60000);
  for (let i = 0; i < 60; i++) { const clash = dues.find((d) => Math.abs(d - t) < GAP); if (!clash) return t; t = clash + GAP; }
  return t;
}
async function videoOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0 wtp-linkedin-bot' } });
    return r.ok && /^video\//i.test(r.headers.get('content-type') || '') && Number(r.headers.get('content-length') || 0) > 100000;
  } catch { return false; }
}
// Pin description (Pinterest allows 500 chars): the hook + as many whole sentences of the first fact paragraph as fit, then the link line.
function pinText(caption) {
  const paras = String(caption || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tail = '\n\nFree weekly newsletter: worldtradepro.com/subscribe';
  let out = paras[0] || '';
  for (const p of paras.slice(1)) {
    if (/^(sources?|illustration|#)/i.test(p)) break;
    const next = out + '\n\n' + p;
    if (next.length + tail.length > 480) { // add whole sentences only
      let acc = out;
      for (const s of p.match(/[^.!?]+[.!?]+\s*/g) || []) { if ((acc + (acc === out ? '\n\n' : '') + s).length + tail.length > 480) break; acc += (acc === out ? '\n\n' : '') + s; }
      out = acc.trim(); break;
    }
    out = next;
  }
  return (out.slice(0, 480 - tail.length).trim() + tail);
}

if (CHECK) { const c = await pinterestChannel(); log(`Pinterest channel OK: ${c} · board ${BOARD} · link ${LINK}`); process.exit(0); }

// ---- read the queue (public URL, no credentials) and pick the next item
const qres = await fetch(`${BASE}/wtp/video_queue.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
if (!qres.ok) fail(`Cannot read the video queue (${qres.status}).`);
const queue = await qres.json();
const waiting = queue.filter((e) => e.status === 'queued' && !state.pushed[e.name]);
const next = waiting[0];
log(`Video queue: ${queue.length} item(s) · ${waiting.length} waiting for Pinterest${DRY ? ' · DRY RUN' : ''}`);
if (!next) { log('Nothing to push.'); process.exit(0); }

// Book one day ahead (same logic as push_video.mjs): earliest of today/tomorrow whose slot is >= 15 min away and has no pin yet.
const booked = new Set(Object.values(state.pushed).map((p) => String(p.dueAt || '').slice(0, 10)).filter(Boolean));
let wanted = null;
for (let k = 0; k <= 1 && wanted === null; k++) {
  const day = new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
  const t = Date.parse(`${day}T${SLOT}:00Z`);
  if (t >= Date.now() + 15 * 60000 && !booked.has(day)) wanted = t;
}
if (wanted === null) { log(`Today's and tomorrow's ${SLOT} UTC pin slots are already booked (or gone) - nothing to do.`); process.exit(0); }

if (!DRY && !(await videoOk(next.video_url))) fail(`Video URL is not a reachable video: ${next.video_url}`);
const channel = await pinterestChannel();
const dues = await duesFor(channel);
const placed = placeAt(dues, wanted);
const input = {
  text: pinText(next.caption), channelId: channel, schedulingType: 'automatic', mode: 'customScheduled', dueAt: new Date(placed).toISOString(),
  assets: [{ video: { url: next.video_url, metadata: { thumbnailOffset: 100 } } }],
  metadata: { pinterest: { boardServiceId: BOARD, title: String(next.title || next.name).slice(0, 100), url: LINK } },
};
log(`- ${next.name} -> Pinterest board ${BOARD} · link ${LINK} · placed ${input.dueAt}`);
if (DRY) { log(JSON.stringify({ ...input, text: input.text }, null, 1)); process.exit(0); }

const MUT = `mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`;
const res = (await gql(MUT, { input })).createPost;
if (res.__typename !== 'PostActionSuccess') fail(`${res.__typename}: ${res.message || ''}`);
state.pushed[next.name] = { postId: res.post.id, at: new Date().toISOString(), dueAt: res.post.dueAt || null };
mkdirSync(dirname(STATE_FILE), { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
log(`OK -> Buffer pin ${res.post.id} · due ${res.post.dueAt}`);
