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

A second rule catches the long-running project that similarity misses: months of reports about
different events (financing, an award, an equipment order) under the same project name, e.g.
"Dangote Refinery" x17. Rows in one country whose NAMES have the same distinctive words, the same
sector words and the same numbers are one project - unless the name has no proper noun ("Wind
Farm", "LNG Carriers"), it is a ship order, or the stated capacities differ ("Oklahoma Solar Farm"
278 MW vs 200 MW are two farms).

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
import time
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
# Only used by the same-name rule. NAME_GENERIC: descriptive words that are never a project's proper noun.
# NAME_REGIONS: states / provinces - not a proper noun either (a "Rajasthan Solar Project" is any solar project in
# Rajasthan), but two different regions in two names mean two projects ("Graphite One Alaska" / "Graphite One Ohio").
NAME_GENERIC = set('''subsea tender tenders repair import export floating unit units program programme portfolio order orders supply
repowering gas-to-power lng-to-power waste-to-energy ipp iwpp aussie community utility-scale hybrid pilot giga gigafactory green blue
fpso fso flng fsru gtl lower upper greater new one facility
gulf sea north south east west central northern southern eastern western'''.split())
NAME_REGIONS = set('''rajasthan gujarat maharashtra karnataka tamil nadu andhra pradesh odisha telangana uttar madhya punjab kerala assam bihar
texas louisiana oklahoma california massachusetts alaska arizona nevada florida ohio michigan indiana kentucky virginia georgia
carolina dakota wyoming montana colorado utah oregon washington york jersey mexico pennsylvania illinois iowa kansas alabama
queensland victoria tasmania nsw wales territory alberta ontario quebec québec columbia saskatchewan manitoba newfoundland
scotland england ireland bavaria saxony sicily sardinia andalusia catalonia galicia siberia anatolia sumatra java borneo
sindh balochistan xinjiang xizang guangdong shandong jiangsu zhejiang mongolia hokkaido kyushu'''.split())
# what kind of asset the name says: "Petrobras FPSO" and "Petrobras Subsea Tender" share only the company
NAME_KIND = set('fpso fso flng fsru gtl subsea tender repair repowering import export'.split())
SAME_NAME_DAYS = 14       # identical name + country this close together = one event, proper noun or not
CAPACITY_RE = re.compile(r"(\d+(?:\.\d+)?)[\s-]*(gw|mw)p?\b", re.I)   # "230-MW", "235-MWp", "1 GW"
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
    # pass 3: one named project reported again and again (see the module docstring)
    def name_key(i):
        r = rows[i]
        name = (r.get('project_name') or '').lower().replace('e&a', 'ena')
        if no_ctry[i] or ship[i]:
            return None
        nums = sorted(set(re.findall(r"\b(\d{1,4}|i{2,3}|iv|vi{0,3})\b", name)))        # "Hornsea 3" is not "Hornsea 2"
        codes = [a + b for a, b in CODE_RE.findall(name) if a not in UNITS]
        words = [t for t in TOKEN_RE.findall(CODE_RE.sub(' ', name)) if not t.isdigit() and len(t) > 2]
        common = GENERIC | DOMAIN | place | NAME_GENERIC | NAME_REGIONS

        def is_proper(t):
            if t in common or re.fullmatch(r"i{2,3}|iv|vi{0,3}", t):
                return False
            return not all(part in common or part.rstrip('s') in common for part in t.split('-'))   # "solar-storage"
        proper = frozenset(codes + [t for t in words if is_proper(t)])
        if not proper:
            return None
        kind = frozenset(t.rstrip('s') for t in words if (t in DOMAIN and t not in ('offshore', 'onshore')) or t.rstrip('s') in NAME_KIND)
        return ctry[i], proper, kind, tuple(nums), frozenset(t for t in words if t in NAME_REGIONS)

    def exact_key(i):
        if no_ctry[i] or ship[i]:
            return None
        name = re.sub(r"[^a-z0-9]+", ' ', (rows[i].get('project_name') or '').lower()).strip()
        return (ctry[i], name) if len(name) > 5 else None

    def capacity(group):
        out = set()
        for i in group:
            text = (rows[i].get('project_name') or '') + ' ' + (rows[i].get('description') or '')
            out |= {round(float(v) * (1000 if u.lower() == 'gw' else 1)) for v, u in CAPACITY_RE.findall(text)}
        return out

    def capacity_conflict(A, B):
        a, b = capacity(A), capacity(B)
        return bool(a and b) and not any(abs(x - y) <= 0.3 * max(x, y) for x in a for y in b)

    root_of = {i: root for root, g in groups.items() for i in g}
    by_name = defaultdict(list)
    for i in sorted(range(n), key=lambda i: (day[i], int(rows[i]['id']))):
        k = name_key(i)
        if k:
            by_name[k].append(i)
    by_exact = defaultdict(list)
    for i in sorted(range(n), key=lambda i: (day[i], int(rows[i]['id']))):
        k = exact_key(i)
        if k:
            by_exact[k].append(i)
    for max_gap, table in ((WINDOW_DAYS, by_name), (SAME_NAME_DAYS, by_exact)):
        for members in table.values():
            for prev, cur in zip(members, members[1:]):
                a, b = root_of[prev], root_of[cur]
                if a == b or day[cur] - day[prev] > max_gap or capacity_conflict(groups[a], groups[b]):
                    continue
                keep, drop = (a, b) if (day[groups[a][0]], a) <= (day[groups[b][0]], b) else (b, a)
                groups[keep] = sorted(groups[keep] + groups[drop], key=lambda i: (day[i], int(rows[i]['id'])))
                for i in groups.pop(drop):
                    root_of[i] = keep
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
        for attempt in range(5):  # the host sometimes answers with an HTML error page instead of JSON
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    j = json.load(r)
                break
            except (ValueError, OSError) as e:
                if attempt == 4:
                    raise
                wait = (5, 15, 45, 90)[attempt]
                print(f'fetch failed ({e}); retry in {wait}s', file=sys.stderr)
                time.sleep(wait)
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
