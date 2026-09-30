// Daily Scan, last step: the rendered carousel -> website media library -> Buffer document post.
//   1) POST <site>/wp-json/wtp/v1/insights/media (header X-WTP-Publish-Key): the site downloads carousel.pdf + cover.jpg from
//      the public images branch (raw.githubusercontent serves PDFs as octet-stream, which LinkedIn may reject) and returns
//      their media-library URLs.
//   2) Buffer createPost with a document asset on the page's channel at dailyScan.<series>.slotUtc (a late run posts 10 min from now).
// Idempotent: state/scan_pushed.json remembers the Buffer post per date + series.
// Env: WTP_PUBLISH_KEY, BUFFER_API_KEY, IMAGE_BASE_URL (public base of the images branch).
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

// 1) media library
const BASE = `${process.env.IMAGE_BASE_URL}/scan/${DATE}`;
const stem = `WorldTradePro-${SERIES === 'flow' ? 'Daily-Trade-Flow-Scan' : 'Daily-Project-Scan'}-${A.scanDay}`;
const r = await fetch(`${cfg.site}/wp-json/wtp/v1/insights/media`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-wtp-publish-key': process.env.WTP_PUBLISH_KEY, 'user-agent': 'wtp-linkedin-bot/1.0' },
  body: JSON.stringify({ assets: {
    pdf: { url: `${BASE}/${SERIES}.pdf`, filename: `${stem}.pdf`, title: A.docTitle },
    cover: { url: `${BASE}/${SERIES}-cover.jpg`, filename: `${stem}-cover.jpg`, alt: A.docTitle, title: A.docTitle + ' – cover' },
  } }),
});
const m = await r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
if (!r.ok || !m.media?.pdf?.url) throw new Error(`media upload failed (${r.status}): ${JSON.stringify(m).slice(0, 300)}`);
state[KEY_] = { pdfUrl: m.media.pdf.url, coverUrl: m.media.cover.url, issue: A.issue };
save();
console.log('media:', m.media.pdf.url, m.media.cover.url);
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
