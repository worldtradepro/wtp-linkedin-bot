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
export function guardOk(orig, next) {
  if (typeof next !== 'string') return false;
  const n = next.trim();
  if (n.length < 35 || n.length > 115 || /[#\n]/u.test(n)) return false;
  const have = new Set(tokens(n));
  const lost = tokens(orig).filter((t) => !have.has(t) && !n.toLowerCase().replace(/[\s,]/g, '').includes(t));
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
    return titles.map((t, i) => (guardOk(t, arr[i]) ? arr[i].trim() : (log(`  title kept (guard): ${t}`), t)));
  } catch (e) {
    log('  title rewrite skipped: ' + String(e.message || e).slice(0, 160));
    return titles;
  }
}
