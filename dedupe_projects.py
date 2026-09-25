"""Merge duplicate Infrastructure (epc) projects across days and outlets.

The pipeline stores one row per article, so one project covered by eight outlets over two days
becomes eight rows (e.g. Samsung E&A's SAN-7 fertilizer award). This job recomputes ALL clusters
every run and sends them to the site (POST /wtp/v1/opps-dedupe), which marks each duplicate row
with dup_of = the project's first-seen row. Nothing is deleted; the API then shows one row per project.

A row joins a project when, within the same country:
  - they share a distinctive name (project, company or code such as "SAN-7") - generic words like
    "LNG", "wind farm", country names or amounts never count on their own,
  - no conflicting money amounts are mentioned,
  - TF-IDF similarity of name + company + description clears the bar (stricter for reports more
    than 7 days apart, for rows without a country, and for ship orders, which look alike but differ).

Usage:
  python dedupe_projects.py [--dry] [--input rows.json] [--site URL]
Env: WTP_BOT_SECRET (required unless --input and --dry)
"""
import argparse
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, timedelta

TH = 0.55                 # base similarity bar (tuned on the Mar-Sep 2026 archive: ~10% rows merged)
TH_NO_COUNTRY = 0.15      # extra bar when the country is unknown
TH_SHIP = 0.15            # extra bar for ship orders (many look-alike but different deals)
GAP_PENALTY = 0.12        # reports more than 7 days apart need stronger evidence
WINDOW_DAYS = 120         # never merge reports further apart than this
ANCHOR_MAX_DF = 40        # a word used by more rows than this is too common to identify a project

ISO = {'SA': 'saudi arabia', 'AE': 'united arab emirates', 'UAE': 'united arab emirates', 'US': 'united states', 'USA': 'united states',
       'GB': 'united kingdom', 'UK': 'united kingdom', 'KR': 'south korea', 'CN': 'china', 'IN': 'india', 'RO': 'romania', 'BA': 'bosnia and herzegovina',
       'QA': 'qatar', 'OM': 'oman', 'KW': 'kuwait', 'EG': 'egypt', 'ID': 'indonesia', 'VN': 'vietnam', 'AU': 'australia', 'DE': 'germany', 'FR': 'france',
       'ES': 'spain', 'IT': 'italy', 'NL': 'netherlands', 'PL': 'poland', 'BR': 'brazil', 'MX': 'mexico', 'CA': 'canada', 'ZA': 'south africa', 'NG': 'nigeria',
       'KE': 'kenya', 'MA': 'morocco', 'TR': 'turkey', 'JP': 'japan', 'PH': 'philippines', 'MY': 'malaysia', 'TH': 'thailand', 'PK': 'pakistan', 'BD': 'bangladesh',
       'KZ': 'kazakhstan', 'UZ': 'uzbekistan', 'IQ': 'iraq', 'IR': 'iran', 'RU': 'russia', 'UA': 'ukraine', 'CL': 'chile', 'PE': 'peru', 'CO': 'colombia',
       'AR': 'argentina', 'NO': 'norway', 'DK': 'denmark', 'GR': 'greece', 'CY': 'cyprus', 'MZ': 'mozambique', 'TZ': 'tanzania', 'GH': 'ghana', 'AO': 'angola',
       'SN': 'senegal', 'NZ': 'new zealand', 'SG': 'singapore', 'TW': 'taiwan', 'DZ': 'algeria', 'ET': 'ethiopia', 'LK': 'sri lanka', 'AZ': 'azerbaijan', 'NA': 'namibia',
       'CI': "cote d'ivoire", 'IL': 'israel', 'JO': 'jordan', 'BH': 'bahrain', 'LY': 'libya', 'TN': 'tunisia', 'ZM': 'zambia', 'ZW': 'zimbabwe', 'UG': 'uganda'}

GENERIC = set('''project projects plant plants contract contracts epc award awarded awards wins win won secures secure secured signs signed sign
new major first phase stage development develop developing construction construct build building built facility facilities complex expansion upgrade
billion bn million mn usd us dollar dollars worth value valued deal agreement company group ltd limited inc corp corporation plc sa ag co
the and for with from that this into over its their has have will under after amid about more than to of in on at by as a an is are be to
approval approved approves plan plans planned planning begins begin began start starts started launch launches launched announces announced
advances advance moves move set sets gets get receive receives received tender tenders bid bids bidding study feasibility final investment decision fid
capacity power energy mw gw km mtpa tpd year years per day'''.split())
# Sector words: they count towards similarity but can never be the only link between two rows.
DOMAIN = set('''lng carrier carriers container containers ship ships vessel vessels newbuild newbuilds newbuilding order orders tanker tankers bulk bulker
wind farm farms offshore onshore solar hydrogen green pipeline pipelines refinery refineries battery batteries storage bess data center centre centers
port ports terminal terminals railway railways rail airport airports highway highways road roads bridge bridges metro line lines grid transmission substation
mine mines mining copper gold lithium nickel iron ore fertilizer fertiliser ammonia urea methanol steel smelter cement hospital water desalination treatment
gas oil crude petrochemical petrochemicals chemical chemicals electrolyser electrolyzer nuclear hydro hydropower dam coal thermal station stations shipyard yard
kamsarmax panamax capesize ultramax supramax aframax suezmax vlcc vlgc bunkering bunker turbine turbines module modules equipment epcic epcm feed o&m
maintenance operation operations lease leasing loan financing design engineering services supply installation foundation foundations cable cables tank tanks
train trains capacity backup gwh tonnes tons dry dock'''.split())
DEMONYMS = set('''saudi emirati omani qatari kuwaiti bahraini iraqi iranian egyptian moroccan algerian nigerian kenyan ghanaian tanzanian
south north east west african asian european american chinese indian japanese korean vietnamese thai malaysian indonesian filipino philippine
australian canadian mexican brazilian chilean peruvian argentine colombian german french italian spanish polish dutch norwegian danish swedish
finnish greek turkish russian ukrainian romanian hungarian czech british scottish irish uzbek kazakh pakistani bangladeshi sri gulf middle
africa asia europe america mena gcc region regional national'''.split())
UNITS = set('mw gw kw mwh gwh km bn mn us usd eur aud cad gbp sar aed krw inr cny rmb phase stage train unit units line lines block blocks '
            'ship ships vessel vessels mtpa bcf tcf ktpa kv'.split())
CODE_RE = re.compile(r"\b([a-z]{2,6})[- ]?(\d{1,2})\b(?![.,]?\d)")   # "SAN-7" / "SAN 7" / "JHB2" -> "san7"
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9&\-]+")
AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(bn|billion|mn|million|m\b|gw|mw|mtpa)", re.I)
SHIP_RE = re.compile(r"newbuild|shipyard|fleet|carrier|tanker|vessel|fsru")


def country_key(c):
    c = (c or '').strip()
    return ISO.get(c.upper(), c.lower()) if len(c) <= 3 else c.lower().replace('côte', 'cote')


def tokens(r):
    txt = ' '.join([r.get('project_name') or '', r.get('company_name') or '', r.get('description') or '']).lower()
    txt = txt.replace('e&a', 'ena')
    codes = [a + b for a, b in CODE_RE.findall(txt) if a not in UNITS]
    txt = CODE_RE.sub(' ', txt)
    return codes + [t for t in TOKEN_RE.findall(txt) if t not in GENERIC and not t.isdigit() and len(t) > 2]


def amounts(r):
    out = set()
    for v, u in AMOUNT_RE.findall((r.get('description') or '') + ' ' + (r.get('project_name') or '')):
        u, v = u.lower(), float(v)
        if u in ('bn', 'billion'):
            out.add(('usd', round(v, 1)))
        elif u in ('mn', 'million', 'm'):
            out.add(('usd', round(v / 1000, 1)))
        elif u == 'gw':
            out.add(('w', round(v * 1000)))
        elif u == 'mw':
            out.add(('w', round(v)))
        elif u == 'mtpa':
            out.add(('t', round(v, 1)))
    return out


def cluster(rows):
    """Return lists of row indexes, each list = one project (sorted first-seen first)."""
    n = len(rows)
    docs = [Counter(tokens(r)) for r in rows]
    df = Counter(t for d in docs for t in d)
    idf = {t: math.log(n / (1 + c)) for t, c in df.items()}
    vecs = []
    for d in docs:
        v = {t: (1 + math.log(c)) * idf[t] for t, c in d.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({t: x / norm for t, x in v.items()})
    amts = [amounts(r) for r in rows]
    day = [date.fromisoformat(r['report_date']).toordinal() for r in rows]
    ctry = [country_key(r.get('country')) for r in rows]
    place = set(DEMONYMS)
    for c in set(ctry):
        place |= set(re.findall(r"[a-z]+", c))
    anc = [{t for t in v if t not in DOMAIN and t not in place and df[t] <= ANCHOR_MAX_DF
            and (not re.search(r'\d', t) or re.fullmatch(r'[a-z]{2,6}\d{1,2}', t))} for v in vecs]
    ship = [bool(SHIP_RE.search(((r.get('subsector') or '') + ' ' + (r.get('project_name') or '')).lower())) for r in rows]
    no_ctry = [c in ('', 'unknown', 'global') for c in ctry]

    def sim(i, j):
        a, b = vecs[i], vecs[j]
        if len(a) > len(b):
            a, b = b, a
        s = sum(x * b.get(t, 0) for t, x in a.items())
        if amts[i] & amts[j]:
            s += 0.15
        if abs(day[i] - day[j]) > 7:
            s -= GAP_PENALTY
        return s

    def usd(i):
        return {v for k, v in amts[i] if k == 'usd'}

    def conflict(i, j):
        a, b = usd(i), usd(j)
        return bool(a and b) and not any(abs(x - y) <= 0.3 * max(x, y) for x in a for y in b)

    def bar(group):
        return TH + (TH_NO_COUNTRY if any(no_ctry[i] for i in group) else 0) + (TH_SHIP if any(ship[i] for i in group) else 0)

    def can_join(A, B):
        if abs(day[A[0]] - day[B[0]]) > WINDOW_DAYS and abs(day[A[-1]] - day[B[0]]) > WINDOW_DAYS:
            return None
        if not any(anc[i] & anc[j] for i in A for j in B):
            return None
        if any(conflict(i, j) for i in A for j in B):
            return None
        return max(sim(i, j) for i in A for j in B)

    # pass 1: chronological, each row joins its best existing project or starts a new one
    groups, by_country = {}, defaultdict(list)
    for i in sorted(range(n), key=lambda i: (day[i], int(rows[i]['id']))):
        best, best_s = None, 0
        for root in by_country[ctry[i]]:
            if day[i] - day[groups[root][-1]] > WINDOW_DAYS:
                continue
            s = can_join([i], groups[root])
            if s is not None and s > best_s:
                best, best_s = root, s
        if best is not None and best_s >= bar([i] + groups[best][:1]):
            groups[best].append(i)
        else:
            groups[i] = [i]
            by_country[ctry[i]].append(i)
    # pass 2: a row seen before its best match (same day, lower id) started its own project - merge those
    changed = True
    while changed:
        changed = False
        for roots in by_country.values():
            for a in list(roots):
                for b in list(roots):
                    if a == b or a not in groups or b not in groups:
                        continue
                    A, B = groups[a], groups[b]
                    s = can_join(A, B)
                    if s is not None and s >= bar(A + B):
                        keep, drop = (a, b) if (day[A[0]], a) <= (day[B[0]], b) else (b, a)
                        groups[keep] = sorted(groups[keep] + groups[drop], key=lambda i: (day[i], int(rows[i]['id'])))
                        del groups[drop]
                        roots.remove(drop)
                        changed = True
    return [g for g in groups.values() if len(g) > 1]


def stage_rank(s):
    m = re.match(r'S(\d)', s or '')
    return int(m.group(1)) if m else 0


def summarize(rows, group):
    members = [rows[i] for i in group]
    # the project's row = first seen; same-day ties go to the most informative report
    first = min(members, key=lambda r: (r['report_date'], -len(r.get('description') or ''), int(r['id'])))
    latest = max(members, key=lambda r: (stage_rank(r.get('stage')), r['report_date']))
    sources, seen = [], set()
    for r in members:
        url = r.get('source_url') or ''
        host = urllib.parse.urlparse(url).netloc.replace('www.', '')
        name = (r.get('source_name') or host or '').strip()
        key = name.lower() or url
        if key and key not in seen:
            seen.add(key)
            sources.append({'name': name, 'url': url})
    return {
        'id': int(first['id']),
        'members': [int(r['id']) for r in members],
        'latest_stage': latest.get('stage') or first.get('stage') or '',
        'last_seen': max(r['report_date'] for r in members),
        'sources': sources[:8],
    }


def fetch_all(site, secret):
    rows, offset = [], 0
    to = (date.today() + timedelta(days=2)).isoformat()
    while True:
        q = urllib.parse.urlencode({'report_type': 'epc', 'from': '2020-01-01', 'to': to, 'limit': 10000,
                                    'offset': offset, 'include_dups': 1, 'secret': secret})
        req = urllib.request.Request(f"{site}/wp-json/wtp/v1/opportunities?{q}", headers={'User-Agent': 'wtp-linkedin-bot/1.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.load(r)
        rows += j.get('items') or []
        if not j.get('truncated'):
            return rows
        offset = len(rows)


def push(site, secret, clusters):
    body = json.dumps({'report_type': 'epc', 'clusters': clusters}).encode()
    req = urllib.request.Request(f"{site}/wp-json/wtp/v1/opps-dedupe?secret={urllib.parse.quote(secret)}", data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'wtp-linkedin-bot/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true', help='compute and print, do not write to the site')
    ap.add_argument('--input', help='read rows from a JSON file instead of the API')
    ap.add_argument('--site', default=None)
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    site = (args.site or json.load(open(os.path.join(here, 'config.json'), encoding='utf-8'))['site']).rstrip('/')
    secret = os.environ.get('WTP_BOT_SECRET', '')
    if not secret and not (args.input and args.dry):
        sys.exit('WTP_BOT_SECRET is not set')

    rows = json.load(open(args.input, encoding='utf-8')) if args.input else fetch_all(site, secret)
    rows = [r for r in rows if r.get('report_type', 'epc') == 'epc' and r.get('report_date')]
    groups = cluster(rows)
    clusters = [summarize(rows, g) for g in groups]
    marked = sum(len(c['members']) - 1 for c in clusters)
    print(f"{len(rows)} rows -> {len(rows) - marked} projects ({len(clusters)} merged, {marked} duplicate rows)")
    for c in sorted(clusters, key=lambda c: -len(c['members']))[:5]:
        first = next(r for r in rows if int(r['id']) == c['id'])
        print(f"  {len(c['members'])} reports: {first['project_name']} ({first.get('country')}) -> {c['latest_stage']}, last seen {c['last_seen']}")
    if args.dry:
        return
    print('site:', push(site, secret, clusters))


if __name__ == '__main__':
    main()
