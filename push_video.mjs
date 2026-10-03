// Books the next queued video from the WTP video queue (Cloudflare R2, written by video_factory/pipeline/enqueue.py)
// onto Buffer as a LinkedIn video post, at the page's reserved video slot (config accounts.<acct>.videoSlotUtc).
//
//   node push_video.mjs --dry-run            # show what would happen, call nothing
//   node push_video.mjs                      # book ONE video (mode from config videoQueue.pushMode: "draft" | "schedule")
//
// Guardrails (same spirit as push.mjs): pause switch (BOT_PAUSED / config.automation.paused) · every video pushed at most once
// (state/video_pushed.json) · max one video per account per run · queue entries with status != "queued" are ignored ("held" = stop) ·
// the video URL is checked (HEAD: 200, video/*) before Buffer ever sees it · a late run is spaced from posts already on the page (placeAt).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const KEY = process.env.BUFFER_API_KEY || '';
const VQ = cfg.videoQueue || {};
const BASE = (process.env.VIDEO_QUEUE_BASE || VQ.publicBase || '').replace(/\/$/, '');
const MODE = VQ.pushMode || 'draft';                                  // "draft" = saved as a Buffer draft for a human to approve
const GAP = ((cfg.buffer || {}).minGapMinutes ?? 180) * 60000;
const STATE_FILE = join(HERE, 'state', 'video_pushed.json');
const log = (...a) => console.log(...a);
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (process.env.BOT_PAUSED === 'true' || cfg.automation?.paused || VQ.paused) { log('Paused - nothing pushed.'); process.exit(0); }
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
async function channelFor(acct) {
  if (DRY) return 'DRY_CHANNEL_ID';
  const want = norm((cfg.buffer.channels || {})[acct]);
  const orgs = (await gql('query { account { organizations { id } } }')).account.organizations;
  for (const o of orgs) {
    const chans = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
    const li = chans.filter((c) => /linkedin/i.test(c.service));
    const hit = li.find((c) => norm(c.name) === want) || li.find((c) => want && norm(c.name).includes(want));
    if (hit) return hit.id;
  }
  fail(`Buffer LinkedIn channel for "${acct}" not found.`);
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

// ---- read the queue (public URL, no credentials) and pick the next item
const qres = await fetch(`${BASE}/wtp/video_queue.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
if (!qres.ok) fail(`Cannot read the video queue (${qres.status}).`);
const queue = await qres.json();
const next = queue.find((e) => e.status === 'queued' && !state.pushed[e.name]);
log(`Video queue: ${queue.length} item(s) · ${queue.filter((e) => e.status === 'queued' && !state.pushed[e.name]).length} waiting · mode=${MODE}${DRY ? ' · DRY RUN' : ''}`);
if (!next) { log('Nothing to push.'); process.exit(0); }

const acct = next.account || 'main';
const slot = (cfg.accounts?.[acct] || {}).videoSlotUtc || '17:30';
// Book one day ahead: the earliest of today/tomorrow whose slot is still >= 15 min away and has no video yet (state dueAt).
// GitHub's scheduled runs can start hours late (2026-10-03: 09:23 cron ran at 14:21 and today's slot was lost), so
// tomorrow is always already booked by the time its slot comes; several runs a day are safe (a covered day is skipped).
const booked = new Set(Object.values(state.pushed).map((p) => String(p.dueAt || '').slice(0, 10)).filter(Boolean));
let wanted = null;
for (let k = 0; k <= 1 && wanted === null; k++) {
  const day = new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
  const t = Date.parse(`${day}T${slot}:00Z`);
  if (t >= Date.now() + 15 * 60000 && !booked.has(day)) wanted = t;
}
if (wanted === null) { log(`Today's and tomorrow's ${slot} UTC video slots are already booked (or gone) - nothing to do.`); process.exit(0); }

if (!DRY && !(await videoOk(next.video_url))) fail(`Video URL is not a reachable video: ${next.video_url}`);
const channel = await channelFor(acct);
const dues = await duesFor(channel);
const placed = placeAt(dues, wanted);
const input = { text: next.caption, channelId: channel, schedulingType: 'automatic',
  assets: [{ video: { url: next.video_url, metadata: { thumbnailOffset: 100 } } }] };
if (MODE === 'draft') { input.mode = 'addToQueue'; input.saveToDraft = true; }
else { input.mode = 'customScheduled'; input.dueAt = new Date(placed).toISOString(); }

log(`- ${next.name} -> ${acct} · slot ${slot} UTC · placed ${new Date(placed).toISOString()} · ${MODE}`);
if (DRY) { log(JSON.stringify({ ...input, text: input.text.slice(0, 70).replace(/\n/g, ' ') + '…' }, null, 1)); process.exit(0); }

const MUT = `mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`;
const res = (await gql(MUT, { input })).createPost;
if (res.__typename !== 'PostActionSuccess') fail(`${res.__typename}: ${res.message || ''}`);
state.pushed[next.name] = { postId: res.post.id, mode: MODE, at: new Date().toISOString(), dueAt: res.post.dueAt || null };
mkdirSync(dirname(STATE_FILE), { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
log(`OK -> Buffer post ${res.post.id}${res.post.dueAt ? ' · due ' + res.post.dueAt : ' (draft)'}`);
