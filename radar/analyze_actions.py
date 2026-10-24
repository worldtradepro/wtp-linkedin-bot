# -*- coding: utf-8 -*-
"""
Phase 2 of the move off OpenRouter (owner 2026-10-24): the server's media steps - fetch the day's articles (fetcher.py) and screen them
for projects (openrouter_analyzer.py) - run here with Claude Haiku 5.5 on the owner's subscription (the `claude` CLI).

SHADOW (only mode for now): nothing is written to the site. The day's result is compared with the rows the server pipeline published
today (matched by article id / source url) and saved to state/analyze_shadow_report.md. The files are copies of the live server code
(radar/pipeline/); the only change is the model call.

Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN, optional ANALYZE_MODEL (claude-haiku-5-5), ANALYZER_BATCH (8).
"""
import os, re, sys, json, glob, datetime, subprocess, tempfile, collections

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(HERE, "pipeline")
STATE = os.path.join(os.path.dirname(HERE), "state")
ART_DIR = os.path.join(STATE, "radar_articles")
os.makedirs(ART_DIR, exist_ok=True)
os.environ["OUTPUT_DIR"] = ART_DIR
os.environ["HEALTH_FILE"] = os.path.join(ART_DIR, "source_health.json")
os.environ.setdefault("ANALYZER_BATCH", "8")            # Haiku thinks before answering: 25 per batch overran the output limit (local test)
os.environ.setdefault("ANALYZER_MAX_TOKENS", "16000")
MODEL = os.environ.get("ANALYZE_MODEL", "claude-haiku-5-5")
OFFICIAL = ("ted-", "fts-", "wb-", "iati-", "ifc-", "cn-")
NL = chr(10)

sys.path.insert(0, HERE)
import radar_enrich as rx                  # site calls (Cloudflare-safe), row listing
os.chdir(PIPE)
sys.path.insert(0, PIPE)
for m in ("fetcher", "fieldsv2", "compliance"):
    sys.modules.pop(m, None)               # use the server copies in radar/pipeline, not radar/'s own helpers
import fetcher, openrouter_analyzer as oa


def claude_text(prompt):
    raw = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    env = dict(os.environ)
    if raw:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = re.sub(r"\s+", "", raw)
    out = subprocess.run(["claude", "-p", "Follow the instructions in the input exactly and reply with the JSON only.", "--model", MODEL,
                          "--max-turns", "1", "--output-format", "json"], input=prompt, cwd=tempfile.mkdtemp(prefix="analyze-"),
                         env=env, capture_output=True, text=True, timeout=900)
    try:
        return json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get("result") or ""
    except Exception:
        raise RuntimeError("claude CLI failed: " + (out.stdout or out.stderr)[:300])


oa.call_openrouter = claude_text           # the only change against the server's analyzer
oa.time.sleep = lambda s: None


def site_rows(days):
    rx.DAYS, rx.BACKLOG = days, False
    return rx.get_rows()


def main():
    if not rx.SECRET:
        sys.exit("WTP_BOT_SECRET missing")
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    rows = site_rows(8)
    media = [r for r in rows if not (r.get("article_id") or "").startswith(OFFICIAL)]
    # what the server has already seen: our own article files plus every media row of the last week (its article id = url hash)
    old_seen = fetcher.load_seen_urls
    known = {r.get("article_id") for r in media if str(r.get("report_date"))[:10] < today}
    known |= {fetcher.url_hash(r["source_url"]) for r in media if r.get("source_url") and str(r.get("report_date"))[:10] < today}
    fetcher.load_seen_urls = lambda d: old_seen(d) | {k for k in known if k}

    arts = fetcher.run(dry_run=False)
    opps = oa.run(date_str=today) if arts else []
    srv = [r for r in media if str(r.get("report_date"))[:10] == today]
    srv_by = {}
    for r in srv:
        for k in (r.get("article_id"), fetcher.url_hash(r["source_url"]) if r.get("source_url") else None):
            if k:
                srv_by.setdefault(k, []).append(r)
    earlier = {fetcher.url_hash(r["source_url"]) for r in media if r.get("source_url") and str(r.get("report_date"))[:10] < today}
    # the two sides often hold different links for one story (Google News redirect vs the publisher's own URL): match names too
    def same_name(a, b):
        return bool(a and b) and oa._similarity(oa._normalize_name(a), oa._normalize_name(b)) >= 0.6
    def by_name(o, pool):
        return next((r for r in pool if same_name(o.get("project_name"), r.get("project_name"))
                     and (o.get("country") or "").lower()[:5] == (r.get("country") or "").lower()[:5]), None)
    older = [r for r in media if str(r.get("report_date"))[:10] < today]
    st, lines = collections.Counter(), []
    matched_srv = set()
    for o in opps:
        aid = o.get("article_id")
        hits = srv_by.get(aid) or srv_by.get(fetcher.url_hash(o.get("source_url") or "")) or []
        if not hits:
            r0 = by_name(o, [r for r in srv if r["id"] not in matched_srv])
            hits = [r0] if r0 else []
        if hits:
            r = hits[0]; matched_srv.add(r["id"])
            diff = [f for f in ("country", "sector", "stage") if (o.get(f) or "").split("-")[0].lower() != (r.get(f) or "").split("-")[0].lower()]
            st["both"] += 1
            lines.append("- BOTH | %s || server: %s%s" % (o.get("project_name"), r.get("project_name"),
                         ("" if not diff else " | differs: " + ", ".join("%s [%s | %s]" % (f, r.get(f), o.get(f)) for f in diff))))
        elif aid in earlier or by_name(o, older):
            st["haiku only, server had it on an earlier day"] += 1
        else:
            st["haiku only"] += 1
            lines.append("- HAIKU ONLY | %s | %s | %s | %s" % (o.get("project_name"), o.get("country"), o.get("stage"), o.get("source_url") or ""))
    for r in srv:
        if r["id"] not in matched_srv:
            st["server only"] += 1
            lines.append("- SERVER ONLY | %s | %s | %s | %s" % (r.get("project_name"), r.get("country"), r.get("stage"), r.get("source_url") or ""))
    stamp = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    section = "## %s - model %s, articles fetched %d, projects %d, server media rows today %d%s%s%s%s" % (
        stamp, MODEL, len(arts or []), len(opps), len(srv), NL, dict(st), NL + NL, NL.join(lines))
    rep = os.path.join(STATE, "analyze_shadow_report.md")
    head = "# Article screening on Actions (shadow, writes nothing)"
    try:
        older = open(rep, encoding="utf-8").read().replace(head, "", 1).strip()
    except Exception:
        older = ""
    open(rep, "w", encoding="utf-8").write(head + NL + NL + section + NL + NL + older[:200000] + NL)
    for f in glob.glob(os.path.join(ART_DIR, "opportunities_*.json")):     # keep a week of results
        if os.path.basename(f)[14:24] < (datetime.date.today() - datetime.timedelta(days=7)).isoformat():
            os.remove(f)
    print(section, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        open(summary, "a", encoding="utf-8").write(section + NL)


if __name__ == "__main__":
    main()
