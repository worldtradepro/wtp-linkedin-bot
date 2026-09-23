// Read-only: what does Buffer hold for our two LinkedIn channels (status + due time of each post)?
// Also dumps the parts of Buffer's GraphQL schema that describe posts, so the query can be corrected when it fails.
// Writes buffer_status/result.json (no post text beyond a 60-char preview, no keys). Nothing is created or changed.
import fs from 'node:fs';

const KEY = process.env.BUFFER_API_KEY || '';
if (!KEY) { console.error('BUFFER_API_KEY missing'); process.exit(1); }
fs.mkdirSync('buffer_status', { recursive: true });
const out = { at: new Date().toISOString(), tries: [] };

async function gql(query, variables) {
  const r = await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ query, variables }) });
  return r.json().catch(() => ({}));
}
const save = () => fs.writeFileSync('buffer_status/result.json', JSON.stringify(out, null, 2));

const orgs = (await gql('query { account { organizations { id } } }'))?.data?.account?.organizations || [];
out.orgs = orgs.length;
const channels = [];
for (const o of orgs) {
  const d = await gql('query($id: OrganizationId!) { channels(input: { organizationId: $id }) { id name service } }', { id: o.id });
  for (const c of d?.data?.channels || []) channels.push({ ...c, org: o.id });
}
out.channels = channels.map((c) => `${c.service}:${c.name}`);

// schema: the Query field that returns posts and its input types
const intro = await gql(`{ __type(name: "Query") { fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } } } }`);
out.queryFields = (intro?.data?.__type?.fields || []).map((f) => ({ name: f.name, args: f.args.map((a) => a.name + ':' + (a.type.name || a.type.ofType?.name || a.type.ofType?.ofType?.name)) }));
const typeNames = new Set();
for (const f of out.queryFields) if (/post/i.test(f.name)) for (const a of f.args) typeNames.add(a.split(':')[1]);
out.inputTypes = {};
for (const t of typeNames) {
  const d = await gql(`{ __type(name: "${t}") { inputFields { name type { name kind ofType { name kind ofType { name kind } } } } } }`);
  out.inputTypes[t] = (d?.data?.__type?.inputFields || []).map((f) => f.name + ':' + (f.type.name || f.type.ofType?.name || f.type.ofType?.ofType?.name));
}
save();

// best-guess queries; every attempt is recorded, whatever the outcome
for (const o of orgs) {
  const shapes = [
    { q: 'query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 100) { edges { node { id status dueAt channelId text } } } }' },
    { q: 'query($id: OrganizationId!) { posts(input: { organizationId: $id }) { edges { node { id status dueAt channelId text } } } }' },
    { q: 'query($id: OrganizationId!) { posts(input: { organizationId: $id }) { id status dueAt channelId text } }' },
  ];
  for (const s of shapes) {
    const d = await gql(s.q, { id: o.id });
    const conn = d?.data?.posts;
    const nodes = Array.isArray(conn) ? conn : (conn?.edges || []).map((e) => e.node);
    out.tries.push({ q: s.q.slice(0, 120), ok: !!conn, errors: d?.errors?.map((e) => e.message).slice(0, 2), n: nodes.length });
    if (conn) {
      const name = Object.fromEntries(channels.map((c) => [c.id, c.name]));
      out.posts = nodes.map((p) => ({ id: p.id, status: p.status, dueAt: p.dueAt, channel: name[p.channelId] || p.channelId, preview: String(p.text || '').replace(/\s+/g, ' ').slice(0, 60) }))
        .sort((a, b) => String(b.dueAt).localeCompare(String(a.dueAt)));
      break;
    }
  }
}
// Ask a real post node for its own __typename (much simpler/more reliable than walking the abstract schema),
// then dump that type's fields to find the image/media field name for a follow-up query.
let nodeTypeName = null;
for (const o of orgs) {
  const d = await gql('query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 1) { edges { node { __typename } } } }', { id: o.id });
  out.typenameTry = { errors: d?.errors?.map((e) => e.message).slice(0, 3) };
  nodeTypeName = d?.data?.posts?.edges?.[0]?.node?.__typename || null;
  if (nodeTypeName) break;
}
out.postNodeType = nodeTypeName;
save();

// Buffer's API disables __type/__schema introspection (empty fields even though __typename itself resolves) - guess a
// few plausible field names for a post's image instead, one real query per guess, and read the GraphQL validation
// error's "Cannot query field ... on type ..." wording to see which name Buffer actually accepts.
const IMG_FIELD_TRIES = [
  { field: 'assets', sub: '{ __typename ... on ImageAsset { url } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { source } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { uri } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { downloadUrl } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { originalUrl } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { permalink } }' },
  { field: 'assets', sub: '{ __typename ... on ImageAsset { thumbnail } }' },
];
out.imgFieldTries = [];
let workingField = null;
for (const o of orgs) {
  for (const t of IMG_FIELD_TRIES) {
    const d = await gql(`query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 1) { edges { node { id ${t.field} ${t.sub} } } } }`, { id: o.id });
    const ok = !d?.errors;
    out.imgFieldTries.push({ field: t.field, ok, errors: d?.errors?.map((e) => e.message).slice(0, 1) });
    if (ok) { workingField = t; break; }
  }
  if (workingField) break;
}
save();
if (workingField) {
  for (const o of orgs) {
    const d = await gql(`query($id: OrganizationId!) { posts(input: { organizationId: $id }, first: 100) { edges { node { id ${workingField.field} ${workingField.sub} } } } }`, { id: o.id });
    for (const n of (d?.data?.posts?.edges || []).map((e) => e.node)) {
      const p = (out.posts || []).find((x) => x.id === n.id);
      if (p) p.media = n[workingField.field];
    }
  }
}
save();
console.log(JSON.stringify({ channels: out.channels, tries: out.tries, posts: (out.posts || []).length, postFields: out.postFields, imgFieldTry: out.imgFieldTry }, null, 2));
