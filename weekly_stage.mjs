// Sunday step of Trade Flow Weekly: puts the rendered issue on the site as a DRAFT and mails the review to the owner.
//   needs: reports/out/<date>-flow/{assets.json, wp.json, forum.html, linkedin.txt} (weekly_report.mjs) and the files
//          already published under ASSET_BASE (the workflow copies them to branch "images", folder weekly/<slug>/)
//   POST <site>/wp-json/wtp/v1/insights/stage (header X-WTP-Publish-Key) -> draft post + media + hold/resume links
//   writes state/weekly.json[<date>] and sends the review mail (unless --no-mail)
// Env: WTP_PUBLISH_KEY, ASSET_BASE, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Usage: node weekly_stage.mjs --date YYYY-MM-DD [--no-mail]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail } from './ses_mail.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const DATE = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const OUT = join(HERE, 'reports', 'out', `${DATE}-flow`);
const KEY = process.env.WTP_PUBLISH_KEY, BASE = (process.env.ASSET_BASE || '').replace(/\/$/, '');
if (!KEY) throw new Error('WTP_PUBLISH_KEY missing');
if (!BASE) throw new Error('ASSET_BASE missing');
const man = JSON.parse(readFileSync(join(OUT, 'assets.json'), 'utf8'));
const wp = JSON.parse(readFileSync(join(OUT, 'wp.json'), 'utf8'));
const forumRaw = readFileSync(join(OUT, 'forum.html'), 'utf8');
const caption = readFileSync(join(OUT, 'linkedin.txt'), 'utf8');
const notes = JSON.parse(readFileSync(join(HERE, 'reports', 'notes', `${DATE}-flow.json`), 'utf8'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const payload = {
  slug: man.slug, title: wp.title, excerpt: wp.excerpt, content: wp.content, featured: 'hero', share: 'share',
  assets: Object.fromEntries(Object.entries(man.assets).map(([k, a]) => [k, { url: `${BASE}/${a.name}`, filename: a.name, alt: a.alt, title: `${man.docTitle} – ${k}` }])),
  forum: { title: (forumRaw.match(/<!-- title: (.*?) -->/) || [])[1], html: forumRaw.replace(/<!-- title: .*? -->\n?/, '') },
};
const r = await fetch(`${cfg.site}/wp-json/wtp/v1/insights/stage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wtp-publish-key': KEY, 'user-agent': 'wtp-linkedin-bot/1.0' }, body: JSON.stringify(payload) });
const res = await r.json().catch(() => ({ error: 'non-JSON reply, HTTP ' + r.status }));
if (!r.ok || !res.id) throw new Error(`stage failed (${r.status}): ${JSON.stringify(res).slice(0, 400)}`);
console.log(`draft ${res.id} staged: ${res.preview}`);

const STATE = join(HERE, 'state', 'weekly.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state[DATE] = { slug: man.slug, id: res.id, url: res.url, preview: res.preview, edit: res.edit, docTitle: man.docTitle,
  pdfUrl: res.media.pdf.url, coverUrl: res.media.cover.url, caption, stagedAt: new Date().toISOString() };
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, 2));

if (!args.includes('--no-mail')) {
  const warn = notes._check?.warnings || [];
  const box = (t, body) => `<div style="border:1px solid #e4e7ec;border-radius:8px;padding:12px 16px;margin:14px 0"><b>${t}</b><div style="margin-top:6px">${body}</div></div>`;
  const btn = (label, href, bg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:6px;margin:4px 8px 4px 0">${label}</a>`;
  const html = `<div style="font:15px/1.55 Segoe UI,Arial,sans-serif;color:#101828;max-width:640px">
<p style="color:#667085;margin:0">Trade Flow Weekly · Week ${man.week}, ${man.year} — review</p>
<h2 style="margin:6px 0 4px">${esc(wp.title)}</h2><p style="margin:0 0 10px;color:#344054">${esc(wp.excerpt)}</p>
<p><b>Publishes automatically on Monday ${DATE} at about 07:00 UK time</b> (website, forum thread, LinkedIn at 08:30). Do nothing if it looks right.</p>
${warn.length ? box('⚠️ Please check (automatic fact-check)', '<ul style="margin:0;padding-left:18px">' + warn.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>') : box('✅ Automatic fact-check', 'Every link and number traces back to this week\'s sources.')}
<p>${btn('Preview the article', res.preview, '#0f2d5e')}${btn('Edit in WordPress', res.edit, '#475467')}${btn('Hold this issue', res.hold, '#b42318')}</p>
<p style="font-size:13px;color:#667085">Edits you make to the WordPress draft are kept when it publishes. "Hold" stops the website, forum and LinkedIn posts; <a href="${esc(res.resume)}">resume</a> undoes it. The preview needs you to be logged in to WordPress.</p>
${box('LinkedIn document post (main page, Monday 07:30 UTC)', `<p style="margin:0 0 6px"><a href="${esc(res.media.pdf.url)}">Open the PDF (7 pages)</a></p><pre style="white-space:pre-wrap;font:13px/1.5 Segoe UI,Arial,sans-serif;margin:0">${esc(caption)}</pre>`)}
${box('Forum thread (Global Commodity Radar, as chief_editor)', `<p style="margin:0 0 6px"><b>${esc(payload.forum.title)}</b></p>${payload.forum.html}`)}
<p style="font-size:12px;color:#98a2b3">Written by ${esc(notes._generated?.model || 'the model')} from ${Object.keys(JSON.parse(readFileSync(join(OUT, 'data.json'), 'utf8')).clusters || {}).length} story clusters; checked by weekly_notes.mjs.</p></div>`;
  const m = await sendMail({ to: cfg.weeklyReport?.reviewTo || cfg.newsletter.ses.replyTo, subject: `Review: Trade Flow Weekly W${man.week}${warn.length ? ` (${warn.length} to check)` : ''} — publishes Mon ~07:00 UK`, html });
  console.log('review mail sent', m.MessageId || '');
}
