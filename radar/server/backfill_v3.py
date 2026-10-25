# -*- coding: utf-8 -*-
"""
Backfill v3 - one pass over ALL opportunity records (unique source_url).

For each record pick a page to read:
  * normal source URL  -> the URL itself
  * Google News link   -> candidate pages from data/gn_search/result_*.json (search step)
Then (robots-gated, honest UA) read the page and run TWO model calls per batch:
  A. extraction  - sees ONLY the page text: project facts (owner, site, capacity, contractors,
                   financiers, reference_id), event facts (event_type, key_dates, deal value + unit)
                   and a fresh own-words description
  B. match       - compares the record's old summary with what the page reports:
                   same_event = yes | project_only | no
Event facts and the description are kept ONLY if same_event = yes; project_only keeps just the
project facts with a neutral description; no -> limited. Page text is thrown away afterwards.

Output: data/backfill_v3.json  {source_url: {...}}   (resumable)   fields_v3: full | project_only | limited
Usage:
  python backfill_v3.py --no-gn    # only records with a normal source URL
  python backfill_v3.py            # + Google News records that already have a search result
  python backfill_v3.py --final    # also mark never-searched Google News links as limited
"""
import os, sys, json, glob, time, re, logging, threading
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
os.environ.setdefault("BODY_CHARS", "4000")
if os.path.exists(".env"):
    for line in open(".env", encoding="utf-8"):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1)
            os.environ.setdefault(k, v.strip().strip('"').strip("'"))

import fetcher
import openrouter_analyzer as oa
import fieldsv2

log = logging.getLogger("backfill_v3")
OUT = "data/backfill_v3.json"
BATCH, LLM_WORKERS = 5, 4
FETCH_WORKERS = int(os.getenv("BF3_FETCH_WORKERS", "8"))
NL = chr(10)
GENERIC = {"project", "projects", "plant", "tender", "tenders", "contract", "farm", "terminal",
           "facility", "development", "expansion", "energy", "power", "the", "and", "for", "new"}
lock = threading.Lock()
BROWSER_FINAL = set()
try:
    BROWSER_FINAL = {v["final"] for v in json.load(open("data/gn_resolved_browser.json", encoding="utf-8")).values()
                     if v.get("status") == "ok" and v.get("final")}
except Exception:
    pass


def load_records():
    recs, seen = [], set()
    for f in sorted(glob.glob("data/opportunities_*.json")):
        d = json.load(open(f, encoding="utf-8"))
        for o in (d if isinstance(d, list) else d.get("opportunities", [])):
            u = o.get("source_url")
            if u and u not in seen:
                seen.add(u)
                recs.append(o)
    return recs


def _desc_tokens(o):
    """Distinctive words of the old one-line description: capitalised names and numbers (not years)."""
    d = o.get("description") or ""
    names = {t.lower() for t in re.findall(r"\b[A-Z][A-Za-z0-9&\-]{3,}\b", d)} - GENERIC
    nums = {n for n in re.findall(r"\b\d{2,}(?:[.,]\d+)?", d) if not re.fullmatch(r"(19|20)\d\d", n)}
    return names | nums


def text_matches(o, body, extra=""):
    """Guard against re-fetching a different article: the record's own names must appear in the text
    (page text + public headline/meta + url words)."""
    low = (body + " " + extra).lower()
    toks = set()
    for k in ("project_name", "company_name"):
        toks |= {t for t in re.findall(r"[a-z0-9][a-z0-9&\-]{3,}", (o.get(k) or "").lower()) if t not in GENERIC}
    if (not toks) or sum(t in low for t in toks) >= max(1, min(2, len(toks))):
        return True
    dt = _desc_tokens(o)
    return len(dt) >= 2 and sum(t in low for t in dt) >= 2      # fall back to names from the old description


def save(done):
    tmp = OUT + ".tmp"
    json.dump(done, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)


def fetch_stage(item):
    u, o, pages = item
    reason = "no_candidate"
    for page in pages:
        try:
            body, _ = fetcher.fetch_article(page)
            head = fetcher.last_head()
        except Exception:
            body, head = "", ""
        time.sleep(0.4)
        text = (("Headline/summary: " + head + NL) if head else "") + body
        if len(text) < 200:
            reason = "no_text"
            continue
        slug = re.sub(r"[-_/.]+", " ", page)
        if not text_matches(o, body, head + " " + slug):
            reason = "text_mismatch"
            continue
        return u, o, text, page
    return u, o, None, reason


def prompt_for(batch):
    """Extraction call: the model sees ONLY the page (plus project name/country for orientation)."""
    parts = []
    for i, (u, o, b, page) in enumerate(batch):
        parts.append("---RECORD %d---" % i + NL + "Project: %s" % o.get("project_name") + NL
                     + "Company: %s" % (o.get("company_name") or "-") + NL
                     + "Country: %s" % o.get("country") + NL + "Page text:" + NL + b + NL)
    fields = NL.join('  "%s": %s' % (k, v) for k, v in fieldsv2.V2_FIELDS.items())
    return ("You extract structured facts from article text about capital projects and procurement." + NL
            + "Return ONLY a JSON array, one object per record, each with:" + NL
            + '  "record": the record index' + NL + fields + NL
            + '  "description": string - one plain sentence, max 120 chars' + NL + NL
            + "RULES" + NL
            + "- Use ONLY what the page states about the project named in the record. If a field is not stated use empty string or []." + NL
            + "- Never guess. Event fields describe what THIS PAGE reports." + NL
            + "- " + fieldsv2.DESCRIPTION_RULE + NL + NL + NL.join(parts))


def match_prompt(items):
    """Match call: compare the record's old summary with what the page reports (no page text needed)."""
    parts = []
    for i, (o, g) in enumerate(items):
        parts.append("---%d---" % i + NL + "Project: %s" % o.get("project_name") + NL
                     + "RECORD SUMMARY: %s" % o.get("description") + NL
                     + "PAGE REPORTS: %s (event type: %s)" % (g.get("description"), g.get("event_type")))
    return ("For each item decide whether the PAGE reports the same news item as the RECORD SUMMARY." + NL
            + ' "yes"          = same project AND same kind of event (e.g. both an award, both a delivery, same deal). Differences in wording, rounding (1.5bn vs 1.47bn) or unit counts (five vs six ships) still count as yes' + NL
            + ' "project_only" = same project but the page CLEARLY reports a different event, stage or date (e.g. record says delivery, page says award; a 2021 page for a 2026 event)' + NL
            + ' Be tolerant: if the page news is consistent with the record summary (it may add detail, use another headline, or give a slightly different figure) answer "yes". Example: summary "BP JV boosts stakes in Belgian offshore wind farms" vs page "JERA Nex bp takes full ownership of Northwester 2, raises stake" = yes.' + NL
            + ' "no"           = a different project' + NL
            + 'Return ONLY a JSON array: [{"record": 0, "same_event": "yes|project_only|no"}, ...]' + NL + NL
            + NL.join(parts))


def _call(prompt):
    got = {}
    raw = oa.call_openrouter(prompt)
    for r in oa.parse_response(raw):
        try:
            got[int(r.get("record"))] = r
        except Exception:
            pass
    return got


def llm_stage(batch, done):
    got, verdict = {}, {}
    try:
        got = _call(prompt_for(batch))
        idx = [i for i in sorted(got) if i < len(batch)]
        items = [(batch[i][1], got[i]) for i in idx]
        if items:
            vv = _call(match_prompt(items))
            verdict = {idx[k]: (v.get("same_event") or "").strip().lower() for k, v in vv.items() if k < len(idx)}
    except Exception as e:
        log.warning("LLM batch failed: %s" % str(e)[:80])
    for i, (u, o, b, page) in enumerate(batch):
        g = got.get(i)
        se = verdict.get(i)
        if not g or se not in ("yes", "project_only", "no"):
            res = {"fields_v3": "limited", "reason": "llm_failed"}
        elif se == "no":
            res = {"fields_v3": "limited", "reason": "different_project", "found_via": page}
        else:
            if se == "project_only" and (page == u or page in BROWSER_FINAL):
                se = "yes"      # the page IS the record's own source article (own URL, or resolved by the browser)
            res = {k: g.get(k, [] if k in fieldsv2.LIST_FIELDS else "") for k in fieldsv2.PROJECT_FIELDS}
            res["found_via"] = page
            res["page_summary"] = (g.get("description") or "").strip()
            res["page_event_type"] = g.get("event_type") or ""
            merged = dict(o, **res)
            if se == "yes":
                for k in fieldsv2.EVENT_FIELDS:
                    res[k] = g.get(k, [] if k in fieldsv2.LIST_FIELDS else "")
                if res["event_type"] not in fieldsv2.EVENT_TYPES:
                    res["event_type"] = "Other"
                merged = dict(o, **res)
                desc = (g.get("description") or "").strip()
                cur = (res.get("value_currency") or "").upper()
                if cur and ("$" in desc and cur not in ("USD",) or "€" in desc and cur != "EUR"):
                    desc = ""     # description and value currency disagree -> use the template
                if (not desc or fieldsv2.longest_run(desc, b) >= 6
                        or fieldsv2.longest_run(desc, o.get("description", "")) >= 5):
                    desc, src = fieldsv2.template_description(merged, event_ok=True), "template"
                else:
                    src = "model"
                res.update(fields_v3="full", event_match="yes", description_v3=desc, description_source=src)
            else:   # project_only: keep project facts, no event claims, neutral description
                res.update(fields_v3="project_only", event_match="project_only",
                           description_v3=fieldsv2.template_description(merged, event_ok=False),
                           description_source="template")
        with lock:
            done[u] = res
    with lock:
        save(done)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    final = "--final" in sys.argv
    cand = {}
    for f in sorted(glob.glob("data/gn_search/result_*.json")):
        for k, v in json.load(open(f, encoding="utf-8")).items():
            # an empty search result must never overwrite a result that found pages
            if k not in cand or v.get("urls") or not cand[k].get("urls"):
                cand[k] = v
    done = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}

    todo = []
    for o in load_records():
        u = o["source_url"]
        if u in done:
            continue
        if "news.google" in u:
            if "--no-gn" in sys.argv:
                continue
            if u not in cand:
                if final:
                    done[u] = {"fields_v3": "limited", "reason": "not_searched"}
                continue
            pages = cand[u].get("urls", [])
        else:
            pages = [u]
        todo.append((u, o, pages))
    log.info("%d records to process, %d already done" % (len(todo), len(done)))

    with ThreadPoolExecutor(FETCH_WORKERS) as ex:
        fetched = list(ex.map(fetch_stage, todo))
    ready = []
    for u, o, body, used in fetched:
        if body is None:
            done[u] = {"fields_v3": "limited", "reason": used}
        else:
            ready.append((u, o, body, used))
    save(done)
    log.info("fetched: %d readable, %d limited" % (len(ready), len(fetched) - len(ready)))

    batches = [ready[i:i + BATCH] for i in range(0, len(ready), BATCH)]
    with ThreadPoolExecutor(LLM_WORKERS) as ex:
        list(ex.map(lambda b: llm_stage(b, done), batches))
    save(done)
    print(Counter(v["fields_v3"] + ":" + v.get("reason", v.get("event_match", "")) for v in done.values()))


if __name__ == "__main__":
    main()
