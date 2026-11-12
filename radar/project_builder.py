"""Project builder (2026-11-12): place every Infrastructure report into a PROJECT (wp_wtp_projects), or leave it unassigned.

Owner: customers follow projects, like deals in a CRM. The daily feed stores one row per article; this job decides, report by
report and oldest first, whether it is about a project we already have, a new project, or too vague to place. An AI (Claude
Code CLI on the owner's subscription, like the radar pipeline) gets a batch of reports from one country plus the candidate
projects of that country and answers in JSON. Hard rules in the prompt: a different operator, facility type, unit number or
capacity is a different project; unsure = "unconfirmed" (shown with a "?" to members), too vague = unassigned.

Site endpoints (snippet "WTP Projects table"): GET /wtp/v1/pb-queue, GET /wtp/v1/pb-projects, POST /wtp/v1/pb-apply.

Usage:
  python radar/project_builder.py [--country Mozambique,MZ] [--limit 400] [--from 2025-11-01] [--batch 8] [--dry] [--redo]
Env: WTP_BOT_SECRET (required), CLAUDE_CODE_OAUTH_TOKEN (Actions), PB_MODEL (default claude-sonnet-5-5)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = 'https://worldtradepro.com'
SECRET = os.environ.get('WTP_BOT_SECRET', '')
MODEL = os.environ.get('PB_MODEL', 'claude-sonnet-5-5')

ISO = {'SA': 'Saudi Arabia', 'AE': 'United Arab Emirates', 'UAE': 'United Arab Emirates', 'US': 'United States', 'USA': 'United States', 'GB': 'United Kingdom',
       'UK': 'United Kingdom', 'KR': 'South Korea', 'CN': 'China', 'IN': 'India', 'QA': 'Qatar', 'OM': 'Oman', 'KW': 'Kuwait', 'EG': 'Egypt', 'ID': 'Indonesia',
       'VN': 'Vietnam', 'AU': 'Australia', 'DE': 'Germany', 'FR': 'France', 'ES': 'Spain', 'IT': 'Italy', 'NL': 'Netherlands', 'PL': 'Poland', 'BR': 'Brazil',
       'MX': 'Mexico', 'CA': 'Canada', 'ZA': 'South Africa', 'NG': 'Nigeria', 'KE': 'Kenya', 'MA': 'Morocco', 'TR': 'Turkey', 'JP': 'Japan', 'PH': 'Philippines',
       'MY': 'Malaysia', 'TH': 'Thailand', 'PK': 'Pakistan', 'BD': 'Bangladesh', 'KZ': 'Kazakhstan', 'UZ': 'Uzbekistan', 'IQ': 'Iraq', 'MZ': 'Mozambique',
       'TZ': 'Tanzania', 'GH': 'Ghana', 'AO': 'Angola', 'SN': 'Senegal', 'SG': 'Singapore', 'TW': 'Taiwan', 'DZ': 'Algeria', 'NO': 'Norway', 'RO': 'Romania',
       'CL': 'Chile', 'PE': 'Peru', 'CO': 'Colombia', 'AR': 'Argentina', 'BH': 'Bahrain', 'JO': 'Jordan', 'LY': 'Libya', 'NA': 'Namibia', 'AZ': 'Azerbaijan'}
GENERIC = set('project projects plant unit units facility facilities phase new the and of for in at to a an with by contract award awarded tender epc '
              'expansion upgrade development construction lng gas oil power station solar wind farm park storage battery pipeline terminal refinery '
              'floating flng fpso offshore onshore campaign drilling play solution supply agreement'.split())


def country_of(r):
    c = (r.get('country') or '').strip()
    return ISO.get(c.upper(), c) if len(c) <= 3 else c


def site(method, path, params=None, body=None):
    params = dict(params or {}, secret=SECRET)
    url = f"{SITE}/wp-json/wtp/v1/{path}?{urllib.parse.urlencode(params)}"
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(4):
        try:
            if os.environ.get('GITHUB_ACTIONS'):
                raise RuntimeError('runner: use Node')   # python-requests from GitHub runners gets the Cloudflare challenge
            req = urllib.request.Request(url, data=data, method=method, headers={'User-Agent': 'wtp-linkedin-bot/1.0', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # Cloudflare challenge from GitHub runners: fall back to Node (radar/site.mjs passes the owner's rule)
            if os.path.exists(os.path.join(HERE, 'site.mjs')):
                req = {'method': method, 'path': f'/wp-json/wtp/v1/{path}', 'params': params}
                if body is not None:
                    req['body'] = body
                out = subprocess.run(['node', os.path.join(HERE, 'site.mjs')], input=json.dumps(req), capture_output=True, text=True, timeout=300)
                try:
                    j = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1])
                    if j['status'] < 300:
                        return json.loads(j['text'])
                except Exception:
                    pass
            if attempt == 3:
                raise
            time.sleep((5, 20, 60)[attempt])


def claude(prompt):
    env = dict(os.environ)
    if env.get('CLAUDE_CODE_OAUTH_TOKEN'):
        env['CLAUDE_CODE_OAUTH_TOKEN'] = re.sub(r'\s+', '', env['CLAUDE_CODE_OAUTH_TOKEN'])
    for attempt in range(3):
        out = subprocess.run(['claude', '-p', 'Follow the instructions in the input exactly and reply with the JSON only.', '--model', MODEL,
                              '--max-turns', '1', '--output-format', 'json'], input=prompt, cwd=tempfile.mkdtemp(prefix='pb-'),
                             env=env, capture_output=True, text=True, timeout=900)
        try:
            txt = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get('result') or ''
            m = re.search(r'\{.*\}', txt, re.S)
            return json.loads(m.group(0))
        except Exception:
            print('claude failed:', (out.stdout or out.stderr)[:300], file=sys.stderr)
            time.sleep(20 * (attempt + 1))
    return None


def tokens(s):
    return {t for t in re.findall(r'[a-z0-9]+', (s or '').lower().replace('norte', 'north').replace('sul', 'south')) if t not in GENERIC and len(t) > 2}


def op_key(s):
    s = re.sub(r'\(.*?\)', ' ', (s or '').lower())
    s = re.split(r',|;|/|\band\b|\bwith\b|-led\b|\bconsortium\b', s)[0]
    w = [t for t in re.findall(r'[a-z0-9&]+', s) if t not in ('the', 'group', 'company', 'co', 'corp', 'corporation', 'inc', 'ltd', 'limited', 'plc', 'sa', 'llc', 'energy', 'energies', 'national', 'state')]
    return w[0] if w else ''


def candidates(report, projects, k=25):
    rt = tokens(report['project_name'] + ' ' + (report.get('description') or '')[:300])
    ro = op_key(report.get('owner') or report.get('company_name'))
    scored = []
    for p in projects:
        pt = tokens(p['name'] + ' ' + ' '.join(p.get('reports_seen_as') or []) + ' ' + (p.get('location') or ''))
        s = len(rt & pt) + (3 if ro and ro == op_key(p.get('operator')) else 0)
        scored.append((s, p.get('last_seen') or '', p))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [p for s, _, p in scored[:k]]


PROMPT = """You maintain a database of capital PROJECTS (energy, mining, infrastructure, industrial plants) for equipment suppliers.
Each news report below must be placed: on an EXISTING project, on a NEW project, or left UNASSIGNED.

A project is one physical asset or one clearly defined phase/unit owned by one operator: e.g. "Coral South FLNG" (1st Eni FLNG,
Mozambique), "Coral Norte FLNG" (2nd), "third Rovuma FLNG unit" (3rd), "Rovuma LNG onshore plant (ExxonMobil)" are FOUR projects.

Hard rules - if any differs, it is NOT the same project:
- operator/owner (Eni vs ExxonMobil; a contractor named as "owner" in a report is not the operator - read the text),
- facility type (floating LNG vessel vs onshore LNG plant vs pipeline vs power plant vs solar farm),
- unit/train/phase number (Train 3 vs Train 4, 2nd vs 3rd FLNG, Phase 1 vs Phase 2),
- capacity (more than 30% apart, e.g. 6 mtpa vs 18 mtpa; 200 MW vs 278 MW),
- location (different field, block, city or site).
Reports about drilling/appraisal for a project's gas, its financing, offtake/supply agreements or equipment orders belong to that
project only when the text makes clear which project; otherwise leave them unassigned.
UNASSIGNED: too vague to identify one project (e.g. "FLNG", "Utility-Scale PV Plants", "Project update" with no operator, site or unit),
or not a capital project at all (share sale, M&A, trade cargo).

confidence: "confirmed" = the report clearly names this project (same operator and asset); "likely" = very probably this project;
"unconfirmed" = it may be this project but you are not sure (members will be asked). Prefer a new project over a wrong link.

For each report also give what it says about the project:
milestone (only if the report states it): M1 study/concept/feasibility/pre-FEED · M2 FEED awarded or under way, permits, EPC bidding
before FID · M3 FID taken / financial close / public funding approved (a public tender by a government or development bank implies M3)
· M4 EPC contract awarded and construction starting or under way · M5 in operation / commissioned.
proc (procurement event in THIS report, else ""): feed_tender · epc_tender (EPC/EPCI/EPCIC tender, pre-qualification, bidders
shortlisted) · epc_award (EPC contract awarded - say to whom in proc_note) · package (EPC contractor or owner ordering equipment
packages / long-lead items) · registration (vendor registration, call for EOI).
proc_date: the date of that event if stated, else the report date. status_event: "cancelled" or "on_hold" (also for a reported delay) or "".

New projects: a short standard name = operator + asset + facility + unit, e.g. "Eni Coral Norte FLNG (2nd Rovuma FLNG)",
"ExxonMobil Rovuma LNG onshore plant", "Transelectrica Mostistea 220/110 kV substation upgrade". Fill operator, country, location
(basin/block/field/city), facility, unit_no, capacity, sector and a one-sentence summary. Reports in this batch may share one new
project: use the same key ("n1", "n2", ...).

Reply with JSON only:
{"new_projects": [{"key": "n1", "name": "", "operator": "", "country": "", "location": "", "facility": "", "unit_no": "", "capacity": "", "sector": "", "summary": ""}],
 "placements": [{"report_id": 0, "decision": "link|new|unassigned", "project_id": null, "key": null, "confidence": "confirmed|likely|unconfirmed",
                 "reason": "one short sentence why", "milestone": "", "proc": "", "proc_date": "", "proc_note": "", "status_event": ""}]}

EXISTING PROJECTS in {country} (id, name, operator, location, facility, unit, capacity, milestone, also reported as):
{projects}

REPORTS to place (oldest first):
{reports}
"""


def fmt_project(p):
    return json.dumps({'id': int(p['id']), 'name': p['name'], 'operator': p.get('operator'), 'location': p.get('location'), 'facility': p.get('facility'),
                       'unit': p.get('unit_no'), 'capacity': p.get('capacity'), 'milestone': p.get('milestone'),
                       'also_reported_as': (p.get('reports_seen_as') or [])[:4]}, ensure_ascii=False)


def fmt_report(r):
    return json.dumps({'report_id': int(r['id']), 'date': r['report_date'], 'title': r['project_name'], 'operator_or_owner': r.get('owner') or r.get('company_name'),
                       'city': r.get('city'), 'sector': f"{r.get('sector') or ''} / {r.get('subsector') or ''}", 'stage_guess': r.get('stage'),
                       'event': r.get('event_type'), 'capacity': r.get('capacity'), 'contractors': r.get('contractors'),
                       'value': f"{r.get('value_amount') or ''} {r.get('value_unit') or ''} {r.get('value_currency') or ''}".strip(),
                       'text': (r.get('description') or '')[:700], 'source': r.get('source_name')}, ensure_ascii=False)


def run_batch(country, batch, projects, dry):
    cands = {}
    for r in batch:
        for p in candidates(r, projects):
            cands[int(p['id'])] = p
    prompt = PROMPT.replace('{country}', country).replace('{projects}', '\n'.join(fmt_project(p) for p in list(cands.values())[:40]) or '(none yet)') \
                   .replace('{reports}', '\n'.join(fmt_report(r) for r in batch))
    ans = claude(prompt)
    if not ans:
        print(f'  ! no answer for {len(batch)} reports in {country} - left in the queue')
        return []
    ids = {int(r['id']) for r in batch}
    links = []
    for x in ans.get('placements') or []:
        try:
            rid = int(x.get('report_id'))
        except (TypeError, ValueError):
            continue
        if rid not in ids:
            continue
        d = x.get('decision')
        link = {k: x.get(k) or '' for k in ('confidence', 'reason', 'milestone', 'proc', 'proc_date', 'proc_note', 'status_event')}
        link['report_id'] = rid
        if d == 'link' and x.get('project_id') and int(x['project_id']) in cands:
            link['project_id'] = int(x['project_id'])
        elif d == 'new' and x.get('key'):
            link['key'] = str(x['key'])
            link['confidence'] = link['confidence'] or 'confirmed'
        else:
            link['project_id'] = 0
            link['confidence'] = 'unassigned'
        links.append(link)
    new = [dict(p, country=p.get('country') or country) for p in ans.get('new_projects') or [] if p.get('key') and p.get('name')]
    for l in links:
        r = next(r for r in batch if int(r['id']) == l['report_id'])
        where = ('#' + str(l['project_id'])) if l.get('project_id') else ('NEW ' + next((p['name'] for p in new if p['key'] == l.get('key')), '?') if l.get('key') else 'UNASSIGNED')
        print(f"  {r['report_date']} #{r['id']} {r['project_name'][:45]:45} -> {where} [{l['confidence']}] {l['milestone']} {l['proc']} | {l['reason'][:90]}")
    if dry:
        return []
    res = site('POST', 'pb-apply', body={'new': new, 'links': links})
    made = []
    for p in new:
        pid = (res.get('keys') or {}).get(p['key'])
        if pid:
            made.append(dict(p, id=pid, reports_seen_as=[r['project_name'] for r in batch if any(l.get('key') == p['key'] and l['report_id'] == int(r['id']) for l in links)]))
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--country', default='', help='comma list, e.g. Mozambique,MZ')
    ap.add_argument('--limit', type=int, default=400)
    ap.add_argument('--from', dest='frm', default=(date.today() - timedelta(days=365)).isoformat())
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--redo', action='store_true', help='also retry unassigned reports')
    args = ap.parse_args()
    if not SECRET:
        sys.exit('WTP_BOT_SECRET is not set')
    queue = []
    for c in [x.strip() for x in args.country.split(',') if x.strip()] or ['']:
        q = {'from': args.frm, 'limit': args.limit}
        if c:
            q['country'] = c
        if args.redo:
            q['redo'] = 1
        j = site('GET', 'pb-queue', q)
        queue += j.get('items') or []
        print(f"queue {c or 'all'}: {len(j.get('items') or [])} now, {j.get('left')} left")
    queue.sort(key=lambda r: (r['report_date'], int(r['id'])))
    queue = queue[:args.limit]
    by_country = defaultdict(list)
    for r in queue:
        by_country[country_of(r) or 'Unknown'].append(r)
    projects = defaultdict(list)
    for p in site('GET', 'pb-projects').get('items') or []:
        projects[country_of({'country': p.get('country')}) or 'Unknown'].append(p)
    done = 0
    for country, rows in sorted(by_country.items(), key=lambda kv: -len(kv[1])):
        print(f'{country}: {len(rows)} reports, {len(projects[country])} projects so far')
        for i in range(0, len(rows), args.batch):
            made = run_batch(country, rows[i:i + args.batch], projects[country], args.dry)
            projects[country] += made
            done += len(rows[i:i + args.batch])
    print(f'done: {done} reports processed')


if __name__ == '__main__':
    main()
