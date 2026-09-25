// Send one e-mail edition (built by newsletter.mjs) to its subscribers through Amazon SES (API v2).
//   Recipients: GET <site>/wp-json/wtp/v1/subscribers?edition=... (the site's own double-opt-in list,
//   snippet "WTP Newsletter"), one message each, with a personal unsubscribe link in the footer and
//   RFC 8058 one-click List-Unsubscribe headers (Gmail / Yahoo bulk-sender rules).
//   Before sending, checks SES's 24-hour quota; a run that would not fit is refused (the daily edition
//   is skipped with a warning, so the weekly one keeps its room).
//   Progress is written after every message (newsletter/out/<name>.sent.json), so a re-run after a
//   crash continues where it stopped instead of sending twice. This repo and its Actions logs are
//   PUBLIC: the progress file holds only keyed hashes (HMAC with WTP_BOT_SECRET), and logs never
//   print an address.
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (IAM user limited to SES sending), WTP_BOT_SECRET.
//
// Usage:  node ses_send.mjs [--edition weekly|daily] [--date YYYY-MM-DD] [--dry] [--to me@example.com]
//   --dry  list what would be sent        --to  send only to this one address (test; no state written)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const ses = nl.ses;
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const DRY = args.includes('--dry');
const ONLY = arg('--to');
const EDITION = arg('--edition') || 'weekly';
const TODAY = arg('--date') || new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-${EDITION}`;
const OUT = join(HERE, 'newsletter', 'out');
const STATE = join(HERE, 'state', 'newsletter.json');
const PROGRESS = join(OUT, NAME + '.sent.json');
const SITE = process.env.WTP_SITE || cfg.site;   // WTP_SITE: local WordPress for tests only

// ---------------------------------------------------------------- SigV4 (AWS Signature Version 4)
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest();
export function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}
export function signature(secret, day, region, service, stringToSign) {
  return createHmac('sha256', signingKey(secret, day, region, service)).update(stringToSign, 'utf8').digest('hex');
}
async function sesCall(method, path, body) {
  const region = process.env.AWS_REGION || ses.region;
  const host = `email.${region}.amazonaws.com`;
  const payload = body ? JSON.stringify(body) : '';
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amz.slice(0, 8);
  const scope = `${day}/${region}/ses/aws4_request`;
  const canonical = `${method}\n${path}\n\ncontent-type:application/json\nhost:${host}\nx-amz-date:${amz}\n\ncontent-type;host;x-amz-date\n${sha256(payload)}`;
  const sig = signature(process.env.AWS_SECRET_ACCESS_KEY, day, region, 'ses', `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(canonical)}`);
  const r = await fetch(`${process.env.SES_ENDPOINT || 'https://' + host}${path}`, {   // SES_ENDPOINT: local mock for tests only
    method, body: body ? payload : undefined,
    headers: { 'Content-Type': 'application/json', 'X-Amz-Date': amz,
      Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${sig}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SES ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------- message
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function footer(token) {
  const manage = `${SITE}/newsletter/unsubscribe/?t=${token}`;
  const why = EDITION === 'daily' ? 'the daily trade-flow brief' : 'the weekly summary';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 12px 28px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a2b3;">
    You get ${why} because you subscribed at worldtradepro.com.<br>
    <a href="${esc(manage)}" style="color:#667085;">Unsubscribe or change e-mails</a> · World Trade Pro · ${esc(ses.postalAddress)}
  </td></tr></table>`;
}
function toText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function message(meta, page, rcpt) {
  const html = page.replace(/<\/body>/i, footer(rcpt.token) + '</body>');
  const oneClick = `${SITE}/wp-json/wtp/v1/unsubscribe?t=${rcpt.token}`;
  return {
    FromEmailAddress: `"${ses.fromName}" <${ses.from}>`,
    Destination: { ToAddresses: [rcpt.email] },
    ReplyToAddresses: ses.replyTo ? [ses.replyTo] : undefined,
    Content: { Simple: {
      Subject: { Data: meta.subject, Charset: 'UTF-8' },
      Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: toText(html), Charset: 'UTF-8' } },
      Headers: [
        { Name: 'List-Unsubscribe', Value: `<${oneClick}>` },
        { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
      ],
    } },
    ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
  };
}

// ---------------------------------------------------------------- run
const meta = JSON.parse(readFileSync(join(OUT, NAME + '.json'), 'utf8'));
if (meta.skip) { console.log(`${NAME}: marked skip (too few signals) - nothing sent`); process.exit(0); }
const page = readFileSync(join(OUT, NAME + '.html'), 'utf8');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
if (!ONLY && state[NAME]?.done) { console.log(`${NAME} already sent (${state[NAME].sent} messages) - nothing to do`); process.exit(0); }

let rcpts;
if (ONLY) rcpts = [{ email: ONLY, token: '0'.repeat(32) }];
else {
  const r = await fetch(`${SITE}/wp-json/wtp/v1/subscribers?edition=${EDITION}&secret=${encodeURIComponent(process.env.WTP_BOT_SECRET || '')}`, { headers: { 'user-agent': 'wtp-linkedin-bot/1.0' } });
  if (!r.ok) throw new Error(`subscriber list -> HTTP ${r.status}`);
  rcpts = (await r.json()).items || [];
}
const idOf = (email) => createHmac('sha256', process.env.WTP_BOT_SECRET || 'local').update(email.toLowerCase()).digest('hex').slice(0, 20);
const done = new Set(!ONLY && existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : []);
const todo = rcpts.filter((x) => !done.has(idOf(x.email)));
console.log(`${NAME}: ${rcpts.length} recipients, ${done.size} already sent, ${todo.length} to go - "${meta.subject}"`);
if (DRY || !todo.length) process.exit(0);

const account = await sesCall('GET', '/v2/email/account');
const quota = account.SendQuota || {};
const left = Math.floor((quota.Max24HourSend ?? 0) - (quota.SentLast24Hours ?? 0));
const reserve = EDITION === 'daily' ? (nl.ses.weeklyReserve || 0) : 0;   // keep room for Tuesday's weekly
if (!account.ProductionAccessEnabled && !ONLY) console.log('::warning::SES is still in sandbox mode: only verified addresses will receive mail.');
if (todo.length > left - reserve) {
  const msg = `SES quota: ${left} left in 24h (reserve ${reserve}), ${todo.length} needed - ${NAME} NOT sent. Raise the SES sending quota.`;
  console.log(`::error::${msg}`);
  process.exit(EDITION === 'daily' ? 0 : 1);   // a skipped daily is fine; a skipped weekly must be noticed
}
const gap = Math.ceil(1000 / Math.max(1, (quota.MaxSendRate || 1) * 0.8));
let sent = 0, failed = 0;
for (const [i, x] of todo.entries()) {
  try {
    await sesCall('POST', '/v2/email/outbound-emails', message(meta, page, x));
    sent++;
    if (!ONLY) { done.add(idOf(x.email)); writeFileSync(PROGRESS, JSON.stringify([...done])); }
  } catch (e) {
    failed++;
    console.log(`::warning::recipient #${i + 1} failed: ${e.message.replace(/[\w.+-]+@[\w.-]+/g, '<address>').slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, gap));
}
if (!ONLY) {
  state[NAME] = { done: failed === 0, sent: done.size, failed, at: new Date().toISOString(), subject: meta.subject };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}
console.log(`${NAME}: sent ${sent}, failed ${failed}${ONLY ? ' (test send)' : ''}`);
if (failed && failed === todo.length) process.exit(1);
