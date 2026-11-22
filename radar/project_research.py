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
 "key_questions": [{"key": "s1", "answer": "one or two sentences, or empty when no dated public source states it", "source": "https://... the one page that states it", "date": "date of that page",
                    "final": "true when the matter is settled (a decision taken, a contract awarded, a date passed), else false"}],
 "not_found": ["what you looked for and did not find"],
 "sources": [{"title": "publisher and headline", "url": "https://...", "date": ""}]}
Give 5 to 15 sources. Leave a list empty rather than fill it with guesses.
"key_questions": one entry for EVERY key question listed above, in the same order, with its key. Research each of them on
purpose: they are what a sales person asks first. Give what is known so far even when the matter is not settled (for example
"Not yet. Two groups are doing competing FEEDs; the owner plans to choose in Q2 2027."). Leave "answer" empty only when no
dated public source states anything on it; never fill it from inference.
Write every answer as a plain statement of what the source reports, and name the source in the sentence when it is a news
report ("Upstream reported in Jun 2026 that three Asian yards will bid."). Never write "I" or "we" and never describe your
search ("I found no ...", "could not verify"). When sources disagree, give both with their dates.
"""

STD = """
KEY QUESTIONS every brief answers (see "key_questions" in the answer format):
{std}
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


ANSWER = """You answer the key questions sales people have on ONE capital project they are working on. Today is {today}.

THE PROJECT: {project}

THE RESEARCH BRIEF WE HOLD (written today, with its sources):
{brief}

THE QUESTIONS ("known" = what we told them so far; empty = nothing yet):
{questions}

Go through EVERY question, one by one:
1. Look in the brief and its sources first. Most basic questions are answered there.
2. Then search the web for that question specifically (the owner, its partners, contractors and suppliers, tender portals,
   filings, trade and local press).
Give an answer whenever a dated public source states it, in full or in part. Also say what is known so far when the matter is
not settled, for example "Not yet. Two groups are doing competing FEEDs; the owner plans to choose in Q2 2027."
Do not answer from inference or from your own memory: every answer needs a source page that states it. A rumour counts only if
the answer says who reports it and that it is not confirmed. Never name individual people.
Return one entry for EVERY question, in the same order. Leave "answer" empty when you found nothing, and for a question that
has "known" when no source says anything NEW or different from it.
Sources: prefer the owner's or a partner's own page, a regulator, a filing or a development bank over a news article, and
prefer pages that open without a login.
Plain English, one or two short sentences per answer.
Write every answer as a plain statement of what the source reports, and name the source in the sentence when it is a news
report ("Upstream reported in Jun 2026 that three Asian yards will bid."). Never write "I" or "we" and never describe your
search ("I found no ...", "could not verify"). When sources disagree, give both with their dates.

Reply with JSON only:
{"questions": [{"key": "the question's key", "answer": "", "source": "https://... the one page that states it", "date": "date of that page",
                "final": true or false}]}
final = true when the matter is settled (a decision taken, a contract awarded, a date passed); false when it can still change.
"""


def answers(pj, brief, qs):
    """A pass of its own for the key questions: asked along with the brief, the model answered only a few of them."""
    global ask_extra
    ask_extra = ''
    b = {k: brief.get(k) for k in ('summary', 'status', 'key_questions', 'stage', 'timeline', 'parties', 'procurement', 'next_steps', 'competitors', 'risks', 'not_found', 'sources')}
    v = ask(ANSWER.replace('{today}', datetime.date.today().isoformat()).replace('{project}', json.dumps(pj, ensure_ascii=False))
            .replace('{brief}', json.dumps(b, ensure_ascii=False)).replace('{questions}', chr(10).join(json.dumps(x, ensure_ascii=False) for x in qs)), 45)
    return [x for x in ((v or {}).get('questions') or []) if isinstance(x, dict)]


CHECK = """You check answers before they are shown to sales people and sent to them as an alert. Today is {today}.
THE PROJECT: {project}

For each ANSWER below, open its source page and give one verdict:
- "ok": the page states the facts the answer rests on, it is about THIS project (same owner, asset and country, not one with
  a similar name), and it is the current position, not old news that later events replaced. The wording may differ; the
  facts must be there. An answer of the kind "not yet, the target is ..." is ok when the page gives that target or status.
- "wrong": you read the page and it does not support the answer, or it is about another project, or a later event you know
  from a dated source replaced it. Say why in one line.
- "unread": the page could not be opened (blocked, login, error). Then search the web for another page that states the same
  facts; if you find one, give verdict "ok" and put that page in "source". If you find none, keep "unread".

ANSWERS:
{answers}

Reply with JSON only: {"verdicts": [{"key": "", "verdict": "ok | wrong | unread", "source": "only when you replaced the source", "why": "one line, for wrong"}]}
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
    v = ask(CHECK.replace('{today}', datetime.date.today().isoformat()).replace('{project}', json.dumps(pj, ensure_ascii=False)).replace('{answers}', lines), 15 + 5 * len(ans))
    vd = {str(x.get('key')): x for x in ((v or {}).get('verdicts') or []) if isinstance(x, dict)}
    out = []; n = {'ok': 0, 'wrong': 0, 'quiet': 0}
    for x in ans:
        d = vd.get(str(x['key'])) or {}
        verdict = str(d.get('verdict') or '').strip().lower()
        if verdict == 'wrong':
            n['wrong'] += 1   # read and not supported: the question stays open
            continue
        if verdict == 'ok':
            n['ok'] += 1
            if str(d.get('source') or '').startswith('http'):
                x = dict(x, source=d['source'])
            out.append(x)
        else:   # unread, or no verdict at all: shown on the member's page with its source, never sent as an alert
            n['quiet'] += 1
            out.append(dict(x, quiet=True))
    print(f"   answers: {len(ans)} given, {n['ok']} confirmed, {n['quiet']} shown without alert, {n['wrong']} dropped", flush=True)
    return out

def one(r):
    pj = r.get('project') or {}
    today = datetime.date.today().isoformat()
    qs = r.get('questions') or []
    qblock = QUESTIONS.replace('{questions}', chr(10).join(json.dumps(x, ensure_ascii=False) for x in qs)) if qs else ''
    global ask_extra
    # the ten standard questions go into every brief; followers' open questions get a pass of their own afterwards (answers())
    ask_extra = STD.replace('{std}', chr(10).join(json.dumps(x, ensure_ascii=False) for x in r.get('std') or [])) if r.get('std') else ''
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
        a['questions'] = checked(pj, qs, {'questions': answers(pj, a, qs)}) if qs else []
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
