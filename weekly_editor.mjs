// Editor's notes for World Trade Pro Weekly: ONE model call over the week's material (newsletter/out/<date>-weekly.blocks.json,
// written by newsletter_weekly.mjs), checked in code, saved to newsletter/notes/<date>-weekly.json. newsletter_weekly.mjs then
// rebuilds the issue with the notes in place (lede, one sentence per deal, "what it means" per flow story).
//   hard (retry once, then fail): valid JSON with the expected keys; every deal name / flow url is one from the material;
//        no number in the lede that is not in the material; lede 60-110 words; links only to material urls.
//   soft: logged only.
// Env: CLAUDE_CODE_OAUTH_TOKEN or OPENROUTER_API_KEY (llm.mjs). Usage: node weekly_editor.mjs [--date YYYY-MM-DD] [--force]
// A failed or skipped run is not fatal for the issue: without notes the issue falls back to its rule-based sentences.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, engine } from './llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const W = cfg.newsletter.weekly || {};
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const NAME = `${TODAY}-weekly`;
const BLOCKS = join(HERE, 'newsletter', 'out', `${NAME}.blocks.json`);
const NOTES = join(HERE, 'newsletter', 'notes', `${NAME}.json`);
if (existsSync(NOTES) && !args.includes('--force')) { console.log('notes exist (use --force to rewrite):', NOTES); process.exit(0); }
if (!engine()) { console.log('::warning::no model credentials - the issue keeps its rule-based sentences'); process.exit(0); }
const b = JSON.parse(readFileSync(BLOCKS, 'utf8'));
const M = b.material;
if (!M) throw new Error('blocks file has no material (rebuild with the current newsletter_weekly.mjs)');

const SYSTEM = `You are the editor of "${W.name || 'World Trade Pro Weekly'}", a free Tuesday e-mail from World Trade Pro for the people who build and move commodities: BD and procurement at EPC contractors, equipment makers and project owners, plus traders and charterers. The publisher ran overseas business for a large EPC contractor; write with that insider's eye, plainly, no hype, no emojis, British spelling.
You write ONLY from the material. Hard rules:
- Every name, number, date and claim must come from the material. Never add outside knowledge, prices or forecasts.
- lede_html: 60-110 words, 2-4 sentences, one judgement (what the week's pattern means for a bidder or buyer), plain HTML with at most 2 <a href="URL"> links to material urls, no other tags.
- deals_why: for each deal name given, ONE sentence (max 28 words) a procurement lead would find useful: what the award or tender signals (who is now buying, what the price implies, who is booked). Keys = the exact deal names.
- flows_why: for each flow url given, ONE sentence (max 28 words) on what it means for buyers or shippers of that commodity. Keys = the exact urls.
- signoff: a short sign-off line, e.g. "Yi Huang, World Trade Pro" (keep exactly that).
Return ONE JSON object only, no markdown fences, keys: lede_html, deals_why, flows_why, signoff.`;
const material = { week: `${b.from} to ${b.to} (ISO week ${b.week} ${b.year}), issue ${b.issue}`, this_week: b.stats, last_week: M.prev, change: M.deltas, biggest_deal: M.biggest, most_awards: M.topWinner, busiest_country: M.topCountry, deals: M.deals, flows: M.flows };
const USER = `MATERIAL (JSON):\n${JSON.stringify(material, null, 1)}\n\nWrite the editor's notes now.`;

const check = (n) => {
  const errs = [];
  for (const k of ['lede_html', 'deals_why', 'flows_why', 'signoff']) if (!(k in n)) errs.push(`missing ${k}`);
  if (errs.length) return errs;
  const words = String(n.lede_html).replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length;
  if (words < 50 || words > 130) errs.push(`lede is ${words} words (want 60-110)`);
  const urls = new Set([...M.deals.map((d) => d.url), ...M.flows.map((f) => f.url)]);
  for (const m of String(n.lede_html).matchAll(/href="([^"]+)"/g)) if (!urls.has(m[1])) errs.push(`lede links to a url not in the material: ${m[1]}`);
  if (/<(?!\/?a\b)[a-z]/i.test(n.lede_html)) errs.push('lede uses HTML other than <a>');
  const names = new Set(M.deals.map((d) => d.name));
  for (const k of Object.keys(n.deals_why || {})) if (!names.has(k)) errs.push(`deals_why key is not a deal name: ${k.slice(0, 60)}`);
  for (const k of Object.keys(n.flows_why || {})) if (!urls.has(k)) errs.push(`flows_why key is not a flow url: ${k.slice(0, 60)}`);
  const text = JSON.stringify(material);
  for (const num of String(n.lede_html).replace(/<[^>]+>/g, ' ').match(/\b\d[\d,.]*\b/g) || []) if (!text.includes(num.replace(/,/g, '')) && !text.includes(num)) errs.push(`number not in material: ${num}`);
  return errs;
};
const parse = (t) => JSON.parse(String(t).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());

let messages = [{ role: 'user', content: USER }], notes = null, errs = [];
for (let attempt = 1; attempt <= 2; attempt++) {
  const r = await ask(SYSTEM, messages, { model: W.model || cfg.weeklyReport?.model, title: 'World Trade Pro Weekly editor', maxTokens: 3000 });
  try { notes = parse(r.text); errs = check(notes); } catch (e) { notes = null; errs = ['not valid JSON: ' + e.message]; }
  console.log(`attempt ${attempt} (${r.model}): ${errs.length ? errs.join('; ') : 'ok'}`);
  if (!errs.length) break;
  messages = [...messages, { role: 'assistant', content: r.text }, { role: 'user', content: `Fix these problems and return the whole JSON again:\n- ${errs.join('\n- ')}` }];
}
if (errs.length) { console.log('::warning::editor notes rejected - the issue keeps its rule-based sentences'); process.exit(0); }
mkdirSync(dirname(NOTES), { recursive: true });
writeFileSync(NOTES, JSON.stringify({ ...notes, _generated: new Date().toISOString() }, null, 2) + '\n');
console.log('notes written:', NOTES);
