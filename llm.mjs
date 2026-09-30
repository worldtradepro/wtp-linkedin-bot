// One model call for the editorial notes (daily_scan.mjs, weekly_notes.mjs).
// Engine, in this order:
//   1) CLAUDE_CODE_OAUTH_TOKEN (the owner's Claude Max subscription; token from `claude setup-token`) -> Claude Code CLI in
//      print mode, no tools, one turn, run from an empty temp dir so no project settings are loaded. Usage counts against the plan.
//   2) OPENROUTER_API_KEY -> OpenRouter chat completions.
// ask(system, messages) where messages = [{role:'user'|'assistant', content}] (a retry passes the earlier answer + the fix request).
// Returns { text, model, usage }.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const engine = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.LLM_ENGINE === 'claude' ? 'claude-subscription' : process.env.OPENROUTER_API_KEY ? 'openrouter' : null);

// OpenRouter model ids look like "anthropic/claude-opus-5.5"; the CLI wants "claude-opus-5-5"
const cliModel = (m) => String(m || 'claude-opus-5-5').replace(/^anthropic\//, '').replace(/(\d)\.(\d)/g, '$1-$2');

export async function ask(system, messages, { model, title = 'World Trade Pro', maxTokens = 4000, temperature = 0.2, site = 'https://worldtradepro.com' } = {}) {
  const e = engine();
  if (!e) throw new Error('no model credentials: set CLAUDE_CODE_OAUTH_TOKEN (Claude subscription) or OPENROUTER_API_KEY');
  if (e === 'claude-subscription') {
    // the conversation so far goes in as one prompt on stdin (the CLI has no multi-message input in print mode)
    const prompt = messages.map((m) => (m.role === 'user' ? m.content : `YOUR PREVIOUS ANSWER:\n${m.content}`)).join('\n\n---\n\n');
    const cwd = mkdtempSync(join(tmpdir(), 'wtp-llm-'));
    const bin = process.env.CLAUDE_BIN || 'claude';
    let out;
    try {
      out = execFileSync(bin, ['-p', 'Follow the instructions in the input and reply with the JSON object only.',
        '--system-prompt', system, '--model', cliModel(model), '--max-turns', '1', '--output-format', 'json'],
      { cwd, input: prompt, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60000, shell: process.platform === 'win32' });
    } catch (e) {
      // the CLI exits non-zero on API/auth errors; its JSON on stdout still says why. Never echo the (long) command line.
      const so = String(e.stdout || ''), se = String(e.stderr || '');
      let why = '';
      try { const j = JSON.parse(so); why = `${j.subtype || ''} ${j.result || ''}`; } catch { why = so.slice(0, 600); }
      throw new Error(`Claude CLI failed (exit ${e.status}): ${why.trim().slice(0, 600)} ${se.trim().slice(0, 600)}`.trim());
    }
    const j = JSON.parse(out);
    if (j.is_error || j.subtype && j.subtype !== 'success') throw new Error(`Claude CLI: ${j.subtype || 'error'} ${String(j.result || '').slice(0, 300)}`);
    return { text: j.result, model: cliModel(model) + ' (Claude subscription)', usage: j.usage || null };
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'content-type': 'application/json', 'HTTP-Referer': site, 'X-Title': title },
    body: JSON.stringify({ model: model || 'anthropic/claude-opus-5.5', temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const j = await r.json();
  if (!r.ok || !j.choices) throw new Error(`OpenRouter ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return { text: j.choices[0].message.content, usage: j.usage, model: j.model };
}
