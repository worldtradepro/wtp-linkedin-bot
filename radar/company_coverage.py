# -*- coding: utf-8 -*-
"""
Company coverage check (owner 2026-11-16: "Wison is missing - then others are missing too").

The news radar only sees what its feeds carry, so contractors that announce work in stock-exchange filings, on their own site,
in local or Chinese / Korean / Japanese media are thin in our data (Petrofac 0 reports, GS E&C 0, Wison 3). Once a week this
job takes the companies on radar/company_watch.json that were checked longest ago (about 25, so each is checked about once a
month) and, for each one:
  1. lists the projects we already hold that name the company (so the model only looks for missing ones)
  2. Claude Code CLI with WebSearch / WebFetch (owner's subscription) looks for the company's projects and contracts of the last
     12 months in several kinds of sources: exchange filings, the company's and the owner's press releases, tender award notices,
     trade press. Owner: not every company site lists projects and not every site lets robots in - a page that does not load or
     blocks robots is skipped, never worked around; another source is used instead.
  3. program checks: dated, a real source URL, not already in our data (same source or near-same name in the same country);
     the source page is read with the radar's robots-gated fetcher - the company must be named on it (else the item is dropped);
     a page the fetcher may not read keeps the item but as verification "project_only" (shown on the site, not in paid alerts)
  4. new items are appended to the project table (POST /opportunities, append, article_id "co-<sha1>") and their facts set
     through PATCH /opportunities-v3; the daily dedupe + project builder then place them into projects.

Public repo: only company names and counts are committed (state/company_coverage.json + state/company_coverage_report.md).

Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN, optional COV_WRITE (true = write to the site), COV_PER_RUN (25),
     COV_ONLY ("Wison New Energies,Petrofac" - just these), COV_MODEL (claude-sonnet-5-5)
"""
import os, re, sys, json, hashlib, datetime, difflib, subprocess, tempfile, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import radar_enrich as rx            # site calls through Node (Cloudflare-safe), robots-gated fetcher

WRITE = os.environ.get("COV_WRITE", "false").lower() == "true"
PER_RUN = int(os.environ.get("COV_PER_RUN", "25"))
ONLY = [x.strip().lower() for x in os.environ.get("COV_ONLY", "").split(",") if x.strip()]
MODEL = os.environ.get("COV_MODEL", "claude-sonnet-5-5")
STATE_F = os.path.join(rx.STATE, "company_coverage.json")
REPORT_F = os.path.join(rx.STATE, "company_coverage_report.md")
TODAY = datetime.date.today()
NL = chr(10)

SECTORS = ["Energy", "Logistics & Infrastructure", "Mining & Metals", "Agriculture"]
SUBSECTORS = ["Oil & Gas", "LNG", "Gas", "Refining & Petrochemicals", "Pipelines & Storage", "Power & Transmission", "Grid Infrastructure",
              "Solar", "Wind", "Hydropower", "Geothermal", "Battery Storage", "Hydrogen & Ammonia", "Data Centers", "Shipyard & Fleet",
              "Ports & Terminals", "Rail & Inland Transport", "Water & Desalination", "Mine Development", "Processing & Smelting",
              "Critical Minerals", "Fertilizer Plants", "Grain & Food Infrastructure", "Industrial Development"]
STAGES = {"S1-Feasibility": "study, feasibility, MoU", "S2-Development": "development, permits, FEED", "S3-Pre-FID": "FEED done, FID pending",
          "S4-Tender": "EPC or package tender open", "S5-Awarded": "contract awarded, under construction or vessel/equipment order"}
REGIONS = ["Europe", "Asia Pacific", "Americas", "Africa", "Middle East", "Global"]
GENERIC = set("project projects plant unit phase new the and of for in at to a an with by contract contracts award awarded epc package "
              "expansion development construction facility facilities station farm park order orders supply agreement".split())

PROMPT = """You help a project-intelligence service for equipment suppliers. Our news radar missed some work of this company:

Company: {name}  (also known as: {also})
Type: {type}
Where a listed company discloses large contracts: {filings}

Projects we ALREADY have that name this company (do not report these again, even under another name):
{have}

Find this company's capital projects and contracts from the last 12 months ({since} to {today}) that are NOT in that list:
contract awards, EPC / FEED / module / vessel / equipment orders, tenders it bid for or won, FIDs it is part of, new plants it builds.
Look in several kinds of sources, not only one:
- stock-exchange filings and announcements (the exchange named above; Korean DART, Japanese TDnet, HKEX, SSE / SZSE, NSE, Oslo, Euronext ...)
- the company's own news page and the project owner's press releases
- tender award notices (government portals, the World Bank, the EU TED)
- trade press (Upstream, Offshore Engineer, Splash247, MEED, Zawya, Argus, Reuters, local and Chinese, Korean or Japanese media)
Rules:
- Many company sites do not list projects, and some block robots. If a page does not load or blocks access, skip it and use another
  source. Never try to get around a block.
- Report only what a dated public source says. Do not guess, do not fill gaps from memory. No source, no item.
- Search in English AND in the company's home language (Chinese for Chinese firms, Korean for Korean, Japanese for Japanese ...),
  and open the company's own news page if robots may read it.
- Only energy, mining, industrial, transport, water and digital infrastructure projects (the subsector list below). NOT in scope:
  housing, apartments, offices, malls, hotels, hospitals, schools, stadiums, urban redevelopment, domestic building works.
- One item per project (the latest news about it). Skip routine maintenance, small service jobs, share buybacks, results reports.
- At most 15 items, the largest first. If you find nothing new, return an empty list.

Reply with JSON only:
{{"items": [{{
  "project_name": "owner + asset + what is built, e.g. 'Eni Coral Norte FLNG hull and topsides'",
  "country": "", "city_or_site": "", "region": "one of {regions}",
  "owner": "the project owner / buyer", "company_role": "what {name} does in it, e.g. EPC contractor, shipyard, gas turbine supplier",
  "other_contractors": [{{"name": "", "role": ""}}],
  "sector": "one of {sectors}", "subsector": "one of {subsectors}",
  "stage": "one of {stages}",
  "event_type": "one of {events}",
  "capacity": "e.g. 2.5 mtpa, 450 MW, 2 x VLCC", "value_amount": "number or empty", "value_unit": "million | billion | empty", "value_currency": "USD | EUR | ... | empty",
  "news_date": "YYYY-MM-DD (date of the source)", "source_url": "the page you read", "source_name": "publisher",
  "source_kind": "filing | company | owner | tender | press",
  "description": "one sentence in your own words (not copied), at most 230 characters"
}}],
 "note": "one line: which kinds of sources worked or did not for this company"}}
"""


def load(p, d):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return d


def save(p, o):
    json.dump(o, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)


def ask(prompt):
    env = dict(os.environ)
    if env.get("CLAUDE_CODE_OAUTH_TOKEN"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = re.sub(r"\s+", "", env["CLAUDE_CODE_OAUTH_TOKEN"])
    out = subprocess.run(["claude", "-p", "Follow the instructions in the input; use web search; reply with the JSON only.", "--model", MODEL,
                          "--allowedTools", "WebSearch", "WebFetch", "--max-turns", "45", "--output-format", "json"],
                         input=prompt, cwd=tempfile.mkdtemp(prefix="cov-"), env=env, capture_output=True, text=True, timeout=1500)
    try:
        txt = json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get("result") or ""
        return json.loads(re.search(r"\{.*\}", txt, re.S).group(0))
    except Exception:
        raise RuntimeError("model answer unusable: " + (out.stdout or out.stderr)[-300:].replace(NL, " "))


def norm_words(s):
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in GENERIC and len(w) > 1}


def same_project(a, b):
    """near-same project name (and country when both have one)"""
    if a.get("country") and b.get("country") and a["country"].lower() != b["country"].lower():
        return False
    wa, wb = norm_words(a.get("project_name")), norm_words(b.get("project_name"))
    if not wa or not wb:
        return False
    jac = len(wa & wb) / len(wa | wb)
    seq = difflib.SequenceMatcher(None, " ".join(sorted(wa)), " ".join(sorted(wb))).ratio()
    return jac >= 0.6 or seq >= 0.85


def names_of(c):
    out = [c["name"]] + list(c.get("also") or [])
    out += [re.sub(r"\s*\([^)]*\)", "", n).strip() for n in out]           # "Offshore Oil Engineering (COOEC)" -> also without the bracket
    out += [m for n in out for m in re.findall(r"\(([^)]+)\)", n)]           # and the bracket itself
    return sorted({n for n in out if len(n) >= 2}, key=len, reverse=True)


def mentions(text, names):
    t = (text or "").lower()
    for n in names:
        n2 = n.lower()
        if len(n2) <= 4:                                                    # short names (SHI, MCC, TR): whole word only
            if re.search(r"(?<![a-z0-9])" + re.escape(n2) + r"(?![a-z0-9])", t):
                return True
        elif n2 in t:
            return True
    return False


def page_check(url, names):
    """'full' = the robots-gated fetcher read the page and it names the company; 'blocked' = we may not / cannot read it; 'absent' = read, company not named"""
    try:
        body, _ = rx.fetcher.fetch_article(url)
    except Exception:
        body = ""
    if not body:
        return "blocked"
    return "full" if mentions(body, names) else "absent"


def clean(it, c):
    """program checks on one model item; returns (row, facts) or (None, reason)"""
    url = (it.get("source_url") or "").strip()
    if not re.match(r"^https?://[^/]+\.[a-z]{2,}", url, re.I):
        return None, "no source URL"
    try:
        d = datetime.date.fromisoformat((it.get("news_date") or "")[:10])
    except Exception:
        return None, "no date"
    if d > TODAY or d < TODAY - datetime.timedelta(days=400):
        return None, "date out of range"
    name = (it.get("project_name") or "").strip()
    if len(name) < 8:
        return None, "no project name"
    stage = it.get("stage") if it.get("stage") in STAGES else "S5-Awarded"
    sector = it.get("sector") if it.get("sector") in SECTORS else "Energy"
    sub = it.get("subsector")
    if sub not in SUBSECTORS:
        return None, "out of scope (" + str(sub)[:30] + ")"
    region = it.get("region") if it.get("region") in REGIONS else "Unknown"
    owner = (it.get("owner") or "").strip()
    role = (it.get("company_role") or "contractor").strip()
    contractors = [{"name": c["name"], "role": role}] + [x for x in (it.get("other_contractors") or []) if isinstance(x, dict) and (x.get("name") or "").strip()]
    desc = re.sub(r"\s+", " ", it.get("description") or "").strip()[:250]
    aid = "co-" + hashlib.sha1((url + "|" + name).lower().encode("utf-8")).hexdigest()[:12]
    row = {"article_id": aid, "project_name": name[:250], "country": (it.get("country") or "").strip(), "region": region,
           "city": (it.get("city_or_site") or "").strip()[:120], "location_source": "project" if it.get("city_or_site") else "unknown",
           "company_name": owner or c["name"], "sector": sector, "subsector": sub, "stage": stage, "scale": "Unknown",
           "description": desc, "source_url": url, "source_name": (it.get("source_name") or "").strip()[:120],
           "credibility": 4, "confidence": "Medium", "report_date": d.isoformat()}
    facts = {"owner": owner, "site": row["city"], "capacity": (it.get("capacity") or "").strip(),
             "contractors": json.dumps(contractors, ensure_ascii=False), "description_source": "model",
             "event_type": it.get("event_type") if it.get("event_type") in rx.fieldsv2.EVENT_TYPES else "Other"}
    if str(it.get("value_amount") or "").replace(".", "", 1).isdigit():
        facts.update(value_amount=str(it["value_amount"]), value_unit=it.get("value_unit") or "", value_currency=it.get("value_currency") or "")
    return (row, facts), it.get("source_kind") or "press"


def main():
    watch = load(os.path.join(HERE, "company_watch.json"), {}).get("companies") or []
    state = load(STATE_F, {})
    if ONLY:
        todo = [c for c in watch if c["name"].lower() in ONLY]
    else:
        todo = sorted(watch, key=lambda c: (state.get(c["name"], {}).get("checked") or "0000"))[:PER_RUN]
    print("companies this run: %d (write=%s, model %s)" % (len(todo), WRITE, MODEL), flush=True)

    since = (TODAY - datetime.timedelta(days=365)).isoformat()
    have_rows = rx.site_call("GET", "/wp-json/wtp/v1/opportunities", params={"secret": rx.SECRET, "from": (TODAY - datetime.timedelta(days=730)).isoformat(), "limit": 30000}).json().get("items") or []
    print("rows in our data: %d" % len(have_rows), flush=True)
    have_urls = {(r.get("source_url") or "").rstrip("/").lower() for r in have_rows}

    report, new_rows, facts_by_aid = [], [], {}
    for c in todo:
        names = names_of(c)
        mine = [r for r in have_rows if mentions(" ".join(str(r.get(k) or "") for k in ("project_name", "company_name", "owner", "contractors", "description")), names)]
        have = NL.join("- %s (%s, %s)" % (r["project_name"], r.get("country") or "?", r.get("report_date")) for r in mine[:80]) or "(none)"
        st = {"checked": TODAY.isoformat(), "had": len(mine), "found": 0, "added": 0, "dropped": 0, "kinds": {}, "note": ""}
        try:
            a = ask(PROMPT.format(name=c["name"], also=", ".join(c.get("also") or []) or "-", type=c.get("type") or "-", filings=c.get("filings") or "not listed or unknown",
                                  have=have, since=since, today=TODAY.isoformat(), regions=" | ".join(REGIONS), sectors=" | ".join(SECTORS),
                                  subsectors=" | ".join(SUBSECTORS), stages=" | ".join("%s (%s)" % kv for kv in STAGES.items()),
                                  events=" | ".join(rx.fieldsv2.EVENT_TYPES)))
        except Exception as e:
            st["note"] = "failed: " + str(e)[:160]
            state[c["name"]] = dict(state.get(c["name"], {}), note=st["note"])   # 'checked' not moved: tried again next run
            report.append("| %s | %d | - | - | - | %s |" % (c["name"], len(mine), st["note"]))
            print(c["name"], "->", st["note"], flush=True)
            continue
        items = a.get("items") or []
        st["found"] = len(items)
        st["note"] = (a.get("note") or "")[:200]
        kinds = collections.Counter()
        for it in items:
            got, kind = clean(it, c)
            if not got:
                st["dropped"] += 1
                print("   drop (%s): %s" % (kind, (it.get("project_name") or "")[:90]), flush=True)
                continue
            row, facts = got
            if row["source_url"].rstrip("/").lower() in have_urls or any(same_project(row, r) for r in mine) or any(same_project(row, r) for r in new_rows):
                st["dropped"] += 1
                print("   drop (already have): %s" % row["project_name"][:90], flush=True)
                continue
            chk = page_check(row["source_url"], names)
            if chk == "absent":
                st["dropped"] += 1                                          # the page does not name the company: not trusted
                print("   drop (page does not name the company): %s | %s" % (row["project_name"][:80], row["source_url"][:80]), flush=True)
                continue
            facts.update(verification="full" if chk == "full" else "project_only", paid_eligible=1 if chk == "full" else 0)
            if chk != "full":
                facts["project_ref_url"] = row["source_url"]
            new_rows.append(row); facts_by_aid[row["article_id"]] = facts
            print("   NEW [%s, %s, %s] %s | %s | %s" % (row["report_date"], row["stage"], facts["verification"], row["project_name"][:90], row["country"], row["source_url"][:90]), flush=True)
            kinds[kind] += 1
            st["added"] += 1
        st["kinds"] = dict(kinds)
        state[c["name"]] = st
        report.append("| %s | %d | %d | %d | %s | %s |" % (c["name"], len(mine), st["found"], st["added"], ", ".join("%s %d" % kv for kv in kinds.items()) or "-", st["note"].replace("|", "/")))
        print("%s: had %d, found %d, new %d" % (c["name"], len(mine), st["found"], st["added"]), flush=True)

    written = 0
    if new_rows and WRITE:
        by_day = collections.defaultdict(list)
        for r in new_rows:
            by_day[r.pop("report_date")].append(r)
        for day, rows in sorted(by_day.items()):
            res = rx.site_call("POST", "/wp-json/wtp/v1/opportunities", params={"secret": rx.SECRET}, json={"report_type": "epc", "report_date": day, "append": True, "items": rows})
            written += int((res.json() or {}).get("inserted") or 0)
            live = rx.site_call("GET", "/wp-json/wtp/v1/opportunities", params={"secret": rx.SECRET, "from": day, "to": day, "limit": 5000, "include_dups": 1}).json().get("items") or []
            ids = {x.get("article_id"): int(x["id"]) for x in live if (x.get("article_id") or "").startswith("co-")}
            ups = [dict({k: v for k, v in facts_by_aid[r["article_id"]].items() if v not in ("", None)}, id=ids[r["article_id"]]) for r in rows if r["article_id"] in ids]
            if ups:
                p = rx.site_call("PATCH", "/wp-json/wtp/v1/opportunities-v3", params={"secret": rx.SECRET}, json={"dry": False, "updates": ups})
                print(day, "facts:", p.status_code, p.text[:120], flush=True)
    elif new_rows:
        print("dry run - %d new rows NOT written" % len(new_rows))

    save(STATE_F, state)
    stamp = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    head = ["# company coverage %s (write=%s, model %s)" % (stamp, WRITE, MODEL), "",
            "%d companies checked, %d new projects found%s." % (len(todo), len(new_rows), (", %d written" % written) if WRITE else " (dry run, nothing written)"), "",
            "| Company | We had | Found | New | Source kinds | Note |", "|---|---|---|---|---|---|"]
    blind = sorted([n for n, s in state.items() if s.get("checked") and not s.get("had") and not s.get("added")])
    tail = ["", "Blind spots (checked, still nothing in our data): " + (", ".join(blind) or "none")]
    open(REPORT_F, "w", encoding="utf-8").write(NL.join(head + report + tail) + NL)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        open(summary, "a", encoding="utf-8").write(NL.join(head + report + tail) + NL)


if __name__ == "__main__":
    main()
