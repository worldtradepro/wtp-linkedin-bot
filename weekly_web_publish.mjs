// Publish the web issue (newsletter/out/<date>-weekly.wp.json from weekly_web.mjs) on the site, before the e-mail goes out,
// so every "All N projects" link in the e-mail lands on a live page. Two calls to the site's Insights API (snippet 67):
//   POST /wtp/v1/insights/stage   { slug, title, excerpt, content }   -> draft (409 if already published: fine, keep it)
//   POST /wtp/v1/insights/publish { slug }                             -> live (idempotent)
// Env: WTP_PUBLISH_KEY. Usage: node weekly_web_publish.mjs [--date YYYY-MM-DD]. Never fatal for the send: a failure
// only means the e-mail links fall back to a 404 until the next run, so the caller should log it loudly.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteFetch } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const KEY = process.env.WTP_PUBLISH_KEY;
if (!KEY) { console.log('::warning::WTP_PUBLISH_KEY missing - web issue not published'); process.exit(0); }
const wp = JSON.parse(readFileSync(join(HERE, 'newsletter', 'out', `${TODAY}-weekly.wp.json`), 'utf8'));
const call = async (path, body) => {
  const r = await siteFetch(`${cfg.site}/wp-json/wtp/v1/insights/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wtp-publish-key': KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
  return { http: r.status, body: j };   // the API's own "status" field ("draft") must not shadow the HTTP status
};
const s = await call('stage', { slug: wp.slug, title: wp.title, excerpt: wp.excerpt, content: wp.content, forum: { title: `${wp.title}`, html: `<p>${wp.excerpt}</p><p>Full issue: <a href="${wp.url}">${wp.url}</a></p>` } });
if (s.http === 409) console.log(`already published: ${s.body.url}`);
else if (s.http !== 200) { console.log(`::error::stage failed (HTTP ${s.http}): ${JSON.stringify(s.body).slice(0, 300)}`); process.exit(1); }
else console.log(`staged draft ${s.body.id}`);
const p = await call('publish', { slug: wp.slug });
if (p.http !== 200 || p.body.held) { console.log(`::error::publish failed (HTTP ${p.http}): ${JSON.stringify(p.body).slice(0, 300)}`); process.exit(1); }
console.log(`live: ${p.body.url}${p.body.forum_topic ? ` · forum topic ${p.body.forum_topic}` : ''}`);
