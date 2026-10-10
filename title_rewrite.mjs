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
