// Rewrites Infrastructure project headlines into short news-style titles (2026-10-10, owner approved).
// Model: the owner's Claude subscription through llm.mjs (CLAUDE_CODE_OAUTH_TOKEN). Guardrails: only the wording changes -
// every number, currency amount and capitalised name of the original must survive, nothing new may be added, length 40-110 chars.
// Any failure (no credentials, CLI error, guard rejects) returns the original title: a post is never blocked by this step.
import { ask, engine } from './llm.mjs';

const SYSTEM = `You write headlines for an infrastructure and project-finance news feed read by industry professionals (BD, EPC, equipment suppliers).
Rewrite each given headline as ONE clear news headline, 45-95 characters, sentence case, no trailing period, no emoji, no hashtags.
Rules: keep EVERY number, currency amount, company name and place name from the original exactly as written; do not add any fact, adjective of scale, or name that is not in the original; do not change the meaning; prefer an active verb; drop filler words.
If the original is already a good headline, return it unchanged.
Reply with a JSON array of strings only, same order and length as the input.`;

const tokens = (s) => (String(s).match(/\$?\d[\d,.]*\s?(?:bn|m|b|k|%|GW|MW|MTPA)?|\b[A-Z][A-Za-z&.-]{2,}\b/g) || []).map((x) => x.replace(/[\s,]/g, '').toLowerCase());
const GENERIC = new Set(('gets get wins win won secures secured bags bagged lands awarded awards award signs signed inks announces announced plans planned launches launched starts begins ' +
  'receives received takes sets seeks eyes approves approved completes completed selects selected picks named orders ordered order orders contract contracts deal deals project projects ' +
  'plant plants plus worth new major more for from with and the over into amid after ahead under near its their will has have are was says said expands expansion builds build ' +
  'construction development phase stake final investment decision work works supply unit units facility facilities line lines mine port terminal power energy gas oil').split(' '));
const titleCase = (s) => { const w = String(s).split(/\s+/).filter((x) => /^[A-Za-z]{4,}$/.test(x)); return w.length >= 3 && w.filter((x) => /^[A-Z]/.test(x)).length / w.length > 0.7; };
export function guardOk(orig, next) {
  if (typeof next !== 'string') return false;
  const n = next.trim();
  if (n.length < 35 || n.length > 115 || /[#\n]/u.test(n)) return false;
  const have = new Set(tokens(n));
  // A Title Case original ("Gets Rs 5,000 Cr Plus Order For ...") capitalises ordinary words too: those are not names and may be
  // reworded - otherwise such a headline could never be rewritten at all (2026-10-10). Numbers and real names must still survive.
  const lost = tokens(orig).filter((t) => !have.has(t) && !n.toLowerCase().replace(/[\s,]/g, '').includes(t) && !(titleCase(orig) && GENERIC.has(t)));
  if (lost.length) return false;   // nothing from the original may disappear
  const orig0 = String(orig).toLowerCase();
  const added = (n.match(/\b[A-Z][A-Za-z&-]{2,}\b/g) || []).slice(1).filter((w) => !orig0.includes(w.toLowerCase()));
  return added.length === 0;   // no new names (first word excluded: sentence case)
}

export async function rewriteTitles(titles, log = console.log) {
  if (!titles.length || !engine()) return titles;
  try {
    const { text } = await ask(SYSTEM, [{ role: 'user', content: JSON.stringify(titles) }], { maxTokens: 1500 });
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    if (!Array.isArray(arr) || arr.length !== titles.length) throw new Error('bad reply shape');
    return titles.map((t, i) => (guardOk(t, arr[i]) ? arr[i].trim() : (log(`  title kept (guard rejected "${String(arr[i]).slice(0, 120)}"): ${t}`), t)));
  } catch (e) {
    log('  title rewrite skipped: ' + String(e.message || e).slice(0, 160));
    return titles;
  }
}

// ---- generic names (2026-10-14) ----
// Some project names from the pipeline are only a type ("Data Center", "Solar Power Plant"): the post then went out with a
// two-word title, because rewriteTitles() may not add names. For those, write the title from the post's own description
// instead; guard: every name and number in the new title must appear in that description (or the old title).
const TYPE_WORDS = new Set(('data center centre centers centres campus solar wind power plant plants farm park project projects expansion new ' +
  'terminal port mine mining refinery pipeline lng gas oil hydrogen ammonia battery storage bess hub facility facilities complex station ' +
  'substation transmission line grid hydro hydropower nuclear desalination water fertilizer fertiliser smelter offshore onshore field ' +
  'development phase upgrade construction rail railway metro shipyard vessel vessels fleet order orders contract green blue').split(' '));
export function isGenericTitle(t) {
  const s = String(t || '').trim();
  if (s.length < 18) return true;
  const words = s.split(/[^A-Za-z0-9$%.]+/).filter(Boolean);
  const names = words.filter((w) => /\d/.test(w) || (/^[A-Z]/.test(w) && !TYPE_WORDS.has(w.toLowerCase())));
  return names.length === 0;
}
const SYSTEM_CTX = `You write headlines for an infrastructure and project-finance news feed read by industry professionals.
You get a vague project name and the short description of the news. Write ONE clear news headline, 45-95 characters, sentence case,
no trailing period, no emoji, no hashtags. Use ONLY facts in the description: the developer or company, the place, the size if given.
Do not invent anything. Reply with the headline only.`;
export function guardCtxOk(orig, context, next) {
  if (typeof next !== 'string') return false;
  const n = next.trim().replace(/^["']|["']$/g, '');
  if (n.length < 35 || n.length > 115 || /[#\n]/u.test(n)) return false;
  const src = (String(orig) + ' ' + String(context)).toLowerCase().replace(/[\s,]/g, '');
  const names = (n.match(/\$?\d[\d,.]*\s?(?:bn|m|b|k|%|GW|MW|MTPA)?|\b[A-Z][A-Za-z&.-]{1,}\b/g) || []).slice(0);
  // the first word is capitalised by sentence case: it is exempt only if it is an ordinary word, never a name
  const COMMON = /^(the|a|an|new|plans?|planned|proposed|joint|work|construction|developer|developers|us|uk|eu|first|second|largest|major|state|government|private|consortium|partners?)$/i;
  return names.every((w, i) => (i === 0 && n.startsWith(w) && COMMON.test(w)) || src.includes(w.toLowerCase().replace(/[\s,]/g, '')));
}
export async function rewriteGenericTitle(base, context, log = console.log) {
  if (!engine() || !String(context || '').trim()) return base;
  try {
    const { text } = await ask(SYSTEM_CTX, [{ role: 'user', content: JSON.stringify({ name: base, description: String(context).slice(0, 1200) }) }], { maxTokens: 300 });
    const t = String(text || '').trim().split('\n')[0].replace(/^["']|["']$/g, '').trim();
    if (guardCtxOk(base, context, t)) return t;
    log(`  generic title kept (guard rejected "${t.slice(0, 120)}"): ${base}`);
  } catch (e) {
    log('  generic title rewrite skipped: ' + String(e.message || e).slice(0, 160));
  }
  return base;
}
