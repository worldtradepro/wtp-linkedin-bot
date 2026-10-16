// Swaps the video of an already-booked (not yet sent) Buffer post, keeping its text, due time and Pinterest board/title/link.
// editPost is not a sparse patch (omitted fields are cleared), so everything is read first and sent back unchanged except the video URL.
//   node swap_video.mjs <postId> <newVideoUrl|keep> [--due 2026-10-17T12:00:00Z] [--go]      (without --go: read-only; 'keep' = keep the current video)
const KEY = process.env.BUFFER_API_KEY || '';
if (!KEY) { console.error('BUFFER_API_KEY missing'); process.exit(1); }
let [id, url] = process.argv.slice(2); const GO = process.argv.includes('--go');
const di = process.argv.indexOf('--due'); const DUE = di > 0 ? new Date(process.argv[di + 1]).toISOString() : null;
if (!id || !url) { console.error('usage: node swap_video.mjs <postId> <newVideoUrl> [--go]'); process.exit(1); }
const gql = async (query, variables) => (await fetch('https://api.buffer.com', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify({ query, variables }) })).json();
const r = await gql(`query($id: PostId!) { post(input: { id: $id }) { id status dueAt text channelService schedulingType
  assets { __typename source ... on VideoAsset { thumbnail } }
  metadata { __typename ... on PinterestPostMetadata { title url board { serviceId name } } } } }`, { id });
const p = r?.data?.post;
if (!p) { console.error('read failed:', JSON.stringify(r).slice(0, 400)); process.exit(1); }
if (url === 'keep') url = (p.assets || [])[0]?.source;
console.log(`post ${p.id} · ${p.channelService} · ${p.status} · due ${p.dueAt}\n  now: ${(p.assets || []).map((a) => a.source).join(', ')}\n  new: ${url}${DUE ? ' · due -> ' + DUE : ''}`);
if (p.status !== 'scheduled' && p.status !== 'draft') { console.error('not a pending post - nothing changed'); process.exit(1); }
const input = { id: p.id, text: p.text, dueAt: DUE || p.dueAt, mode: 'customScheduled', schedulingType: p.schedulingType || 'automatic',
  assets: [{ video: { url, metadata: { thumbnailOffset: 100 } } }] };
if (p.metadata?.__typename === 'PinterestPostMetadata') input.metadata = { pinterest: { boardServiceId: p.metadata.board.serviceId, title: p.metadata.title, url: p.metadata.url } };
if (!GO) { console.log('dry run, would send:', JSON.stringify({ ...input, text: input.text.slice(0, 60) + '…' })); process.exit(0); }
const e = await gql(`mutation($input: EditPostInput!) { editPost(input: $input) { __typename ... on PostActionSuccess { post { id dueAt status } } ... on MutationError { message } } }`, { input });
console.log(JSON.stringify(e?.data?.editPost || e));
