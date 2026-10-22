# -*- coding: utf-8 -*-
"""
Radar enrichment - runs on GitHub Actions (Claude subscription via the `claude` CLI, no API bill).

For project rows that the server pipeline could not verify (verification = 'limited'):
  1. Brave Search finds candidate pages (budget-capped per month, kept in state/radar_brave.json)
  2. the pages are read with the honest, robots-gated fetcher (bot-blocked pages simply fail - we never work around a block)
  3. Claude decides, in ONE call per small batch, whether a page is about the same project and extracts the facts
  4. program checks (numbers must be on the page, no copied wording, project/company name present, page date near the news date)
  5. result goes back through the site's  PATCH /wp-json/wtp/v1/opportunities-v3  (compare-and-set on the live description)
     verification full -> paid_eligible 1 ; project_only / limited -> stays out of the paid flows.
Writes only when RADAR_WRITE=true; otherwise it is a dry run that only prints/uploads a report.
Rows tried once are recorded in state/radar_tried.json and not searched again for 30 days.

Env: WTP_BOT_SECRET (site shared secret), BRAVE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, optional RADAR_MAX (rows per run, 40),
RADAR_DAYS (look-back days, 4), RADAR_BACKLOG (1 = also older rows, newest first), RADAR_BRAVE_CAP (per month, 150), RADAR_MODEL.
"""
import os, re, sys, json, time, subprocess, datetime, calendar, difflib, tempfile, collections
from urllib.parse import urlparse
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("BODY_CHARS", "6000")
import fetcher, fieldsv2

SITE = "https://worldtradepro.com"
SECRET = os.environ.get("WTP_BOT_SECRET", "").strip()
BRAVE = os.environ.get("BRAVE_API_KEY", "").strip()
MAX_ROWS = int(os.environ.get("RADAR_MAX", "40"))
DAYS = int(os.environ.get("RADAR_DAYS", "4"))
BACKLOG = os.environ.get("RADAR_BACKLOG", "0") == "1"
BRAVE_CAP = int(os.environ.get("RADAR_BRAVE_CAP", "150"))
WRITE = os.environ.get("RADAR_WRITE", "false").lower() == "true"
MODEL = os.environ.get("RADAR_MODEL", "claude-sonnet-5-5")
STATE = os.path.join(os.path.dirname(HERE), "state")
os.makedirs(STATE, exist_ok=True)
TRIED_F, BRAVE_F = os.path.join(STATE, "radar_tried.json"), os.path.join(STATE, "radar_brave.json")
NL = chr(10)

BAD = ("facebook.com", "linkedin.com", "x.com", "twitter.com", "youtube.com", "instagram.com", "wikipedia.org", "reddit.com", "quiverquant.com",
       "marketscreener.com", "msn.com", "yahoo.com", "benzinga.com", "stocktitan.net", "tipranks.com", "investing.com", "news.google.com", "pinterest.com",
       "seekingalpha.com", "tradingview.com", "baxtel.com", "arizton.com", "credenceresearch.com", "company-information.service.gov.uk", "opencorporates.com",
       "crunchbase.com", "zoominfo.com", "dnb.com", "glassdoor.com", "indeed.com", "tiktok.com")


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def save(p, o):
    json.dump(o, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def get_rows():
    rows, off = [], 0
    frm = "2026-01-01" if BACKLOG else (datetime.date.today() - datetime.timedelta(days=DAYS)).isoformat()
    while True:
        q = {"report_type": "epc", "from": frm, "to": datetime.date.today().isoformat(), "limit": 5000, "offset": off, "secret": SECRET}
        j = requests.get(SITE + "/wp-json/wtp/v1/opportunities", params=q, headers={"User-Agent": "wtp-radar-enrich/1.0"}, timeout=120).json()
        b = j.get("items") or []
        rows += b
        off += len(b)
        if not b or off >= int(j.get("total") or 0):
            break
    return rows


def month():
    return datetime.date.today().strftime("%Y-%m")


def brave_search(q):
    use = load(BRAVE_F, {})
    if use.get(month(), 0) >= BRAVE_CAP or not BRAVE:
        return None
    use[month()] = use.get(month(), 0) + 1
    save(BRAVE_F, use)
    try:
        r = requests.get("https://api.search.brave.com/res/v1/web/search", params={"q": q, "count": 10},
                         headers={"X-Subscription-Token": BRAVE, "Accept": "application/json"}, timeout=20)
        time.sleep(1.1)
        return [x["url"] for x in r.json().get("web", {}).get("results", [])] if r.status_code == 200 else []
    except Exception:
        return []


def clip(text, r):
    text = re.sub(r"\s+", " ", text)
    tk = [t.lower() for t in re.findall(r"[A-Za-z0-9]{4,}", r["project_name"] + " " + (r.get("company_name") or ""))
          if t.lower() not in ("project", "plant", "order", "tender", "contract", "power", "energy")]
    sents = [s for s in re.split(r"(?<=[.!?]) ", text[1100:]) if any(t in s.lower() for t in tk)]
    return (text[:1100] + " ... " + " ".join(sents))[:2400]


def read_pages(urls, r):
    pages = []
    for u in urls:
        if any(urlparse(u).netloc.lower().replace("www.", "").endswith(b) for b in BAD):
            continue
        if len(pages) >= 3:
            break
        try:
            body, _ = fetcher.fetch_article(u)      # robots-gated, honest user agent; empty when blocked
        except Exception:
            body = ""
        time.sleep(0.3)
        if len(body or "") >= 300:
            pages.append({"url": u, "full": body, "text": clip(body, r)})
    return pages


SYSTEM = ("You verify project-tracking records for a trade-intelligence site and extract facts. Answer with ONE JSON array only." + NL
          + "For each RECORD you get what we know (name, company, country, stage, first seen date) and up to 3 PAGES found by search." + NL
          + "Decide whether a page reports on the SAME project (not merely the same company or a different project of it). Registry/profile/home/"
          + "marketing pages that do not report a concrete news event do not count. If two pages are about it, use the best one." + NL
          + 'Return per record: {"record": n, "same_project": "yes|no", "page": 1-3 or 0, "page_date": "YYYY-MM-DD or empty", '
          + '"event_type": one of ' + " | ".join(fieldsv2.EVENT_TYPES) + ', "owner": "", "site": "", "capacity": "", "value_amount": "", '
          + '"value_unit": "thousand|million|billion|unstated", "value_currency": "", "contractors": [{"name": "", "role": ""}], "financiers": ["" ], '
          + '"key_dates": [{"label": "", "date": ""}], "description": "..."}' + NL
          + "RULES: use ONLY facts on the chosen page; empty string/[] when not stated; never guess. event_type describes what the PAGE reports "
          + "(an MoU is not an Award; a prequalification or request for bids is a Tender). value_amount = number only, the TOTAL deal value."
          + " description = 2 plain sentences, 110-260 characters, YOUR OWN WORDS (never 5+ consecutive words from the page), neutral, "
          + "saying what the project is, who is involved and what the page reports, with key numbers/dates. No hype, no publisher name." + NL
          + "If no page is about the same project: same_project \"no\" and leave the rest empty.")


def claude_json(prompt):
    raw = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    env = dict(os.environ)
    if raw:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = re.sub(r"\s+", "", raw)
    cwd = tempfile.mkdtemp(prefix="radar-llm-")
    out = subprocess.run(["claude", "-p", "Follow the instructions in the input and reply with the JSON array only.", "--system-prompt", SYSTEM,
                          "--model", MODEL, "--max-turns", "1", "--output-format", "json"],
                         input=prompt, cwd=cwd, env=env, capture_output=True, text=True, timeout=900)
    try:
        j = json.loads(out.stdout)
        text = j.get("result") or ""
    except Exception:
        raise RuntimeError("claude CLI failed: " + (out.stdout or out.stderr)[:300])
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        raise RuntimeError("no JSON in answer: " + text[:200])
    return json.loads(m.group(0))


def build_prompt(batch):
    parts = []
    for k, (r, pages) in enumerate(batch):
        parts.append("---RECORD %d---%sName: %s | Company: %s | Country: %s | Stage: %s | First seen: %s" % (
            k, NL, r["project_name"], r.get("company_name") or r.get("owner") or "-", r.get("country"), r.get("stage"), str(r.get("report_date") or "")[:10]))
        for i, p in enumerate(pages, 1):
            parts.append("PAGE %d (%s):%s%s" % (i, p["url"], NL, p["text"]))
    return NL.join(parts)


def norm(s):
    return " ".join(re.findall(r"[a-z0-9]+", (s or "").lower()))


def check(r, a, pages):
    """Program checks on one answer. Returns (status, reason, page)."""
    if (a.get("same_project") or "").lower() != "yes":
        return "limited", "not the same project", None
    try:
        page = pages[int(a.get("page")) - 1]
    except Exception:
        return "limited", "no page chosen", None
    body, d = page["full"], (a.get("description") or "").strip()
    low = body.lower()
    toks = [t.lower() for t in re.findall(r"[A-Za-z0-9]{4,}", r["project_name"] + " " + (r.get("company_name") or r.get("owner") or ""))
            if t.lower() not in ("project", "plant", "order", "tender", "contract", "power", "energy", "farm", "data", "center", "centre")]
    if toks and sum(t in low for t in toks) < min(2, len(toks)):
        return "limited", "page lacks the project/company names", None
    if not (100 <= len(d) <= 300):
        return "project_only", "description length", page
    if fieldsv2.longest_run(d, body) >= 6:
        return "project_only", "description copies the page", page
    bad = [n for n in re.findall(r"\d[\d.,]*", d) if n.strip(".,") not in body]
    for f in ("capacity", "value_amount"):
        v = str(a.get(f) or "")
        bad += [n for n in re.findall(r"\d[\d.,]*", v) if n.strip(".,") not in body]
    if bad:
        return "project_only", "numbers not on page %s" % bad[:2], page
    pd = (a.get("page_date") or "")[:10]
    first = str(r.get("report_date") or "")[:10]
    try:
        gap = abs((datetime.date.fromisoformat(pd) - datetime.date.fromisoformat(first)).days)
    except Exception:
        return "project_only", "page undated", page
    if gap > 60:
        return "project_only", "page date %d days from the news" % gap, page
    return "full", "", page


def main():
    if not SECRET:
        sys.exit("WTP_BOT_SECRET missing")
    tried = load(TRIED_F, {})
    cutoff = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    rows = [r for r in get_rows() if r.get("verification") in ("limited", None, "") and not (r.get("article_id") or "").startswith(("ted-", "fts-", "wb-", "iati-", "ifc-", "cn-"))
            and tried.get(str(r["id"]), {}).get("date", "0") < cutoff]
    sc = lambda r: ((r.get("scale") == "Large") * 2 + (r.get("scale") == "Medium") + (str(r.get("stage"))[:2] in ("S4", "S5")) * 2 + bool(r.get("company_name")), str(r.get("report_date")))
    rows.sort(key=sc, reverse=True)
    rows = rows[:MAX_ROWS]
    print("rows to try: %d (write=%s, model=%s)" % (len(rows), WRITE, MODEL), flush=True)
    work = []
    for r in rows:
        q = " ".join(x for x in (r["project_name"], r.get("company_name") or "", r.get("country") or "") if x)
        urls = brave_search(q)
        if urls is None:
            print("Brave budget used up for this month - stopping the search part", flush=True)
            break
        pages = read_pages(urls, r)
        tried[str(r["id"])] = {"date": datetime.date.today().isoformat(), "pages": len(pages)}
        if pages:
            work.append((r, pages))
    save(TRIED_F, tried)
    print("rows with readable candidate pages: %d" % len(work), flush=True)
    report, updates, st = [], [], collections.Counter()
    for i in range(0, len(work), 6):
        batch = work[i:i + 6]
        try:
            ans = {int(a.get("record")): a for a in claude_json(build_prompt(batch))}
        except Exception as e:
            print("model batch failed:", str(e)[:200], flush=True)
            continue
        for k, (r, pages) in enumerate(batch):
            a = ans.get(k) or {}
            status, why, page = check(r, a, pages)
            st[status] += 1
            report.append("- %s | %s | %s%s" % (r["project_name"], status, why or "ok", (" | " + page["url"]) if page else ""))
            if status not in ("full", "project_only"):
                continue
            c = {"verification": status, "paid_eligible": 1 if status == "full" else 0, "description_source": "model"}
            for k2 in ("owner", "site", "capacity", "reference_id"):
                if a.get(k2):
                    c[k2] = a[k2]
            for k2 in ("contractors", "financiers", "key_dates"):
                if a.get(k2):
                    c[k2] = json.dumps(a[k2], ensure_ascii=False)
            if status == "full":
                et = a.get("event_type") if a.get("event_type") in fieldsv2.EVENT_TYPES else "Other"
                c["event_type"] = et
                for k2 in ("value_amount", "value_unit", "value_currency"):
                    if a.get(k2):
                        c[k2] = a[k2]
                c["reference_url" if page["url"] != r.get("source_url") else "x"] = page["url"]
            else:
                c["project_ref_url"] = page["url"]
            if "description copies" not in why and "description length" not in why and a.get("description"):
                c["description"] = a["description"].strip()
                c["expect_description"] = r.get("description") or ""
            c.pop("x", None)
            updates.append(dict(c, id=int(r["id"])))
    print("results:", dict(st), flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        open(summary, "a", encoding="utf-8").write("## Radar enrichment (write=%s)\n%s\n\n%s\n" % (WRITE, dict(st), NL.join(report)))
    print(NL.join(report))
    if updates and WRITE:
        for i in range(0, len(updates), 100):
            body = {"dry": False, "updates": updates[i:i + 100]}
            r = requests.patch(SITE + "/wp-json/wtp/v1/opportunities-v3", params={"secret": SECRET}, json=body, headers={"User-Agent": "wtp-radar-enrich/1.0"}, timeout=120)
            print("PATCH", r.status_code, r.text[:200], flush=True)
    elif updates:
        print("dry run - %d updates NOT sent" % len(updates))


if __name__ == "__main__":
    main()
