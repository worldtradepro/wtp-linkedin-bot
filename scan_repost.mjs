// Daily Project Scan -> main page. The Infrastructure showcase page has few followers, so once the day's Project Scan is
// live on LinkedIn, the main page shares it: a short post with the scan's hook and the link to the original post
// (LinkedIn shows the post as a preview card, and readers can follow the Infrastructure page from there).
//   1) Buffer post of `${date}:infra` (state/scan_pushed.json) -> status + externalLink (the LinkedIn URL once sent)
//   2) not sent yet -> exit 0, a later run tries again; sent -> Buffer text post on the main page at dailyScan.infra.repostSlotUtc
//      (a late run posts 10 min from now). Idempotent: state[key].repost remembers it.
// Env: BUFFER_API_KEY.  Usage: node scan_repost.mjs [--date YYYY-MM-DD] [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const DS = cfg.dailyScan || {};
const args = process.argv.slice(2);
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const DRY = args.includes('--dry-run');
const STATE = join(HERE, 'state', 'scan_pushed.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const KEY = `${DATE}:infra`;
const S = state[KEY];
if (!S?.bufferPostId) { console.log(`${KEY}: no Project Scan queued - nothing to share`); process.exit(0); }
const DAYS = DS.infra?.repostDaysUtc;   // e.g. [2, 4] = Tue + Thu only; unset = every day
if (Array.isArray(DAYS) && !DAYS.includes(new Date(`${DATE}T12:00:00Z`).getUTCDay())) { console.log(`${KEY}: not a repost day (repostDaysUtc ${DAYS.join(',')}) - nothing shared`); process.exit(0); }
if (S.repost?.bufferPostId) { console.log(`${KEY}: already shared on the main page (${S.repost.bufferPostId})`); process.exit(0); }

const BKEY = process.env.BUFFER_API_KEY;
if (!BKEY) throw new Error('BUFFER_API_KEY missing');
async function gql(query, variables) {
  const x = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + BKEY }, body: JSON.stringify({ query, variables }) });
  const b = await x.json().catch(() => ({}));
  if (!x.ok || b.errors) throw new Error(`Buffer API ${x.status}: ${JSON.stringify(b.errors || b).slice(0, 300)}`);
  return b.data;
}

// 1) is the Project Scan live yet?
const post = (await gql('query($id: PostId!) { post(input: { id: $id }) { id status sentAt externalLink } }', { id: S.bufferPostId })).post;
console.log(`${KEY}: Buffer post ${post.id} status ${post.status}${post.externalLink ? ' -> ' + post.externalLink : ''}`);
if (!post.externalLink) { console.log('not live on LinkedIn yet - a later run shares it'); process.exit(0); }

// 2) the main page shares it
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const want = norm(cfg.buffer.channels.main);
let channel = null;
for (const o of (await gql('query { account { organizations { id } } }')).account.organizations) {
  const cs = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id })).channels;
  channel ||= cs.find((c) => c.service === 'linkedin' && norm(c.name) === want);
}
if (!channel) throw new Error(`LinkedIn channel "${want}" not found in Buffer`);

const deals = S.tenders || S.awards ? `\n\nAlso inside: ${S.tenders || 0} open tenders and ${S.awards || 0} contract awards by industry.` : '\n\nAlso inside: the open tenders and contract awards by industry.';
const text = `🏗️ Today's Daily Project Scan #${S.issue} from our Infrastructure page${S.hook ? `\n\n${S.hook}` : ''}${deals}

Follow WorldTradePro Infrastructure & Supply Chain for tomorrow's scan 👇
${post.externalLink}`;
const slot = Date.parse(`${DATE}T${DS.infra?.repostSlotUtc || '12:30'}:00Z`);
const due = new Date(Math.max(slot, Date.now() + 10 * 60000));
if (DRY) { console.log(`DRY RUN - would queue on ${channel.name} at ${due.toISOString()}:\n${text}`); process.exit(0); }
const input = { text, channelId: channel.id, schedulingType: 'automatic', mode: 'customScheduled', dueAt: due.toISOString() };
const out = (await gql(`mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`, { input })).createPost;
if (out.__typename !== 'PostActionSuccess') throw new Error(`Buffer: ${out.__typename} ${out.message || ''}`);
S.repost = { bufferPostId: out.post.id, dueAt: out.post.dueAt, link: post.externalLink };
writeFileSync(STATE, JSON.stringify(state, null, 2));
console.log(`shared on ${channel.name}: ${out.post.id} due ${out.post.dueAt}`);
