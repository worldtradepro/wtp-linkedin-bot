// Calls to our own site for radar_enrich.py, through the same siteFetch the other bot workflows use (Node fetch + Cloudflare allow header).
// stdin: {"method":"GET","path":"/wp-json/...","params":{...},"body":{...}}   stdout: {"status":200,"text":"..."}
import { siteFetch } from '../common.mjs';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { method = 'GET', path, params = {}, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const url = new URL('https://worldtradepro.com' + path);
for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
const init = { method, headers: { accept: 'application/json' } };
if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
const r = await siteFetch(url.toString(), init, 6);
process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() }));
