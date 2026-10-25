# -*- coding: utf-8 -*-
"""
v3_daily - per-day enrichment: verification / paid_eligible + project & event facts + own-words description.
Runs inside run_pipeline.py after classify and before the structured data is pushed to the site.

For every record of data/opportunities_<date>.json that has no `verification` yet:
  * official rows (wb- ted- fts- iati- ifc- cn-)  -> verification 'full', paid_eligible 1, description kept (module-built from facts)
  * media rows with a normal source URL           -> read the page (robots-gated), 2 model calls (extract + same-event match)
  * Google News rows                              -> find the publisher page with the Brave Search API (monthly cap 999,
                                                     spread over the month), then read it the same way
  Outcome per row:  full | project_only | limited.   paid_eligible = 1 only for 'full'.
  limited / project_only rows STAY in the database but are never sent to paid flows.
Rules shared with the backfill: first record per source_url gets the page facts (siblings stay limited), consistency audit,
event-label sanity check, descriptions <= 120 chars built in own words (template when the model text hugs the page/headline).
Fail-safe: any error -> every still-unverified row is marked 'limited' (never paid).

Usage:  python v3_daily.py --date 2026-10-19 [--file path] [--dry-run] [--no-brave]
"""
import os, re, sys, json, time, glob, logging, datetime, calendar, math
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
if os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1)
            os.environ.setdefault(k, v.strip().strip('"').strip("'"))

import requests
import backfill_v3 as bf
import fieldsv2
import eventcheck

log = logging.getLogger("v3_daily")
OFFICIAL_PREFIXES = ("wb-", "ted-", "fts-", "iati-", "ifc-", "cn-")
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_CAP = int(os.getenv("BRAVE_MONTHLY_CAP", "999"))
USAGE_FILE = "data/brave_usage.json"
PROJECT = ["owner", "site", "capacity", "reference_id", "program", "wb_project_id"]
EVENT = ["event_type", "value_amount", "value_unit", "value_currency", "value_basis"]
JSONF = ["key_dates", "contractors", "financiers"]
BAD_DOMAINS = ("facebook.com", "linkedin.com", "x.com", "twitter.com", "youtube.com", "instagram.com",
               "wikipedia.org", "reddit.com", "quiverquant.com", "marketscreener.com", "msn.com",
               "yahoo.com", "benzinga.com", "stocktitan.net", "tipranks.com", "investing.com",
               "news.google.com", "pinterest.com")

bf.save = lambda done: None            # the backfill's disk cache is not used for the daily run

# consistency audit (same function as audit_v3.py)
_ns = {"__file__": os.path.join(HERE, "audit_v3.py")}
exec(open("audit_v3.py", encoding="utf-8").read().split("\nrecs = {}")[0], _ns)
consistent = _ns["consistent"]


def trim(s, n=120):
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0].rstrip(" ,;:-") + "…"


# ── Brave ──────────────────────────────────────────────────────────────────────
def _month():
    return datetime.date.today().strftime("%Y-%m")


def brave_budget_today():
    """Queries allowed today: what is left of the monthly cap spread over the days left (>= 1 while any is left)."""
    usage = json.load(open(USAGE_FILE)) if os.path.exists(USAGE_FILE) else {}
    left = max(0, BRAVE_CAP - usage.get(_month(), 0))
    t = datetime.date.today()
    days_left = calendar.monthrange(t.year, t.month)[1] - t.day + 1
    return min(left, max(1, math.ceil(left / days_left))) if left else 0


def brave_count():
    usage = json.load(open(USAGE_FILE)) if os.path.exists(USAGE_FILE) else {}
    usage[_month()] = usage.get(_month(), 0) + 1
    json.dump(usage, open(USAGE_FILE, "w"), indent=1)


def brave_query(o):
    parts = [o.get("project_name", ""), o.get("company_name", "")]
    c = o.get("country", "")
    if c and c not in ("Unknown", "Global"):
        parts.append(c)
    return " ".join(p for p in parts if p).strip()


def brave_pick(results, o):
    comp = re.sub(r"[^a-z0-9]", "", (o.get("company_name") or "").lower())
    official, media = [], []
    for r in results:
        u = r.get("url", "")
        host = urlparse(u).netloc.lower()
        if not u or any(host.endswith(b) for b in BAD_DOMAINS):
            continue
        (official if comp and comp[:6] in re.sub(r"[^a-z0-9]", "", host) else media).append(u)
    return (official + media)[:2]


def brave_pages(o, state):
    key = os.getenv("BRAVE_API_KEY")
    if not key or state["left"] <= 0:
        return []
    state["left"] -= 1
    brave_count()
    try:
        r = requests.get(BRAVE_URL, params={"q": brave_query(o), "count": 8},
                         headers={"X-Subscription-Token": key, "Accept": "application/json"}, timeout=20)
        if r.status_code == 429:
            state["left"] = 0
            return []
        r.raise_for_status()
        time.sleep(1.1)
        return brave_pick(r.json().get("web", {}).get("results", []), o)
    except Exception as e:
        log.warning("Brave search failed: %s", str(e)[:80])
        return []


# ── official rows ──────────────────────────────────────────────────────────────
CN_RX = re.compile(r"^(?P<who>.+?) signed (?:an? )?(?P<kind>[^:]*?) contract(?: worth about US\$(?P<amt>[\d,\.]+)(?P<u>[MB]))?"
                   r"(?: with (?P<buyer>[^:]+?))?(?:: (?P<proj>.*))?$")
STAGE_EVENT = {"S4-Tender": "Tender", "S5-Awarded": "Award"}


def official_fill(o):
    o["verification"], o["paid_eligible"], o["description_source"] = "full", 1, "official"
    ev = STAGE_EVENT.get(o.get("stage") or "")
    if ev:
        o["event_type"] = ev
    if (o.get("article_id") or "").startswith("cn-"):
        m = CN_RX.match(o.get("description") or "")
        if m:
            g = m.groupdict()
            o["event_type"] = "Award"
            if g["buyer"]:
                o["owner"] = g["buyer"].strip()
            o["contractors"] = [{"name": g["who"].strip(), "role": "EPC" if "EPC" in (g["kind"] or "") else "contractor"}]
            if g["amt"]:
                o.update(value_amount=g["amt"].replace(",", ""), value_unit="million" if g["u"] == "M" else "billion",
                         value_currency="USD", value_basis="reported")


# ── media rows ─────────────────────────────────────────────────────────────────
def apply_result(o, v, st):
    """Write one backfill result onto the record (same rules as build_payload.py)."""
    status = v["fields_v3"] if v else "limited"
    if v:
        v = dict(v)
        v["contractors"] = [c if isinstance(c, dict) else {"name": str(c), "role": ""} for c in (v.get("contractors") or [])]
        v["financiers"] = [str(f.get("name", "")) if isinstance(f, dict) else str(f) for f in (v.get("financiers") or [])]
    if v and status == "full" and not consistent(o, v):
        for k in fieldsv2.EVENT_FIELDS:
            v.pop(k, None)
        v = dict(v, fields_v3="project_only", description_v3=fieldsv2.template_description(dict(o, **v), event_ok=False),
                 description_source="template")
        status = "project_only"
        st["audit-demoted"] += 1
    if v and status == "full" and eventcheck.event_conflicts(o.get("description"), v.get("event_type")):
        v = dict(v, event_type="Other")
        if v.get("description_source") != "official":
            v["description_v3"] = fieldsv2.template_description(dict(o, **v), event_ok=True)
            v["description_source"] = "template"
        st["event label neutralised"] += 1
    o["verification"] = status
    o["paid_eligible"] = 1 if status == "full" else 0
    o["description_source"] = (v or {}).get("description_source") or ""
    if v and status in ("full", "project_only"):
        for k in PROJECT:
            if v.get(k) not in (None, "", []):
                o[k] = v[k]
        for k in JSONF:
            if v.get(k):
                o[k] = v[k]
        if v.get("found_via") and v["found_via"] != o.get("source_url"):
            o["reference_url" if status == "full" else "project_ref_url"] = v["found_via"]
        if status == "full":
            for k in EVENT:
                if v.get(k) not in (None, ""):
                    o[k] = v[k]
        nd = trim(v.get("description_v3"))
        if v.get("description_source") == "template":      # richer fact sentences instead of the one-line label
            nd = fieldsv2.fact_text(dict(o, **v), event_ok=(status == "full"))
            v["description_source"] = "facts"
            o["description_source"] = "facts"
        if nd and nd != o.get("description"):
            o["description_original"] = o.get("description", "")     # local only; the ingest ignores unknown keys
            o["description"] = nd
    if status == "limited":      # unverified rows keep no publisher-like text: facts-only description (IP safety)
        nd = fieldsv2.fact_text(o, event_ok=False)
        if nd and nd != o.get("description"):
            o["description_original"] = o.get("description", "")
            o["description"] = nd
            o["description_source"] = "facts"
    st[status] += 1


def enrich(items, use_brave=True):
    import collections
    st = collections.Counter()
    todo = [o for o in items if not o.get("verification")]
    first_by_url, work = {}, []
    for o in todo:
        aid = o.get("article_id") or ""
        u = o.get("source_url") or ""
        if aid.startswith(OFFICIAL_PREFIXES):
            official_fill(o)
            st["official"] += 1
            continue
        if not u:
            o["verification"], o["paid_eligible"] = "limited", 0
            st["limited (no source url)"] += 1
            continue
        if u in first_by_url:                       # sibling record sharing an article: facts go to the first only
            o["verification"], o["paid_eligible"] = "limited", 0
            st["sibling left limited"] += 1
            continue
        first_by_url[u] = o
        work.append(o)
    # 2026-10-24 owner: media rows are verified on GitHub Actions (radar-v3, Claude Haiku 5.5 on the owner's subscription).
    # WTP_V3_MEDIA=actions leaves them unverified here (verification empty, not paid-eligible) for that job; remove the line
    # from .env (or set it to "server") to fall back to this server's OpenRouter extraction (gpt-4o-mini).
    if os.environ.get("WTP_V3_MEDIA", "server").strip().lower() == "actions":
        for o in work:
            o["_v3_actions"] = 1
        st["left for Actions (radar-v3)"] = len(work)
        log.info("v3: %d media rows left for GitHub Actions (WTP_V3_MEDIA=actions)", len(work))
        return st
    state = {"left": brave_budget_today() if use_brave else 0}
    log.info("v3: %d media rows to enrich, Brave budget today %d", len(work), state["left"])

    fetch_items = []
    for o in work:
        u = o["source_url"]
        if "news.google" in u:
            pages = brave_pages(o, state)
            if not pages:
                st["google news: no page found"] += 1
        else:
            pages = [u]
        fetch_items.append((u, o, pages))
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(bf.FETCH_WORKERS) as ex:
        fetched = list(ex.map(bf.fetch_stage, fetch_items))
    done, ready = {}, []
    for u, o, body, used in fetched:
        if body is None:
            # page unreadable: one Brave retry for normal URLs when budget is left
            alt = brave_pages(o, state) if (use_brave and "news.google" not in u and state["left"] > 0) else []
            if alt:
                u2, o2, body2, used2 = bf.fetch_stage((u, o, alt))
                if body2 is not None:
                    ready.append((u, o, body2, used2))
                    continue
            done[u] = {"fields_v3": "limited", "reason": used}
        else:
            ready.append((u, o, body, used))
    batches = [ready[i:i + bf.BATCH] for i in range(0, len(ready), bf.BATCH)]
    with ThreadPoolExecutor(bf.LLM_WORKERS) as ex:
        list(ex.map(lambda b: bf.llm_stage(b, done), batches))
    for u, o, _pages in fetch_items:
        apply_result(o, done.get(u), st)
    log.info("v3 result: %s", dict(st))
    return st


def fail_safe(items):
    n = 0
    for o in items:
        if o.get("_v3_actions"):
            continue                                   # verified later on GitHub Actions
        if not o.get("verification"):
            o["verification"], o["paid_eligible"] = "limited", 0
            n += 1
    return n


def run(date_str, path=None, use_brave=True, dry=False):
    path = path or os.path.join("data", f"opportunities_{date_str}.json")
    raw = json.load(open(path, encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("opportunities", [])
    try:
        st = enrich(items, use_brave)
    except Exception as e:
        log.error("v3 enrichment failed, marking unverified rows limited: %s", e, exc_info=True)
        st = {"error": str(e)[:100], "fail_safe_limited": fail_safe(items)}
    fail_safe(items)                                   # anything the run missed
    for o in items:
        o.pop("_v3_actions", None)
    if not dry:
        tmp = path + ".tmp"
        json.dump(raw, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    return dict(st)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    a = sys.argv
    d = a[a.index("--date") + 1] if "--date" in a else datetime.date.today().isoformat()
    f = a[a.index("--file") + 1] if "--file" in a else None
    print(run(d, f, use_brave="--no-brave" not in a, dry="--dry-run" in a))
