// Writes the editorial note for Trade Flow Weekly (reports/notes/<date>-flow.json) with ONE model call on OpenRouter,
// from reports/out/<date>-flow/data.json (made by: node weekly_report.mjs --date <Monday> --data-only).
// The note is then checked in code, because a person reviews it only on Sunday evening:
//   hard (retry once, then fail): valid JSON + every required field; every link is one of the week's stories;
//        images come from media_library/ledger.json
//   soft (listed in the review e-mail): numbers not found in the source material; "quiet" said about a market that
//        had elevated/critical stories; a market with elevated/critical stories but no note
// Env: OPENROUTER_API_KEY. Usage: node weekly_notes.mjs --date YYYY-MM-DD [--force]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const W = cfg.weeklyReport || {};
const args = process.argv.slice(2);
const TODAY = args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const OUT = join(HERE, 'reports', 'out', `${TODAY}-flow`);
const NOTES = join(HERE, 'reports', 'notes', `${TODAY}-flow.json`);
const CHECK_ONLY = args.includes('--check-only');   // re-check an existing note (e.g. after editing it by hand); no model call
if (existsSync(NOTES) && !args.includes('--force') && !CHECK_ONLY) { console.log('note exists (use --force to rewrite):', NOTES); process.exit(0); }
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY && !CHECK_ONLY) throw new Error('OPENROUTER_API_KEY missing');
const data = JSON.parse(readFileSync(join(OUT, 'data.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(HERE, 'media_library', 'ledger.json'), 'utf8'));
const example = JSON.parse(readFileSync(join(HERE, 'reports', 'notes', 'example-flow.json'), 'utf8'));

// ---------------------------------------------------------------- source material (compact)
const stories = new Map();
const add = (s) => { if (s?.url && !stories.has(s.url)) stories.set(s.url, s); };
for (const c of data.clusters || []) { add(c.lead); (c.more || []).forEach(add); }
if (data.big) { add(data.big.lead); data.big.more.forEach(add); }
for (const m of data.markets) m.picks.forEach(add);
const S = [...stories.values()].map((s, i) => ({ n: i + 1, ...s }));
const material = {
  week: `${data.from} to ${data.to} (ISO week ${data.week}, ${data.year})`,
  totals: data.totals,
  lanes: data.lanes.filter((l) => l.p || l.pp).map((l) => ({ lane: l.name, flow: l.flow, pressure_this_week: l.p, pressure_last_week: l.pp, critical: l.now.crit, elevated: l.now.elev, watch: l.now.watch })),
  quiet_lanes: data.lanes.filter((l) => !l.p && !l.pp).map((l) => l.name),
  markets: data.markets.map((m) => ({ key: m.key, label: m.label, signals: m.n, top_stories: m.picks.map((p) => p.url) })),
  biggest_story_cluster: data.big && { lead: data.big.lead.url, other_reports: data.big.more.map((m) => m.url) },
  stories: S.map((s) => ({ url: s.url, title: s.title, source: s.source, date: s.date, tier: s.tier, country: s.country, lane: s.lane || undefined, summary: s.summary || undefined })),
};
const photos = ledger.map((l) => ({ id: l.id, caption: l.caption, tags: l.tags, overlay_ok: /cc0|public domain|pixabay/i.test(l.license) }));

const SYSTEM = `You are the editor of "Trade Flow Weekly", a free weekly report by World Trade Pro for physical commodity traders, charterers, shipowners and buyers.
You write ONLY from the source material given (this week's news signals). Hard rules:
- Every fact, number, name and date must come from the stories' titles/summaries or the totals/lanes data. Never add outside knowledge, prices, forecasts or figures.
- In "big.paras" every factual claim links to its story with <a href="URL">...</a>, using ONLY URLs from the material. No other HTML.
- Attribute reported claims ("OilPrice.com reports", "per gCaptain"). Do not present a report as confirmed fact beyond what it says.
- Never call a market or lane "quiet" if it has stories with tier Critical or Elevated. Give every market with Critical/Elevated stories a note.
- British spelling is fine; plain, precise, no hype, no emojis. Numbers as in the sources.
- "watch" items must be forward-looking questions grounded in this week's stories, format "Topic: one sentence".
- Pick photos only from the photo library list by id; "hero" should have overlay_ok=true (text is placed over it); "story" is optional. If nothing fits, omit the key.
Return ONE JSON object only, no markdown fences, with exactly the keys of the example.`;

const USER = `EXAMPLE of the expected JSON (a previous week, for form and tone only - do not reuse its facts):
${JSON.stringify({ ...example, _about: undefined }, null, 1)}

FIELD LIMITS: title <= 100 chars; short <= 64; dek <= 220; takeaways = 3 items <= 240 chars; hero.value <= 8 chars (a number from the sources), hero.label <= 70, hero.bullets = 3 items <= 90; big.heading <= 70 and starts "The big story: "; big.paras = 3 paragraphs; big.slide = 3 items <= 110 chars; lanesNote <= 450; markets: keys among ${data.markets.map((m) => m.key).join(', ')}, each <= 300; implications = 3 {who, text <= 220}; watch = 3; question <= 200.

PHOTO LIBRARY:
${JSON.stringify(photos)}

SOURCE MATERIAL:
${JSON.stringify(material)}`;

// ---------------------------------------------------------------- checks
const URLS = new Set(S.map((s) => s.url));
const corpus = JSON.stringify(material).toLowerCase();
const numbersIn = (t) => (String(t).match(/\d[\d,.]*%?/g) || []).map((x) => x.replace(/[.,]$/, ''));
function check(n) {
  const hard = [], soft = [];
  const need = ['title', 'short', 'dek', 'takeaways', 'hero', 'big', 'lanesNote', 'markets', 'implications', 'watch', 'question'];
  for (const k of need) if (n[k] === undefined) hard.push('missing ' + k);
  if (hard.length) return { hard, soft };
  if (n.takeaways.length !== 3) hard.push('takeaways must be 3');
  if (!n.big?.paras?.length || !n.big?.slide?.length) hard.push('big.paras / big.slide missing');
  for (const p of n.big.paras) for (const m of p.matchAll(/href="([^"]+)"/g)) if (!URLS.has(m[1])) hard.push('link not in the week\'s stories: ' + m[1]);
  if (/<(?!\/?a[\s>])[a-z]/i.test(n.big.paras.join(' '))) hard.push('only <a> tags allowed in big.paras');
  for (const [k, v] of Object.entries(n.images || {})) if (!ledger.some((l) => l.id === v)) hard.push(`image ${k}: ${v} not in the library`);
  // soft
  const texts = [n.title, n.short, n.dek, ...n.takeaways, n.hero.value, n.hero.label, ...n.hero.bullets, ...n.big.paras.map((p) => p.replace(/<[^>]+>/g, '')), ...n.big.slide, n.lanesNote, ...Object.values(n.markets), ...n.implications.map((i) => i.text), ...n.watch];
  const missing = new Set();
  for (const t of texts) for (const x of numbersIn(t)) { const bare = x.replace(/,/g, ''); if (!corpus.includes(x.toLowerCase()) && !corpus.includes(bare)) missing.add(x); }
  if (missing.size) soft.push('numbers not found in the source material (check them): ' + [...missing].join(', '));
  for (const m of data.markets) {
    const strong = m.picks.filter((p) => p.tier !== 'Watch').length;
    const note = n.markets[m.key] || '';
    if (strong && !note) soft.push(`${m.label}: ${strong} elevated/critical stories but no note`);
    if (strong && /\bquiet\b/i.test(note)) soft.push(`${m.label}: called "quiet" although it has ${strong} elevated/critical stories`);
  }
  if (/\bquiet\b/i.test(n.lanesNote)) for (const l of data.lanes) if (l.now.crit + l.now.elev > 0 && n.lanesNote.toLowerCase().includes(l.name.toLowerCase().split(' ')[0]) && /quiet/i.test(n.lanesNote)) { soft.push(`lanesNote says quiet near ${l.name}, which had elevated/critical signals`); break; }
  const lens = [['title', 100], ['short', 64], ['dek', 220], ['lanesNote', 450], ['question', 200]];
  for (const [k, max] of lens) if (String(n[k]).length > max) soft.push(`${k} is ${String(n[k]).length} chars (limit ${max})`);
  return { hard, soft };
}

if (CHECK_ONLY) {
  const n = JSON.parse(readFileSync(NOTES, 'utf8'));
  const c = check(n);
  console.log(JSON.stringify(c, null, 1));
  n._check = { warnings: c.soft, errors: c.hard };
  writeFileSync(NOTES, JSON.stringify(n, null, 2) + '\n');
  process.exit(c.hard.length ? 1 : 0);
}

// ---------------------------------------------------------------- call
async function ask(messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', 'HTTP-Referer': cfg.site, 'X-Title': 'World Trade Pro - Trade Flow Weekly' },
    body: JSON.stringify({ model: W.model || 'anthropic/claude-opus-5.5', temperature: 0.3, max_tokens: 6000, messages }),
  });
  const j = await r.json();
  if (!r.ok || !j.choices) throw new Error(`OpenRouter ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return { text: j.choices[0].message.content, usage: j.usage, model: j.model };
}
const parse = (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));

const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }];
let note, res, chk;
for (let attempt = 1; attempt <= 2; attempt++) {
  res = await ask(messages);
  try { note = parse(res.text); chk = check(note); } catch (e) { note = null; chk = { hard: ['not valid JSON: ' + e.message], soft: [] }; }
  console.log(`attempt ${attempt}: ${res.model}, tokens ${res.usage?.prompt_tokens}/${res.usage?.completion_tokens}, hard ${chk.hard.length}, soft ${chk.soft.length}`);
  if (!chk.hard.length) break;
  messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: 'Fix these problems and return the full JSON again:\n- ' + chk.hard.join('\n- ') });
}
if (chk.hard.length) { console.error('note failed the checks:\n- ' + chk.hard.join('\n- ')); process.exit(1); }
note._generated = { at: new Date().toISOString(), model: res.model, usage: res.usage };
note._check = { warnings: chk.soft };
mkdirSync(dirname(NOTES), { recursive: true });
writeFileSync(NOTES, JSON.stringify(note, null, 2) + '\n');
console.log('note written:', NOTES, chk.soft.length ? '\nwarnings:\n- ' + chk.soft.join('\n- ') : '(no warnings)');
