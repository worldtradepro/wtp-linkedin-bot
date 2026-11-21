"""Deep research (2026-11-21): a member asked for a research brief on one project.

The site queues the request (/wtp/v1/rs-queue gives the project and the reports we already hold). Claude Code CLI with
WebSearch / WebFetch (the owner's subscription) researches the project on the web and answers in JSON; /wtp/v1/rs-apply
stores the brief and e-mails the members who asked. One brief per project, shared by all members while it is fresh.
Nothing is written to this repository.

Usage: python radar/project_research.py
Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN (Actions), RS_MODEL (default claude-sonnet-5-5), RS_MAX (briefs per run, default 3)
"""
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project_builder as pb   # site()

MODEL = os.environ.get('RS_MODEL', 'claude-sonnet-5-5')
MAX = int(os.environ.get('RS_MAX', '3'))

PROMPT = """You write a research brief on ONE capital project for a sales person who sells into such projects (an EPC contractor,
an equipment maker, a materials supplier or a service company). The reader uses it to prepare a sales call. Today is {today}.

THE PROJECT, as our database holds it:
{project}

REPORTS WE ALREADY HOLD (oldest facts may be out of date):
{reports}

Research the project on the web: the owner's and partners' websites and press releases, stock-exchange filings, tender portals,
regulators and permitting bodies, development banks, and trade press. Prefer primary sources. Make sure every source is about
THIS project (same owner, asset, unit and country), not a project with a similar name.

Rules:
- Only state what a dated public source supports. If you could not find something, put it in "not_found"; do not guess.
- Where you infer something (for example who will place an order), say "our reading:" in front of it.
- Name companies and their roles only. Never give the names, e-mail addresses or phone numbers of individual people.
- Write in your own words, in plain English, short sentences. Do not copy sentences from the sources.
- Dates as "Mar 2026" or "2026-03-14". Money in US$ where the source gives it.

Reply with JSON only, in this shape:
{"summary": "three or four sentences: what the project is, where it stands today, and the one thing a sales person should know",
 "status": "two or three sentences on the current stage and the latest confirmed event, with its date",
 "stage": {"milestone": "M1 study or feasibility | M2 FEED or EPC bidding before FID | M3 FID taken or funding approved | M4 EPC awarded or under construction | M5 operating | empty if no dated source settles it",
           "proc": "latest procurement event: feed_tender | epc_tender | epc_award | package | registration | empty",
           "proc_date": "YYYY-MM-DD of that event or empty", "basis": "one line: the source and date that settle the stage"},
 "timeline": [{"date": "", "event": "one line"}],
 "parties": [{"role": "Owner | Partner | Licensor | FEED contractor | EPC contractor | EPC bidder | Financier | Offtaker | Yard | other", "company": "", "note": "share, scope or status, one line"}],
 "procurement": [{"package": "the contract or package", "status": "planned | tender open | bids in | awarded | not known", "holder": "company if awarded or shortlisted", "date": ""}],
 "next_steps": [{"when": "expected date or period", "what": "the next decision, tender or award", "basis": "who said so"}],
 "competitors": [{"company": "", "position": "what it holds or how it is placed, one line"}],
 "risks": ["one line each: financing, permits, partners, market, politics, delays or cancellation signals"],
 "way_in": {"epc": "what an EPC or construction contractor can still do here and whom to approach (company and role)",
            "main_equipment": "the same for a maker of main equipment or packaged units",
            "materials": "the same for a supplier of pumps, valves, cables and other materials",
            "services": "the same for engineering, inspection, logistics and other services"},
 "not_found": ["what you looked for and did not find"],
 "sources": [{"title": "publisher and headline", "url": "https://...", "date": ""}]}
Give 5 to 15 sources. Leave a list empty rather than fill it with guesses.
"""


def ask(prompt):
    env = dict(os.environ)
    if env.get('CLAUDE_CODE_OAUTH_TOKEN'):
        env['CLAUDE_CODE_OAUTH_TOKEN'] = re.sub(r'\s+', '', env['CLAUDE_CODE_OAUTH_TOKEN'])
    try:
        out = subprocess.run(['claude', '-p', 'Follow the instructions in the input; research on the web; reply with the JSON only.', '--model', MODEL,
                              '--allowedTools', 'WebSearch', 'WebFetch', '--max-turns', '40', '--output-format', 'json'],
                             input=prompt, cwd=tempfile.mkdtemp(prefix='rs-'), env=env, capture_output=True, text=True, timeout=1800)
        txt = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get('result') or ''
        return json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
    except Exception as e:
        print('research failed:', type(e).__name__, file=sys.stderr)
        return None


def main():
    items = pb.site('GET', 'rs-queue', params={'n': MAX}).get('items') or []
    print(f'{len(items)} research request(s)')
    for r in items:
        pj = r.get('project') or {}
        reps = '\n'.join(json.dumps(x, ensure_ascii=False) for x in r.get('reports') or []) or '(none)'
        a = ask(PROMPT.replace('{today}', datetime.date.today().isoformat()).replace('{project}', json.dumps(pj, ensure_ascii=False)).replace('{reports}', reps))
        ok = bool(a and a.get('summary') and a.get('sources'))
        res = pb.site('POST', 'rs-apply', body={'research_id': int(r['id']), 'ok': ok, 'report': a if ok else {}})
        print(f"#{r['id']} project {pj.get('id')} -> {res}")   # ids and status only: the repository log is public


if __name__ == '__main__':
    main()
