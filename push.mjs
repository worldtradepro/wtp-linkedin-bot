// Sends the day's finished queue (queue/YYYY-MM-DD/*.json + images) to Buffer through Buffer's official GraphQL API.
//
//   node push.mjs [--date YYYY-MM-DD] [--dry]
//
// Env:   BUFFER_API_KEY   (secret - create it yourself at publish.buffer.com/settings/api; never commit it)
//        IMAGE_BASE_URL   public base URL where the day's own card PNGs are hosted, e.g. https://raw.githubusercontent.com/OWNER/REPO/images
//        BOT_PAUSED=true  pause switch (also config.automation.paused)
//
// Guardrails: pause switch · per-account daily cap · every post pushed at most once (state/pushed.json) · image URL checked before use ·
// non-zero exit code on ANY failure or when nothing at all could be pushed (so the GitHub run turns red and GitHub e-mails you).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const KEY = process.env.BUFFER_API_KEY || '';
const IMAGE_BASE = (process.env.IMAGE_BASE_URL || '').replace(/\/$/, '');
const B = cfg.buffer || {};
const MODE = B.pushMode || 'draft';                         // "draft" = safe first runs · "schedule" = fully automatic
const CAP = B.maxPostsPerDay || { main: 4, infra: 5 };
const GAP = (B.minGapMinutes ?? 180) * 60000;               // minimum distance between two posts on the SAME LinkedIn page
const LATEST = B.latestSlotUtc || '19:30';                  // nothing is scheduled later than this (UTC) on its day - better skipped than crammed
const STATE_FILE = join(HERE, 'state', 'pushed.json');
const DIR = join(HERE, 'queue', DATE);

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error('ERROR: ' + msg); process.exit(1); };

if (process.env.BOT_PAUSED === 'true' || cfg.automation?.paused) { log('Paused (BOT_PAUSED / config.automation.paused) - nothing pushed.'); process.exit(0); }
if (!DRY && !KEY) fail('BUFFER_API_KEY is not set.');
if (!existsSync(DIR)) fail(`No queue folder for ${DATE} - generate.mjs / render.mjs produced nothing.`);

const posts = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
  .filter((p) => p.text && p.imagePath)                      // only posts that render.mjs finished
  .sort((a, b) => String(a.scheduledAtUtc).localeCompare(String(b.scheduledAtUtc)));
if (!posts.length) fail(`Queue ${DATE} has no finished posts.`);

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { pushed: {} };
state.pushed ||= {};

// ---------------------------------------------------------------- Buffer GraphQL
async function gql(query, variables) {
  const r = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) throw new Error(`Buffer API ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}

async function resolveChannels() {
  if (process.env.BUFFER_CHANNEL_MAIN && process.env.BUFFER_CHANNEL_INFRA) return { main: process.env.BUFFER_CHANNEL_MAIN, infra: process.env.BUFFER_CHANNEL_INFRA };
  if (DRY) return { main: 'DRY_MAIN_CHANNEL_ID', infra: 'DRY_INFRA_CHANNEL_ID' };
  const orgs = (await gql('query { account { organizations { id } } }')).account.organizations;
  const found = {};
  const seen = [];   // every channel this API key can see (names only) - printed when a channel is missing, so the log tells which Buffer account the key belongs to
  for (const o of orgs) {
    const chans = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
    for (const c of chans) seen.push(`${c.service}:${c.name}`);
    for (const acct of ['main', 'infra']) {
      // the API names channels like URL slugs ("worldtradepro-com"), the web app shows "worldtradepro.com": compare with dots/dashes/spaces/case ignored
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const want = norm((B.channels || {})[acct]);
      const li = chans.filter((c) => /linkedin/i.test(c.service));
      const hit = li.find((c) => norm(c.name) === want) || li.find((c) => want && norm(c.name).includes(want));
      if (hit && !found[acct]) found[acct] = hit.id;
    }
  }
  if (args.includes('--channels')) log(`Channels this API key can see (${orgs.length} organization(s)): ${seen.length ? seen.join(' | ') : '(none)'}\nMatched: main=${found.main ? 'yes' : 'NO'} · infra=${found.infra ? 'yes' : 'NO'}`);
  if (args.includes('--channels')) process.exit(found.main && found.infra ? 0 : 1);
  for (const acct of ['main', 'infra']) if (!found[acct]) fail(`Buffer channel for "${acct}" ("${(B.channels || {})[acct]}") not found. Organizations: ${orgs.length}. Channels this API key can see: ${seen.length ? seen.join(' | ') : '(none)'}. Check config.json -> buffer.channels, and that BUFFER_API_KEY was created in the Buffer account that owns these channels.`);
  return found;
}

// An image URL Buffer can fetch: check it from here first (content type + size), so a dead link never becomes a broken post.
async function imageOk(url, onlyWebSafe = false) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 wtp-linkedin-bot' } });
    const ct = r.headers.get('content-type') || '';
    const len = Number(r.headers.get('content-length') || 0);
    if (!r.ok) return false;
    // web-safe = jpeg/png/gif (some CDNs label their jpegs "application/octet-stream": accept those when the file name says .jpg/.png/.gif)
    const webSafe = /^image\/(jpeg|jpg|png|gif)/i.test(ct) || (ct === 'application/octet-stream' && /\.(jpe?g|png|gif)(\?|$)/i.test(url));
    if (onlyWebSafe && !webSafe) { if (r.body) await r.body.cancel(); return false; }
    if (/^image\//i.test(ct) || ct === 'application/octet-stream') { if (r.body) await r.body.cancel(); return len === 0 || len > 5000; }
    return false;
  } catch { return false; }
}

async function imageUrlFor(p) {
  // A photo is hot-linked from the publisher (we do not re-host others' pictures) - but only when it is a web-safe jpeg/png/gif that Buffer can fetch.
  if (p.imageKind === 'photo' && p.imageUrl && !p.imageRehost && await imageOk(p.imageUrl, true)) return p.imageUrl;
  if (!IMAGE_BASE) return DRY ? `https://example.invalid/${DATE}/${p.id}.${p.imageKind === 'photo' ? 'jpg' : 'png'}` : null;
  const url = `${IMAGE_BASE}/${DATE}/${p.id}.${p.imageKind === 'photo' ? 'jpg' : 'png'}`;
  for (let i = 0; i < 6; i++) { if (await imageOk(url)) return url; await new Promise((r) => setTimeout(r, 4000)); }   // raw.githubusercontent may lag a few seconds after the push
  return null;
}

// What is already scheduled in Buffer for our channels (so a late / repeated run never lands next to an existing post). Best effort:
// when Buffer's schedule cannot be read, spacing is still enforced against the posts of this run.
async function existingDues() {
  const map = {};
  if (DRY || !KEY) return map;
  try {
    const orgs = (await gql('query { account { organizations { id } } }')).account.organizations;
    for (const o of orgs) {
      const d = await gql('query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 60) { edges { node { status dueAt channelId } } } }', { id: o.id });
      for (const { node: n } of d.posts?.edges || []) {
        const t = Date.parse(n.dueAt || '');
        if (/^(scheduled|sending|queued)/i.test(String(n.status || '')) && t) (map[n.channelId] ||= []).push(t);
      }
    }
  } catch (e) { log('  (could not read the Buffer schedule - spacing only checked within this run: ' + String(e.message).slice(0, 120) + ')'); }
  return map;
}
// First free time >= wanted that is at least GAP away from every post already on that channel.
function placeAt(dues, wantedMs) {
  let t = Math.max(wantedMs, Date.now() + 15 * 60000);
  for (let i = 0; i < 60; i++) {
    const clash = dues.find((d) => Math.abs(d - t) < GAP);
    if (!clash) return t;
    t = clash + GAP;
  }
  return t;
}

const MUTATION = `mutation($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id dueAt } }
    ... on MutationError { message }
  }
}`;

// ---------------------------------------------------------------- run
const channels = await resolveChannels();
const duesByChannel = await existingDues();
const perAccount = {};
const results = { pushed: 0, skipped: 0, failed: 0 };
const now = Date.now();
log(`Buffer push ${DATE} · mode=${MODE}${DRY ? ' · DRY RUN' : ''} · ${posts.length} finished posts`);

for (const p of posts) {
  const key = `${DATE}:${p.id}`;
  if (state.pushed[key]) { log(`- ${p.id}: already pushed (${state.pushed[key]})`); results.skipped++; continue; }
  perAccount[p.account] = (perAccount[p.account] || 0) + 1;
  if (perAccount[p.account] > (CAP[p.account] ?? 4)) { log(`- ${p.id}: over the daily cap for ${p.account} - skipped`); results.skipped++; continue; }
  if (p.text.length > 2900) { console.error(`- ${p.id}: text too long (${p.text.length})`); results.failed++; continue; }

  const image = await imageUrlFor(p);
  if (!image) console.error(`  ! ${p.id}: no usable image URL - posting text only`);
  const ch = channels[p.account];
  const wanted = Date.parse(p.scheduledAtUtc);
  const dues = (duesByChannel[ch] ||= []);
  const placed = placeAt(dues, wanted);
  const cutoff = Date.parse(p.scheduledAtUtc.slice(0, 10) + 'T' + LATEST + ':00Z');
  if (MODE !== 'draft' && placed > cutoff) { log(`- ${p.id}: no room before ${LATEST} UTC with a ${GAP / 60000} min gap (wanted ${p.scheduledAtUtc.slice(11, 16)}) - skipped`); results.skipped++; continue; }
  const due = new Date(placed);
  if (Math.abs(placed - wanted) > 60000) log(`  ${p.id}: slot ${p.scheduledAtUtc.slice(11, 16)} -> ${due.toISOString().slice(11, 16)} UTC (keeping >= ${GAP / 60000} min from the other posts on this page)`);
  const input = { text: p.text, channelId: channels[p.account], schedulingType: 'automatic', assets: image ? [{ image: { url: image } }] : [] };
  if (MODE === 'draft') { input.mode = 'addToQueue'; input.saveToDraft = true; }
  else { input.mode = 'customScheduled'; input.dueAt = due.toISOString(); }   // always an explicit time: a late run is spaced by placeAt() instead of Buffer's next free slot

  dues.push(placed);
  if (DRY) { log(`- ${p.id} -> ${p.account}: ${JSON.stringify({ ...input, text: p.text.slice(0, 60).replace(/\n/g, ' ') + '…' })}`); results.pushed++; continue; }
  try {
    const res = (await gql(MUTATION, { input })).createPost;
    if (res.__typename === 'PostActionSuccess') {
      state.pushed[key] = res.post.id; results.pushed++;
      log(`- ${p.id}: OK -> ${res.post.id}${res.post.dueAt ? ' · due ' + res.post.dueAt : ''}`);
    } else { console.error(`- ${p.id}: ${res.__typename}: ${res.message || ''}`); results.failed++; }
  } catch (e) { console.error(`- ${p.id}: ${e.message}`); results.failed++; }
  await new Promise((r) => setTimeout(r, 700));
}

if (!DRY) { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
log(`Done: ${results.pushed} pushed · ${results.skipped} skipped · ${results.failed} failed`);
if (results.failed) process.exit(1);
if (!results.pushed && !results.skipped) fail('Nothing was pushed.');
