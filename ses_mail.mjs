// One transactional e-mail through Amazon SES (API v2) - used for the weekly review mail to the site owner.
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (IAM user limited to SES sending), optional AWS_REGION.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf8'));
const ses = cfg.newsletter.ses;
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest();

export async function sendMail({ to, subject, html, text }) {
  const region = process.env.AWS_REGION || ses.region;
  const host = `email.${region}.amazonaws.com`, path = '/v2/email/outbound-emails';
  const body = JSON.stringify({
    FromEmailAddress: `${ses.fromName} <${ses.from}>`, ReplyToAddresses: [ses.replyTo], Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text || html.replace(/<[^>]+>/g, ' '), Charset: 'UTF-8' } } } },
    ...(ses.configurationSet ? { ConfigurationSetName: ses.configurationSet } : {}),
  });
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amz.slice(0, 8);
  const scope = `${day}/${region}/ses/aws4_request`;
  const canonical = `POST\n${path}\n\ncontent-type:application/json\nhost:${host}\nx-amz-date:${amz}\n\ncontent-type;host;x-amz-date\n${sha256(body)}`;
  const kDate = hmac(hmac(hmac(hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, day), region), 'ses'), 'aws4_request');
  const sig = createHmac('sha256', kDate).update(`AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(canonical)}`, 'utf8').digest('hex');
  const r = await fetch(`https://${host}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Amz-Date': amz,
    Authorization: `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${sig}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`SES ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t || '{}');
}
