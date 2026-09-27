// Can Buffer's API post a LinkedIn PDF document (the weekly carousel) on our plan?
//   default (read-only): dumps the GraphQL input types behind createPost's assets, so we see the document fields.
//   PROBE_DRAFT=1: also creates ONE Buffer DRAFT (saveToDraft, never published) on the main LinkedIn channel with the
//                  PDF from PROBE_PDF_URL + thumbnail PROBE_THUMB_URL, and records Buffer's answer. Delete the draft in Buffer after.
// Writes buffer_doc_probe/result.json (no keys, no post text beyond the title).
import fs from 'node:fs';

const KEY = process.env.BUFFER_API_KEY || '';
if (!KEY) { console.error('BUFFER_API_KEY missing'); process.exit(1); }
fs.mkdirSync('buffer_doc_probe', { recursive: true });
const out = { at: new Date().toISOString() };
const save = () => fs.writeFileSync('buffer_doc_probe/result.json', JSON.stringify(out, null, 2));

async function gql(query, variables) {
  const r = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ query, variables }) });
  return r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
}
const typeName = (t) => (t ? (t.kind === 'NON_NULL' ? typeName(t.ofType) + '!' : t.kind === 'LIST' ? '[' + typeName(t.ofType) + ']' : t.name) : '?');
const TYPE_Q = `query($n: String!) { __type(name: $n) { name kind inputFields { name description type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } enumValues { name } fields { name } } }`;

// walk the input types reachable from CreatePostInput (depth-limited), keep the ones about assets / documents / metadata
const seen = {}, queue = ['CreatePostInput'];
while (queue.length && Object.keys(seen).length < 40) {
  const n = queue.shift(); if (seen[n]) continue;
  const t = (await gql(TYPE_Q, { n }))?.data?.__type;
  if (!t) { seen[n] = null; continue; }
  seen[n] = t.inputFields ? t.inputFields.map((f) => `${f.name}: ${typeName(f.type)}${f.description ? '  // ' + f.description.slice(0, 120) : ''}`) : t.enumValues ? t.enumValues.map((e) => e.name) : [];
  for (const f of t.inputFields || []) {
    let x = f.type; while (x.ofType) x = x.ofType;
    if (x.name && /Input$|Metadata|Asset|Document|Linkedin|LinkedIn|Enum|Type$|Mode$/i.test(x.name) && !seen[x.name]) queue.push(x.name);
  }
}
out.types = seen;
out.documentSupported = Object.keys(seen).some((n) => /document/i.test(n)) || Object.values(seen).some((v) => (v || []).some((l) => /^document/i.test(l)));
save();
console.log('document asset in schema:', out.documentSupported);
for (const [n, v] of Object.entries(seen)) if (v && /asset|document|createpost/i.test(n)) console.log(n, JSON.stringify(v, null, 1));

// inputs can also come from a committed file (so a push can run the draft test without the Actions UI)
try { const f = JSON.parse(fs.readFileSync('buffer_doc_probe_input.json', 'utf8')); if (f.draft === 1) { process.env.PROBE_DRAFT = '1'; process.env.PROBE_PDF_URL = f.pdf_url; process.env.PROBE_THUMB_URL = f.thumb_url; } } catch {}
// can a cloud machine (like Buffer's fetcher) download the files, or does Cloudflare answer with a challenge page?
if (process.env.PROBE_PDF_URL) {
  out.fetchFromCloud = {};
  for (const u of [process.env.PROBE_PDF_URL, process.env.PROBE_THUMB_URL]) {
    try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; bufferbot)' } }); const b = Buffer.from(await r.arrayBuffer());
      out.fetchFromCloud[u.split('/').pop()] = { status: r.status, type: r.headers.get('content-type'), bytes: b.length, looksPdf: b.slice(0, 5).toString() === '%PDF-', looksJpeg: b[0] === 0xff && b[1] === 0xd8 };
    } catch (e) { out.fetchFromCloud[u] = 'error ' + e.message; }
  }
  save();
  const ok = Object.values(out.fetchFromCloud).every((x) => x.status === 200 && (x.looksPdf || x.looksJpeg));
  if (!ok) { console.log('files NOT reachable from the cloud as real files - draft test skipped', JSON.stringify(out.fetchFromCloud)); process.env.PROBE_DRAFT = '0'; }
}

if (process.env.PROBE_DRAFT === '1') {
  const orgs = (await gql('query { account { organizations { id } } }'))?.data?.account?.organizations || [];
  let channel = null;
  for (const o of orgs) {
    const cs = (await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id }))?.data?.channels || [];
    channel = channel || cs.find((c) => c.service === 'linkedin' && /worldtradepro-com|worldtradepro\.com/i.test(c.name));
  }
  out.channel = channel && { name: channel.name, service: channel.service };
  if (!channel) { out.draft = 'main LinkedIn channel not found'; save(); process.exit(0); }
  const input = {
    text: '[TEST DRAFT - do not publish] Trade Flow Weekly · Week 39 document post via the API',
    channelId: channel.id, schedulingType: 'automatic', mode: 'addToQueue', saveToDraft: true,
    assets: [{ document: { url: process.env.PROBE_PDF_URL, thumbnailUrl: process.env.PROBE_THUMB_URL, title: 'Trade Flow Weekly · Week 39, 2026' } }],
  };
  const M = `mutation($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
  const r = await gql(M, { input });
  out.draft = { request: { ...input, channelId: '(main)', text: '(test)' }, response: r };
  save();
  console.log('draft result:', JSON.stringify(r));
}
