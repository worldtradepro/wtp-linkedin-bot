"""Deep research (2026-11-21): a research brief on one project, asked for by a member or queued by the site.

The site queues the jobs (/wtp/v1/rs-queue gives the project and the reports we already hold; members' requests first). Claude
Code CLI with WebSearch / WebFetch (the owner's subscription) researches the project on the web and answers in JSON;
/wtp/v1/rs-apply stores the brief and e-mails the members who asked. One brief per project, shared by all members.
When the site already holds a brief and new reports came in, the job is an UPDATE: cheaper, it starts from the old brief.
Nothing is written to this repository.

Usage: python radar/project_research.py            work through the queue until it is empty or the time budget is used
       python radar/project_research.py --count    print how many jobs wait (used to skip the install when there are none)
Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN (Actions), RS_MODEL (default claude-sonnet-5-5), RS_BATCH (jobs per request,
     default 5), RS_MINUTES (time budget, default 45), RS_MAX (most briefs per run, default 200)
"""
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project_builder as pb   # site()

MODEL = os.environ.get('RS_MODEL', 'claude-sonnet-5-5')
BATCH = int(os.environ.get('RS_BATCH', '5'))
MINUTES = int(os.environ.get('RS_MINUTES', '45'))
MAX = int(os.environ.get('RS_MAX', '200'))

RULES = """Rules:
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
           "proc_date": "YYYY-MM-DD of that event or empty", "basis": "one line: the source and date that settle the stage",
           "status": "active | on_hold | cancelled ; on_hold or cancelled only when a dated source says so"},
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
 "questions": [{"key": "the key of an OPEN QUESTION given above", "answered": true, "answer": "the answer in one or two sentences", "source": "https://... the page that answers it", "date": "date of that source",
                "final": "true when the matter is settled (a decision taken, a contract awarded, a date passed); false when this is only what is known so far and it can still change"}],
 "not_found": ["what you looked for and did not find"],
 "sources": [{"title": "publisher and headline", "url": "https://...", "date": ""}]}
Give 5 to 15 sources. Leave a list empty rather than fill it with guesses.
"questions": include an entry only for an OPEN QUESTION that a dated public source answers, in full or in part. Where the
question shows "known", return an entry only if a source says something NEW or different from it; if nothing changed, leave
the question out. If there are no open questions, return an empty list.
"""

QUESTIONS = """
OPEN QUESTIONS the readers who follow this project want answered ("known" = what we told them so far). Search for each one
specifically (the owner, its partners, contractors and suppliers, tender portals, filings, trade and local press). They decide
a sale, so do not answer from inference: only when a dated source states it. A source that only repeats a rumour counts only
if you say in the answer who reports it and that it is not confirmed. Never name individual people in an answer.
{questions}
"""

PROMPT = """You write a research brief on ONE capital project for a sales person who sells into such projects (an EPC contractor,
an equipment maker, a materials supplier or a service company). The reader uses it to prepare a sales call. Today is {today}.

THE PROJECT, as our database holds it:
{project}

REPORTS WE ALREADY HOLD (oldest facts may be out of date):
{reports}

Research the project on the web: the owner's and partners' websites and press releases, stock-exchange filings, tender portals,
regulators and permitting bodies, development banks, and trade press. Prefer primary sources. Make sure every source is about
THIS project (same owner, asset, unit and country), not a project with a similar name.

""" + RULES

UPDATE_PROMPT = """You UPDATE a research brief on one capital project for a sales person who sells into such projects. Today is {today}.

THE PROJECT, as our database holds it:
{project}

THE BRIEF WE HOLD, written on {previous_date}:
{previous}

NEW REPORTS that reached us after that brief:
{new_reports}

Read the new reports (open their links when you need the detail) and search the web only for what may have changed since
{previous_date}: stage, awards, tenders, partners, dates, delays. Then return the WHOLE brief again, brought up to date: keep what
still holds, correct what changed, add the new events to the timeline, and keep the earlier sources that still support a point.
Start the summary with what is new since {previous_date}; if nothing changed, keep the summary and do not invent news.

""" + RULES


ask_extra = ''


def ask(prompt, turns):
    # the open questions go in front of the rules, which end with the answer format
    if ask_extra:
        prompt = prompt.replace('Rules:' + chr(10), ask_extra + chr(10) + 'Rules:' + chr(10), 1)
        turns += 10
    env = dict(os.environ)
    if env.get('CLAUDE_CODE_OAUTH_TOKEN'):
        env['CLAUDE_CODE_OAUTH_TOKEN'] = re.sub(r'\s+', '', env['CLAUDE_CODE_OAUTH_TOKEN'])
    # None = the runner itself failed (usage limit, time-out, CLI error): the job stays queued and is not counted as a failure.
    # {}   = the model answered but not with a usable brief: the site counts a try.
    try:
        out = subprocess.run(['claude', '-p', 'Follow the instructions in the input; research on the web; reply with the JSON only.', '--model', MODEL,
                              '--allowedTools', 'WebSearch', 'WebFetch', '--max-turns', str(turns), '--output-format', 'json'],
                             input=prompt, cwd=tempfile.mkdtemp(prefix='rs-'), env=env, capture_output=True, text=True, timeout=1800)
        last = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1])
    except Exception as e:
        print('runner trouble:', type(e).__name__, file=sys.stderr)
        return None
    if out.returncode != 0 or last.get('is_error'):
        print('runner trouble:', str(last.get('subtype') or last.get('result') or out.returncode)[:120], file=sys.stderr)
        return None
    try:
        return json.loads(re.search(r'\{.*\}', last.get('result') or '', re.S).group(0))
    except Exception:
        return {}


CHECK = """You check answers before they are sent to sales people as an alert. Be strict: a wrong alert costs their trust.
Today is {today}. THE PROJECT: {project}

For each ANSWER below, open its source page and decide:
1. Does the page itself state the answer? (not an inference, not something from another page)
2. Is the page about THIS project (same owner, asset and country), not one with a similar name?
3. Is the date right, and is this the current position rather than old news that later events replaced?
Keep an answer only when all three hold. If the page cannot be opened, do not keep it.

ANSWERS:
{answers}

Reply with JSON only: {"keep": ["the keys of the answers that pass"], "dropped": [{"key": "", "why": "one line"}]}
"""


def checked(pj, qs, a):
    """Second pass: every answer to an open question is checked against its source before the site may alert on it."""
    keys = {str(q.get('key')) for q in qs}
    ans = [x for x in (a.get('questions') or []) if isinstance(x, dict) and str(x.get('key')) in keys
           and str(x.get('answer') or '').strip() and str(x.get('source') or '').startswith('http')]
    if not ans:
        return []
    by = {str(q.get('key')): q.get('q') for q in qs}
    lines = chr(10).join(json.dumps({'key': x['key'], 'question': by.get(str(x['key'])), 'answer': x['answer'], 'source': x['source'], 'date': x.get('date')}, ensure_ascii=False) for x in ans)
    global ask_extra
    ask_extra = ''
    v = ask(CHECK.replace('{today}', datetime.date.today().isoformat()).replace('{project}', json.dumps(pj, ensure_ascii=False)).replace('{answers}', lines), 5 + 3 * len(ans))
    keep = {str(k) for k in ((v or {}).get('keep') or [])}   # no verdict (runner trouble, bad JSON): keep none, the question stays open
    print(f"   answers: {len(ans)} given, {len([x for x in ans if str(x['key']) in keep])} passed the check", flush=True)
    return [x for x in ans if str(x['key']) in keep]


def one(r):
    pj = r.get('project') or {}
    today = datetime.date.today().isoformat()
    qs = r.get('questions') or []
    qblock = QUESTIONS.replace('{questions}', chr(10).join(json.dumps(x, ensure_ascii=False) for x in qs)) if qs else ''
    global ask_extra
    ask_extra = qblock
    if r.get('previous'):   # an update: a member's redo, new reports, or the daily web check of a followed project
        news = '\n'.join(json.dumps(x, ensure_ascii=False) for x in r.get('new_reports') or []) or '(none reached us: search the web for anything newer than the brief)'
        a = ask(UPDATE_PROMPT.replace('{today}', today).replace('{project}', json.dumps(pj, ensure_ascii=False))
                .replace('{previous_date}', (r.get('previous_date') or '')[:10]).replace('{previous}', json.dumps(r['previous'], ensure_ascii=False))
                .replace('{new_reports}', news), 20)
    else:
        reps = '\n'.join(json.dumps(x, ensure_ascii=False) for x in r.get('reports') or []) or '(none)'
        a = ask(PROMPT.replace('{today}', today).replace('{project}', json.dumps(pj, ensure_ascii=False)).replace('{reports}', reps), 40)
    if a is None:
        print(f"#{r['id']} project {pj.get('id')} -> not done, stays queued", flush=True)
        return None
    ok = bool(a.get('summary') and a.get('sources'))
    if ok:
        a['questions'] = checked(pj, qs, a) if qs else []
    res = pb.site('POST', 'rs-apply', body={'research_id': int(r['id']), 'ok': ok, 'report': a if ok else {}})
    print(f"#{r['id']} project {pj.get('id')} -> {res}", flush=True)   # ids and status only: the repository log is public
    return ok


def main():
    if '--count' in sys.argv:
        print(int(pb.site('GET', 'rs-queue', params={'peek': 1, 'n': BATCH}).get('waiting') or 0))
        return
    start = time.time(); done = bad = trouble = 0
    while done + bad < MAX and time.time() - start < MINUTES * 60 and trouble < 3:
        items = pb.site('GET', 'rs-queue', params={'n': BATCH}).get('items') or []
        if not items:
            break
        for r in items:
            res = one(r)
            if res is None:
                trouble += 1   # three in a row: most likely the usage limit; stop and let a later run go on
            else:
                trouble = 0
                done, bad = done + (1 if res else 0), bad + (0 if res else 1)
            if time.time() - start >= MINUTES * 60 or trouble >= 3:
                break
    if trouble >= 3:
        try:
            open(os.path.join(tempfile.gettempdir(), 'rs_trouble'), 'w').write('1')   # tells the workflow not to start the next run
        except OSError:
            pass
    print(f'{done} brief(s) written, {bad} unusable, {"stopped after runner trouble, " if trouble >= 3 else ""}{int(time.time() - start)} s')


if __name__ == '__main__':
    main()
