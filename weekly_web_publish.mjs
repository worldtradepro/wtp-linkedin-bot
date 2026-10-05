// Publish the web issue (newsletter/out/<date>-weekly.wp.json from weekly_web.mjs) on the site, before the e-mail goes out,
// so every "All N projects" link in the e-mail lands on a live page. Two calls to the site's Insights API (snippet 67):
//   POST /wtp/v1/insights/stage   { slug, title, excerpt, content }   -> draft (409 if already published: fine, keep it)
//   POST /wtp/v1/insights/publish { slug }                             -> live (idempotent)
// Env: WTP_PUBLISH_KEY. Usage: node weekly_web_publish.mjs [--date YYYY-MM-DD]. Never fatal for the send: a failure
// only means the e-mail links fall back to a 404 until the next run, so the caller should log it loudly.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const KEY = process.env.WTP_PUBLISH_KEY;
if (!KEY) { console.log('::warning::WTP_PUBLISH_KEY missing - web issue not published'); process.exit(0); }
const wp = JSON.parse(readFileSync(join(HERE, 'newsletter', 'out', `${TODAY}-weekly.wp.json`), 'utf8'));
const call = async (path, body) => {
  const r = await fetch(`${cfg.site}/wp-json/wtp/v1/insights/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wtp-publish-key': KEY, 'user-agent': 'wtp-linkedin-bot/1.0' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
  return { status: r.status, ...j };
};
const s = await call('stage', { slug: wp.slug, title: wp.title, excerpt: wp.excerpt, content: wp.content, forum: { title: `${wp.title}`, html: `<p>${wp.excerpt}</p><p>Full issue: <a href="${wp.url}">${wp.url}</a></p>` } });
if (s.status === 409) console.log(`already published: ${s.url}`);
else if (s.status !== 200) { console.log(`::error::stage failed (${s.status}): ${JSON.stringify(s).slice(0, 300)}`); process.exit(1); }
else console.log(`staged draft ${s.id}`);
const p = await call('publish', { slug: wp.slug });
if (p.status !== 200 || p.held) { console.log(`::error::publish failed (${p.status}): ${JSON.stringify(p).slice(0, 300)}`); process.exit(1); }
console.log(`live: ${p.url}${p.forum_topic ? ` · forum topic ${p.forum_topic}` : ''}`);
