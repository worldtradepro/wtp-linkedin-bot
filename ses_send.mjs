// Send one e-mail edition (built by newsletter.mjs) to its subscribers through Amazon SES (API v2).
//   Recipients: GET <site>/wp-json/wtp/v1/subscribers?edition=... (the site's own double-opt-in list,
//   snippet "WTP Newsletter"), one message each, with a personal unsubscribe link in the footer and
//   RFC 8058 one-click List-Unsubscribe headers (Gmail / Yahoo bulk-sender rules).
//   Before sending, checks SES's 24-hour quota; a run that would not fit is refused (exit 1, so it is noticed).
//   Also reads the SES account-level suppression list (hard bounces + complaints), skips those subscribers and
//   reports them to the site (POST /wtp/v1/suppress), which marks them bounced / complained. Needs
//   ses:ListSuppressedDestinations; without it the run only warns and sends as before.
//   Progress is written after every message (newsletter/out/<name>.sent.json), so a re-run after a
//   crash continues where it stopped instead of sending twice. This repo and its Actions logs are
//   PUBLIC: the progress file holds only keyed hashes (HMAC with WTP_BOT_SECRET), and logs never
//   print an address.
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (IAM user limited to SES sending), WTP_BOT_SECRET.
//
// Usage:  node ses_send.mjs [--edition weekly|flow|projects] [--date YYYY-MM-DD] [--dry] [--to me@example.com]
//   weekly (default, from 2026-10-06): World Trade Pro Weekly, assembled PER SUBSCRIBER from <date>-weekly.blocks.json
//   (newsletter_assemble.mjs: the reader's sectors first and in full, the rest folded; section order by role).
//   --dry  list what would be sent        --to  send only to this one address (test; no state written)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { assemble, document as doc } from './newsletter_assemble.mjs';
import { siteFetch } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const nl = cfg.newsletter;
const ses = nl.ses;
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const DRY = args.includes('--dry');
const ONLY = arg('--to');
const EDITION = arg('--edition') || 'weekly';
if (!['weekly', 'flow', 'projects'].includes(EDITION)) throw new Error('--edition must be weekly, flow or projects');
const TODAY = arg('--date') || new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-${EDITION}`;
const OUT = join(HERE, 'newsletter', 'out');
const STATE = join(HERE, 'state', 'newsletter.json');
const PROGRESS = join(OUT, NAME + '.sent.json');
const BLOCKS = join(OUT, NAME + '.blocks.json');
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
// RFC 3986 encoding, as SigV4 canonical query strings require
const enc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
async function sesCall(method, path, body, query = {}) {
  const region = process.env.AWS_REGION || ses.region;
  const qs = Object.keys(query).sort().map((k) => `${enc3986(k)}=${enc3986(query[k])}`).join('&');
  const host = `email.${region}.amazonaws.com`;
  const payload = body ? JSON.stringify(body) : '';
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amz.slice(0, 8);
  const scope = `${day}/${region}/ses/aws4_request`;
  const canonical = `${method}\n${path}\n${qs}\ncontent-type:application/json\nhost:${host}\nx-amz-date:${amz}\n\ncontent-type;host;x-amz-date\n${sha256(payload)}`;
  const sig = signature(process.env.AWS_SECRET_ACCESS_KEY, day, region, 'ses', `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(canonical)}`);
  const r = await fetch(`${process.env.SES_ENDPOINT || 'https://' + host}${path}${qs ? '?' + qs : ''}`, {   // SES_ENDPOINT: local mock for tests only
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
  const why = EDITION === 'weekly' ? (nl.weekly?.name || 'World Trade Pro Weekly') : EDITION === 'flow' ? 'Trade Flow Weekly' : 'EPC Project Leads Weekly';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 12px 28px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a2b3;">
    You get ${why} because you subscribed at worldtradepro.com.<br>
    <a href="${esc(manage)}" style="color:#667085;">Unsubscribe${EDITION === 'weekly' ? ' or change your sectors' : ' or change e-mails'}</a> · World Trade Pro · ${esc(POSTAL)}
  </td></tr></table>`;
}
function toText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function message(meta, page, rcpt) {
  // weekly: each subscriber gets the issue assembled for their sectors and role; the manage link carries their token
  const body = blocks ? doc(blocks, assemble({ ...blocks, links: { ...blocks.links, manage: `${SITE}/newsletter/unsubscribe/?t=${rcpt.token}` } }, rcpt)) : page;
  const html = body.replace(/<\/body>/i, footer(rcpt.token) + '</body>');
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
// --check: permissions smoke test (no subscriber mail): account/quota, suppression list read, and one send through the
// configuration set to the SES mailbox simulator (not delivered, does not count against reputation).
if (args.includes('--check')) {
  const acc = await sesCall('GET', '/v2/email/account');
  console.log(`account: production=${acc.ProductionAccessEnabled}, quota ${acc.SendQuota?.SentLast24Hours}/${acc.SendQuota?.Max24HourSend} in 24h, ${acc.SendQuota?.MaxSendRate}/s`);
  const sup = await sesCall('GET', '/v2/email/suppression/addresses', null, { PageSize: '100' });
  console.log(`suppression list readable: ${(sup.SuppressedDestinationSummaries || []).length} address(es) on the first page`);
  const r = await sesCall('POST', '/v2/email/outbound-emails', {
    FromEmailAddress: `"${ses.fromName}" <${ses.from}>`,
    Destination: { ToAddresses: ['success@simulator.amazonses.com'] },
    Content: { Simple: { Subject: { Data: 'SES permissions check' }, Body: { Text: { Data: 'Smoke test from ses_send.mjs --check' } } } },
    ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
  });
  console.log(`simulator send OK (configuration set: ${ses.configurationSet || 'none'}, message id ${r.MessageId})`);
  process.exit(0);
}
const meta =JSON.parse(readFileSync(join(OUT, NAME + '.json'), 'utf8'));
if (meta.skip) { console.log(`${NAME}: marked skip (too few signals) - nothing sent`); process.exit(0); }
const page = readFileSync(join(OUT, NAME + '.html'), 'utf8');
const blocks = EDITION === 'weekly' && existsSync(BLOCKS) ? JSON.parse(readFileSync(BLOCKS, 'utf8')) : null;
if (EDITION === 'weekly' && !blocks) console.log('::warning::no blocks file - every subscriber gets the default (unpersonalised) issue');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
if (!ONLY && state[NAME]?.done) { console.log(`${NAME} already sent (${state[NAME].sent} messages) - nothing to do`); process.exit(0); }

// Recipients + the footer's postal address come from the site (kept out of this public repo).
const listRes = await siteFetch(`${SITE}/wp-json/wtp/v1/subscribers?edition=${EDITION}&secret=${encodeURIComponent(process.env.WTP_BOT_SECRET || '')}`);
if (!listRes.ok) throw new Error(`subscriber list -> HTTP ${listRes.status}`);
const list = await listRes.json();
const POSTAL = list.address || ses.postalAddress || '';
if (!POSTAL) console.log('::warning::No postal address set (WordPress: Settings -> WTP Newsletter) - required in marketing e-mail footers.');
const rcpts = ONLY ? [{ email: ONLY, token: '0'.repeat(32), sectors: arg('--sectors') || '', role: arg('--role') || '' }] : (list.items || []);   // --to test send: --sectors metals,energy --role epc
const idOf = (email) => createHmac('sha256', process.env.WTP_BOT_SECRET || 'local').update(email.toLowerCase()).digest('hex').slice(0, 20);
const done = new Set(!ONLY && existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : []);

// SES suppression list -> skip + write back. SNS push cannot be used: Cloudflare challenges AWS traffic to the site.
async function suppressedList() {
  const out = new Map();
  let token = null;
  do {
    const r = await sesCall('GET', '/v2/email/suppression/addresses', null, { PageSize: '1000', ...(token ? { NextToken: token } : {}) });
    for (const x of r.SuppressedDestinationSummaries || []) out.set(String(x.EmailAddress).toLowerCase(), x.Reason);
    token = r.NextToken;
  } while (token);
  return out;
}
const blocked = new Map();
if (!ONLY) {
  try {
    const sup = await suppressedList();
    for (const x of rcpts) if (sup.has(x.email.toLowerCase())) blocked.set(x.email, sup.get(x.email.toLowerCase()));
    console.log(`SES suppression list: ${sup.size} addresses, ${blocked.size} of them still subscribed`);
  } catch (e) {
    const why = /AccessDenied|-> 403/.test(e.message) ? 'grant ses:ListSuppressedDestinations to the sending IAM user' : e.message.slice(0, 120);
    console.log(`::warning::Could not read the SES suppression list (${why}) - bounces/complaints not synced this run.`);
  }
  if (blocked.size && !DRY) {
    const r = await siteFetch(`${SITE}/wp-json/wtp/v1/suppress?secret=${encodeURIComponent(process.env.WTP_BOT_SECRET || '')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [...blocked].map(([email, reason]) => ({ email, reason })) }),
    });
    console.log(r.ok ? `site: ${(await r.json()).changed} subscriber(s) marked bounced/complained` : `::warning::site /suppress -> HTTP ${r.status}`);
  }
}
const todo = rcpts.filter((x) => !done.has(idOf(x.email)) && !blocked.has(x.email));
console.log(`${NAME}: ${rcpts.length} recipients, ${done.size} already sent, ${todo.length} to go - "${meta.subject}"`);
if (DRY || !todo.length) process.exit(0);

const account = await sesCall('GET', '/v2/email/account');
const quota = account.SendQuota || {};
const left = Math.floor((quota.Max24HourSend ?? 0) - (quota.SentLast24Hours ?? 0));
const reserve = 0;
if (!account.ProductionAccessEnabled && !ONLY) console.log('::warning::SES is still in sandbox mode: only verified addresses will receive mail.');
if (todo.length > left - reserve) {
  const msg = `SES quota: ${left} left in 24h (reserve ${reserve}), ${todo.length} needed - ${NAME} NOT sent. Raise the SES sending quota.`;
  console.log(`::error::${msg}`);
  process.exit(1);   // a skipped weekly issue must be noticed
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
