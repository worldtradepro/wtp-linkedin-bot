"""Project lookup (2026-11-12): a member named a project that is not in our database; look it up on the web.

Owner: the member area searches our own project table first; only a project that is not there costs a web search. The site
queues the requests (/wtp/v1/pl-queue, with the closest names we already have); Claude Code CLI with WebSearch / WebFetch
(owner's subscription, Haiku by default) finds the project on the owner's site, tender portals and trade press and answers in
JSON; /wtp/v1/pl-apply stores the project, follows it for the member when a slot is free and e-mails the member.

Usage: python radar/project_lookup.py
Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN (Actions), PL_MODEL (default claude-haiku-5-5)
"""
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project_builder as pb   # site()

MODEL = os.environ.get('PL_MODEL', 'claude-haiku-5-5')

PROMPT = """A member of a project-intelligence service for equipment suppliers asks about a capital project.
Project as the member names it: {query}
Country: {country}
What the member knows: {note}

First check whether it is one of the projects we already have (same operator, asset, unit):
{similar}

If it is one of those, answer with its id. Otherwise search the web (owner's website and press releases, tender portals, trade
press) for this project. Only report what dated public sources say; do not guess.

Milestone: M1 study/feasibility · M2 FEED or EPC bidding before FID · M3 FID / funding approved · M4 EPC awarded, construction ·
M5 operating. Procurement (latest event): feed_tender · epc_tender · epc_award · package · registration · "" if none.

Reply with JSON only:
{"found": true|false, "project_id": <id of an existing project or null>,
 "project": {"name": "operator + asset + facility + unit", "operator": "", "country": "", "location": "", "facility": "", "unit_no": "",
             "capacity": "", "sector": "", "summary": "one sentence", "milestone": "", "proc": "", "proc_date": "YYYY-MM-DD or empty", "proc_note": ""},
 "answer": "two sentences for the member: what the project is and where it stands, or why nothing reliable was found",
 "sources": ["url", "..."]}
"""


def ask(prompt):
    env = dict(os.environ)
    if env.get('CLAUDE_CODE_OAUTH_TOKEN'):
        env['CLAUDE_CODE_OAUTH_TOKEN'] = re.sub(r'\s+', '', env['CLAUDE_CODE_OAUTH_TOKEN'])
    out = subprocess.run(['claude', '-p', 'Follow the instructions in the input; use web search; reply with the JSON only.', '--model', MODEL,
                          '--allowedTools', 'WebSearch', 'WebFetch', '--max-turns', '12', '--output-format', 'json'],
                         input=prompt, cwd=tempfile.mkdtemp(prefix='pl-'), env=env, capture_output=True, text=True, timeout=900)
    try:
        txt = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get('result') or ''
        return json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
    except Exception:
        print('lookup failed:', (out.stdout or out.stderr)[:300], file=sys.stderr)
        return None


def main():
    items = pb.site('GET', 'pl-queue').get('items') or []
    print(f'{len(items)} lookup request(s)')
    for r in items:
        sim = '\n'.join(json.dumps(x, ensure_ascii=False) for x in r.get('similar') or []) or '(none)'
        a = ask(PROMPT.replace('{query}', r['query']).replace('{country}', r.get('country') or 'not given')
                .replace('{note}', r.get('note') or 'nothing').replace('{similar}', sim))
        if not a:
            continue   # stays queued; the next run tries again
        known = {int(x['id']) for x in r.get('similar') or []}
        pid = a.get('project_id')
        body = {'request_id': int(r['id']), 'found': bool(a.get('found')), 'project_id': int(pid) if str(pid or '').isdigit() and int(pid) in known else None,
                'project': a.get('project') or {}, 'answer': a.get('answer') or '', 'sources': a.get('sources') or []}
        res = pb.site('POST', 'pl-apply', body=body)
        print(f"#{r['id']} {r['query'][:50]} -> {res}")


if __name__ == '__main__':
    main()
