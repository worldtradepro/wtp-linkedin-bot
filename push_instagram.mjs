// Posts the next queued Commodity Decoded video (same R2 queue as push_video.mjs: wtp/video_queue.json) straight to
// Instagram as a Reel through the official "Instagram API with Instagram Login" - no Buffer. Same method as
// streetfood.com/tools/autopost/publish.js. The video already sits at a public R2 URL, so nothing is uploaded.
//
//   node push_instagram.mjs --check      # read-only: token works, belongs to IG_USER_ID, publishing quota
//   node push_instagram.mjs --dry-run    # show what would be posted, call nothing
//   node push_instagram.mjs              # post ONE Reel (only once per UTC day, only after config instagram.postUtc)
//
// Env (GitHub secrets): IG_WTP_USER_ID, IG_WTP_ACCESS_TOKEN (long-lived, 60 days, refreshed on every run;
// the rotated token is written back with `gh secret set` when SECRETS_PAT is available).
// Guardrails: pause switch (BOT_PAUSED / config.automation.paused / config.instagram.paused) - each video posted at most once
// (state/ig_pushed.json, separate from the LinkedIn state) - max one per UTC day - entries with status != "queued" are ignored
// ("held" = stop; the same hold that stops LinkedIn stops Instagram) - the video URL is HEAD-checked first.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const IGC = cfg.instagram || {};
const BASE = (process.env.VIDEO_QUEUE_BASE || (cfg.videoQueue || {}).publicBase || '').replace(/\/$/, '');
const POST_UTC = IGC.postUtc || '15:00';
const API = `https://graph.instagram.com/${process.env.IG_API_VERSION || 'v25.0'}`;
const STATE_FILE = join(HERE, 'state', 'ig_pushed.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (process.env.BOT_PAUSED === 'true' || cfg.automation?.paused || IGC.paused || (cfg.videoQueue || {}).paused) { log('Paused - nothing posted.'); process.exit(0); }
if (!BASE) fail('videoQueue.publicBase (or env VIDEO_QUEUE_BASE) is not set.');

let TOKEN = process.env.IG_WTP_ACCESS_TOKEN || '';
const IG = process.env.IG_WTP_USER_ID || '';
if (!DRY && (!TOKEN || !IG)) fail('IG_WTP_ACCESS_TOKEN / IG_WTP_USER_ID are not set.');

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { pushed: {} };
state.pushed ||= {};
const saveState = () => { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };

async function json(res, what) {
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

// Instagram long-lived tokens die after 60 days unless refreshed (allowed once the token is >= 24 h old).
async function refreshToken() {
  try {
    const r = await json(await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`), 'token refresh');
    if (r.access_token && r.access_token !== TOKEN) {
      TOKEN = r.access_token;
      if (process.env.SECRETS_PAT && process.env.GITHUB_REPOSITORY) {
        execFileSync('gh', ['secret', 'set', 'IG_WTP_ACCESS_TOKEN', '--repo', process.env.GITHUB_REPOSITORY], {
          input: TOKEN, stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, GH_TOKEN: process.env.SECRETS_PAT },
        });
        log('  token refreshed and saved to GitHub secrets');
      } else log('  token refreshed but SECRETS_PAT is not set: the new one is NOT saved (the old one stays valid for its 60 days)');
    }
  } catch (e) { log(`  ${String(e.message).slice(0, 160)} - keeping the current token`); }
}

async function check() {
  const me = await json(await fetch(`${API}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(TOKEN)}`), 'profile');
  if (String(me.user_id) !== String(IG)) throw new Error(`token belongs to @${me.username} (${me.user_id}), not IG_WTP_USER_ID`);
  const q = await json(await fetch(`${API}/${IG}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(TOKEN)}`), 'publishing limit');
  const d = (q.data || [])[0] || {};
  return `@${me.username} (${me.account_type}) · publishing quota used ${d.quota_usage ?? '?'}/${d.config?.quota_total ?? '?'}`;
}

async function videoOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0 wtp-instagram-bot' } });
    return r.ok && /^video\//i.test(r.headers.get('content-type') || '') && Number(r.headers.get('content-length') || 0) > 100000;
  } catch { return false; }
}

async function postReel(videoUrl, caption) {
  const c = await json(await fetch(`${API}/${IG}/media`, {
    method: 'POST',
    body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true', thumb_offset: '100', access_token: TOKEN }),
  }), 'create container');
  for (let i = 0; i < 15; i++) {
    await sleep(i ? 60000 : 20000);
    const s = await json(await fetch(`${API}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(TOKEN)}`), 'container status');
    if (s.status_code === 'FINISHED') {
      return (await json(await fetch(`${API}/${IG}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: TOKEN }) }), 'publish')).id;
    }
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`processing ${s.status_code}: ${s.status || ''}`);
  }
  throw new Error('video still processing after 15 minutes');
}

if (CHECK) {
  if (!TOKEN || !IG) fail('IG_WTP_ACCESS_TOKEN / IG_WTP_USER_ID are not set.');
  log('OK - ' + await check());
  process.exit(0);
}

// ---- pick the next video
const qres = await fetch(`${BASE}/wtp/video_queue.json?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
if (!qres.ok) fail(`Cannot read the video queue (${qres.status}).`);
const queue = await qres.json();
const waiting = queue.filter((e) => e.status === 'queued' && !state.pushed[e.name]);
log(`Video queue: ${queue.length} item(s) · ${waiting.length} waiting for Instagram${DRY ? ' · DRY RUN' : ''}`);
const next = waiting[0];
if (!next) { log('Nothing to post.'); process.exit(0); }

const now = new Date();
const today = now.toISOString().slice(0, 10);
if (Object.values(state.pushed).some((p) => String(p.at || '').slice(0, 10) === today)) { log(`Already posted today (${today}) - nothing to do.`); process.exit(0); }
if (!DRY && now < new Date(`${today}T${POST_UTC}:00Z`)) { log(`Before today's ${POST_UTC} UTC slot - nothing to do.`); process.exit(0); }

// Instagram: caption max 2200 chars, links are not clickable (LinkedIn caption is reused as is).
let caption = String(next.caption || '');
if (caption.length > 2200) caption = caption.slice(0, 2190).replace(/\s+\S*$/, '') + '…';

log(`- ${next.name} · ${next.video_url} · ${caption.length} chars`);
if (DRY) { log(caption.slice(0, 160).replace(/\n/g, ' ') + '…'); process.exit(0); }

if (!(await videoOk(next.video_url))) fail(`Video URL is not a reachable video: ${next.video_url}`);
await refreshToken();
log('  ' + await check());
const id = await postReel(next.video_url, caption);
state.pushed[next.name] = { mediaId: id, at: new Date().toISOString() };
saveState();
log(`OK -> Instagram media ${id}`);
