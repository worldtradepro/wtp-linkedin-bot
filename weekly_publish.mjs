// Monday step of Trade Flow Weekly: unless the owner pressed "Hold",
//   1) POST <site>/wp-json/wtp/v1/insights/publish -> the draft goes live (edits made in WP are kept) + forum thread
//   2) Buffer: the PDF document post on the main LinkedIn page at weeklyReport.linkedinSlotUtc (07:30 UTC)
// Idempotent: a re-run skips what is already done (state/weekly.json).
// Env: WTP_PUBLISH_KEY, BUFFER_API_KEY. Usage: node weekly_publish.mjs --date YYYY-MM-DD

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const STATE = join(HERE, 'state', 'weekly.json');
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const S = state[DATE];
if (!S) { console.error(`nothing staged for ${DATE} (Sunday step did not run?)`); process.exit(1); }
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// 1) website + forum
const r = await fetch(`${cfg.site}/wp-json/wtp/v1/insights/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wtp-publish-key': process.env.WTP_PUBLISH_KEY, 'user-agent': 'wtp-linkedin-bot/1.0' }, body: JSON.stringify({ slug: S.slug }) });
const res = await r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
if (!r.ok) throw new Error(`publish failed (${r.status}): ${JSON.stringify(res).slice(0, 300)}`);
if (res.held) { console.log(`HELD by the owner - nothing published (post ${res.id}).`); S.held = true; save(); process.exit(0); }
S.publishedAt ||= new Date().toISOString(); S.url = res.url; S.forumTopic = res.forum_topic;
save();
console.log(`published ${res.url} · forum topic ${res.forum_topic}`);

// 2) LinkedIn via Buffer
if (S.bufferPostId) { console.log('Buffer post already created:', S.bufferPostId); process.exit(0); }
const KEY = process.env.BUFFER_API_KEY;
async function gql(query, variables) {
  const x = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ query, variables }) });
  const b = await x.json().catch(() => ({}));
  if (!x.ok || b.errors) throw new Error(`Buffer API ${x.status}: ${JSON.stringify(b.errors || b).slice(0, 300)}`);
  return b.data;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let channel = null;
for (const o of (await gql('query { account { organizations { id } } }')).account.organizations) {
  const cs = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
  channel ||= cs.find((c) => c.service === 'linkedin' && norm(c.name) === norm('worldtradepro.com'));
}
if (!channel) throw new Error('main LinkedIn channel not found in Buffer');
const slot = Date.parse(`${DATE}T${cfg.weeklyReport?.linkedinSlotUtc || '07:30'}:00Z`);
const due = new Date(Math.max(slot, Date.now() + 10 * 60000));   // a late run posts 10 minutes from now instead
const input = { text: S.caption, channelId: channel.id, schedulingType: 'automatic', mode: 'customScheduled', dueAt: due.toISOString(),
  assets: [{ document: { url: S.pdfUrl, thumbnailUrl: S.coverUrl, title: S.docTitle } }] };
const out = (await gql(`mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`, { input })).createPost;
if (out.__typename !== 'PostActionSuccess') throw new Error(`Buffer: ${out.__typename} ${out.message || ''}`);
S.bufferPostId = out.post.id; S.bufferDueAt = out.post.dueAt;
save();
console.log(`LinkedIn document post queued in Buffer: ${out.post.id} due ${out.post.dueAt}`);
