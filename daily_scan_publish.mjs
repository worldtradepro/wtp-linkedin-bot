// Daily Scan, last step: the rendered carousel (already on the images branch) -> Buffer document post.
//   1) jsDelivr URLs of carousel.pdf + cover.jpg (raw.githubusercontent serves PDFs as octet-stream, which LinkedIn may reject;
//      jsDelivr serves application/pdf), checked before use.
//   2) Buffer createPost with a document asset on the page's channel at dailyScan.<series>.slotUtc (a late run posts 10 min from now).
// Idempotent: state/scan_pushed.json remembers the Buffer post per date + series.
// Env: BUFFER_API_KEY, IMAGES_SHA (commit on the images branch that holds the files), GITHUB_REPOSITORY.
// Usage: node daily_scan_publish.mjs --series flow|infra [--date YYYY-MM-DD]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const DS = cfg.dailyScan || {};
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SERIES = arg('--series', 'flow');
const DATE = arg('--date', new Date().toISOString().slice(0, 10));
const OUT = join(HERE, 'reports', 'out', `${DATE}-scan-${SERIES}`);
const STATE = join(HERE, 'state', 'scan_pushed.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const KEY_ = `${DATE}:${SERIES}`;
if (state[KEY_]?.bufferPostId) { console.log(`${KEY_}: already queued in Buffer (${state[KEY_].bufferPostId})`); process.exit(0); }
if (!existsSync(join(OUT, 'assets.json'))) { console.error(`nothing rendered for ${KEY_}`); process.exit(1); }
const A = JSON.parse(readFileSync(join(OUT, 'assets.json'), 'utf8'));
const save = () => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)); };

// 1) public URLs for Buffer/LinkedIn: jsDelivr serves the images-branch files with the right Content-Type (application/pdf),
//    pinned to the commit that added them (IMAGES_SHA), so no cache can serve an older file.
const BASE = `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY || 'worldtradepro/wtp-linkedin-bot'}@${process.env.IMAGES_SHA || 'images'}/scan/${DATE}`;
const pdfUrl = `${BASE}/${SERIES}.pdf`, coverUrl = `${BASE}/${SERIES}-cover.jpg`;
for (const [u, type] of [[pdfUrl, 'application/pdf'], [coverUrl, 'image/jpeg']]) {
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    const h = await fetch(u, { method: 'HEAD' }).catch(() => null);
    ok = !!h && h.ok && (h.headers.get('content-type') || '').startsWith(type);
    if (!ok) await new Promise((r) => setTimeout(r, 8000));
  }
  if (!ok) throw new Error(`not reachable as ${type}: ${u}`);
}
state[KEY_] = { pdfUrl, coverUrl, issue: A.issue, scanDay: A.scanDay, pickIds: A.pickIds || [], listIds: A.listIds || [] };
save();
console.log('files:', pdfUrl, coverUrl);
if (args.includes('--no-buffer')) { delete state[KEY_]; save(); console.log('dry run: not queued in Buffer'); process.exit(0); }

// 2) Buffer
const BKEY = process.env.BUFFER_API_KEY;
async function gql(query, variables) {
  const x = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + BKEY }, body: JSON.stringify({ query, variables }) });
  const b = await x.json().catch(() => ({}));
  if (!x.ok || b.errors) throw new Error(`Buffer API ${x.status}: ${JSON.stringify(b.errors || b).slice(0, 300)}`);
  return b.data;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const want = norm(cfg.buffer.channels[SERIES === 'flow' ? 'main' : 'infra']);
let channel = null;
for (const o of (await gql('query { account { organizations { id } } }')).account.organizations) {
  const cs = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
  channel ||= cs.find((c) => c.service === 'linkedin' && norm(c.name) === want);
}
if (!channel) throw new Error(`LinkedIn channel "${want}" not found in Buffer`);
const slot = Date.parse(`${DATE}T${DS[SERIES]?.slotUtc || (SERIES === 'flow' ? '07:30' : '08:30')}:00Z`);
const due = new Date(Math.max(slot, Date.now() + 10 * 60000));
const input = { text: A.caption, channelId: channel.id, schedulingType: 'automatic', mode: 'customScheduled', dueAt: due.toISOString(),
  assets: [{ document: { url: state[KEY_].pdfUrl, thumbnailUrl: state[KEY_].coverUrl, title: A.docTitle } }] };
const out = (await gql(`mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`, { input })).createPost;
if (out.__typename !== 'PostActionSuccess') throw new Error(`Buffer: ${out.__typename} ${out.message || ''}`);
state[KEY_].bufferPostId = out.post.id; state[KEY_].dueAt = out.post.dueAt;
save();
console.log(`${SERIES_NAME()} queued in Buffer: ${out.post.id} due ${out.post.dueAt}`);
function SERIES_NAME() { return SERIES === 'flow' ? 'Daily Trade Flow Scan' : 'Daily Project Scan'; }
