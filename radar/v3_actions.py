# -*- coding: utf-8 -*-
"""
Daily v3 fact extraction on GitHub Actions (owner 2026-10-24: Haiku 5.5 on the owner's Claude subscription instead of OpenRouter).

Phase 1 = SHADOW (default, V3_MODE=shadow): the server pipeline still verifies the day's media rows with gpt-4o-mini. This job reads the
same rows' own source pages, lets Haiku extract the same facts (one call per small batch, radar_enrich prompt + program checks) and
WRITES NOTHING to the site - it only saves a comparison (server vs Haiku) to state/v3_shadow_report.md + state/v3_shadow.json.
After a few days the owner decides; then V3_MODE=write takes over the rows the server leaves unverified (verification empty) and the
server's step_v3 model call is switched off.

Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN, optional V3_MODE (shadow|write), V3_MODEL (claude-haiku-5-5), V3_DAYS (2), V3_MAX (60).
"""
import os, re, sys, json, datetime, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import radar_enrich as rx            # shared helpers: site calls, robots-gated page reading, claude CLI call, program checks
import fieldsv2

MODE = os.environ.get("V3_MODE", "shadow").strip().lower()
rx.MODEL = os.environ.get("V3_MODEL", "claude-haiku-5-5")
rx.DAYS = int(os.environ.get("V3_DAYS", "2"))
rx.BACKLOG = False
MAX_ROWS = int(os.environ.get("V3_MAX", "60"))
OFFICIAL = ("ted-", "fts-", "wb-", "iati-", "ifc-", "cn-")
DONE_F = os.path.join(rx.STATE, "v3_shadow_done.json" if MODE == "shadow" else "v3_write_done.json")
RAW_F = os.path.join(rx.STATE, "v3_shadow.json")
REPORT_F = os.path.join(rx.STATE, "v3_shadow_report.md" if MODE == "shadow" else "v3_write_report.md")
NL = chr(10)
JUNK = re.compile(r"unnamed|undisclosed|not disclosed|unknown|^\s*$|public[- ]private partnership|^(a|an|the) (major|leading|local)\b", re.I)


def as_list(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except Exception:
            v = [v] if v else []
    return [(x.get("name") if isinstance(x, dict) else str(x)).strip() for x in (v or []) if x]


def value_of(o):
    if not str(o.get("value_amount") or "").strip():
        return ""
    return " ".join(str(o.get(k) or "") for k in ("value_currency", "value_amount", "value_unit") if str(o.get(k) or "").lower() != "unstated").strip()


FILLER = "neutral placeholder sentence used only so the remaining program checks can run on the extracted facts without the model wording " * 2


def verify(r, a, pages):
    """radar_enrich.check, with two changes for the row's OWN source page (2026-10-24 local test: Haiku's facts were right but its
    description often reused 6+ words of the page, and the own article was sometimes undated):
    - a copied / wrong-length description does not downgrade the row: the facts are checked on their own and the description
      becomes the deterministic fact template (fieldsv2.template_description);
    - an undated page is accepted when it IS the row's own source article (same rule as the server's backfill)."""
    status, why, page = rx.check(r, a, pages)
    if why.startswith("description"):
        status, why, page = rx.check(r, dict(a, description=FILLER[:200]), pages)
        if status in ("full", "project_only"):
            a["description"] = fieldsv2.template_description(dict(r, **a), event_ok=(status == "full"))
            a["_desc_src"] = "template"
    if why == "page undated" and page and page["url"] == r.get("source_url"):
        status, why = "full", ""
        if a.get("_desc_src") == "template":
            a["description"] = fieldsv2.template_description(dict(r, **a), event_ok=True)
    return status, why, page


IDS = {x.strip() for x in os.environ.get("V3_IDS", "").split(",") if x.strip()}   # one-off run on given row ids (any verification)


def pick_rows():
    done = rx.load(DONE_F, {})
    rows = []
    if IDS:
        rx.DAYS = 30
        return [r for r in rx.get_rows() if str(r["id"]) in IDS], done
    for r in rx.get_rows():
        aid, u = r.get("article_id") or "", r.get("source_url") or ""
        if aid.startswith(OFFICIAL) or not u or "news.google" in u or str(r["id"]) in done:
            continue
        ver = r.get("verification") or ""
        if MODE == "shadow" and not ver:
            continue          # shadow compares with what the server decided
        if MODE == "write" and ver:
            continue          # write mode only takes rows the server left for us
        rows.append(r)
    rows.sort(key=lambda r: str(r.get("report_date")), reverse=True)
    return rows[:MAX_ROWS], done


def build_update(r, a, status, why, page):
    """Same update shape as radar_enrich.main (PATCH /opportunities-v3)."""
    c = {"verification": status, "paid_eligible": 1 if status == "full" else 0, "description_source": "model"}
    for k in ("owner", "site", "capacity", "reference_id"):
        if a.get(k):
            c[k] = a[k]
    for k in ("contractors", "financiers", "key_dates"):
        if a.get(k):
            c[k] = json.dumps(a[k], ensure_ascii=False)
    if status == "full":
        c["event_type"] = a.get("event_type") if a.get("event_type") in fieldsv2.EVENT_TYPES else "Other"
        for k in ("value_amount", "value_unit", "value_currency"):
            if a.get(k):
                c[k] = a[k]
    if a.get("description"):
        c["description"] = a["description"].strip()
        c["description_source"] = a.get("_desc_src") or "model"
        c["expect_description"] = r.get("description") or ""
    return dict(c, id=int(r["id"]))


def main():
    if not rx.SECRET:
        sys.exit("WTP_BOT_SECRET missing")
    rows, done = pick_rows()
    print("v3 %s: %d rows (model=%s)" % (MODE, len(rows), rx.MODEL), flush=True)
    work, st, lines, raw, updates = [], collections.Counter(), [], rx.load(RAW_F, []), []
    today = datetime.date.today().isoformat()
    for r in rows:
        pages = rx.read_pages([r["source_url"]], r)
        if pages:
            work.append((r, pages))
        else:
            st["page unreadable"] += 1
            done[str(r["id"])] = today
    for i in range(0, len(work), 6):
        batch = work[i:i + 6]
        try:
            ans = {int(a.get("record")): a for a in rx.claude_json(rx.build_prompt(batch))}
        except Exception as e:
            print("model batch failed:", str(e)[:200], flush=True)
            st["model failed"] += len(batch)
            continue
        for k, (r, pages) in enumerate(batch):
            a = ans.get(k) or {}
            # 2026-10-24 first Actions run: placeholders came back as names ("Major Chinese automobile manufacturer (unnamed)",
            # "Public-private partnership") - a contractor/financier list keeps only real names
            for f in ("contractors", "financiers"):
                if isinstance(a.get(f), list):
                    a[f] = [x for x in a[f] if not JUNK.search(x.get("name", "") if isinstance(x, dict) else str(x))]
            status, why, page = verify(r, a, pages)
            st[status] += 1
            done[str(r["id"])] = today
            server = {"verification": r.get("verification"), "owner": r.get("owner") or "", "capacity": r.get("capacity") or "",
                      "value": value_of(r), "event_type": r.get("event_type") or "", "contractors": as_list(r.get("contractors")),
                      "financiers": as_list(r.get("financiers")), "description": r.get("description") or ""}
            haiku = {"verification": status, "why": why, "owner": a.get("owner") or "", "capacity": a.get("capacity") or "",
                     "value": value_of(a), "event_type": a.get("event_type") or "", "contractors": as_list(a.get("contractors")),
                     "financiers": as_list(a.get("financiers")), "description": (a.get("description") or "").strip()}
            diff = [f for f in ("verification", "owner", "capacity", "value", "event_type", "contractors", "financiers")
                    if str(server[f]).lower() != str(haiku[f]).lower()]
            st["agree on all fields" if not diff else "differ"] += 1
            raw.append({"date": today, "id": r["id"], "project": r["project_name"], "url": r["source_url"], "server": server, "haiku": haiku, "diff": diff})
            lines.append("- %s (%s) | server %s / haiku %s%s" % (r["project_name"], r["id"], server["verification"], status,
                         ("" if not diff else " | differs: " + ", ".join("%s [%s | %s]" % (f, server[f], haiku[f]) for f in diff if f != "verification"))))
            if MODE == "write" and status in ("full", "project_only"):
                updates.append(build_update(r, a, status, why, page))
    rx.save(DONE_F, done)
    if MODE == "shadow":
        rx.save(RAW_F, raw[-2000:])
    stamp = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    section = "## %s - %s, model %s, rows %d%s%s%s%s" % (stamp, MODE, rx.MODEL, len(rows), NL, dict(st), NL + NL, NL.join(lines))
    head = "# v3 extraction on Actions (" + MODE + ")"
    try:
        older = open(REPORT_F, encoding="utf-8").read().replace(head, "", 1).strip()
    except Exception:
        older = ""
    open(REPORT_F, "w", encoding="utf-8").write(head + NL + NL + section + NL + NL + older[:200000] + NL)   # newest run first
    print(section, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        open(summary, "a", encoding="utf-8").write(section + NL)
    if MODE == "write" and updates:
        for i in range(0, len(updates), 100):
            resp = rx.site_call("PATCH", "/wp-json/wtp/v1/opportunities-v3", params={"secret": rx.SECRET}, json={"dry": False, "updates": updates[i:i + 100]})
            print("PATCH", resp.status_code, resp.text[:200], flush=True)


if __name__ == "__main__":
    main()
