# -*- coding: utf-8 -*-
"""
The whole EPC Radar daily pipeline on GitHub Actions (owner 2026-10-25: "直接整体迁到这里" - move all of it off the server).

radar/server/ is a copy of the server's ~/automation/epc_radar code (pulled 2026-10-25). The only changes: every model call
(analyzer, cninfo filings, title translation - all go through openrouter_analyzer.call_openrouter) uses Claude Haiku 5.5 on the
owner's subscription, the publish call goes through radar/site.mjs (python-requests from a runner gets Cloudflare's challenge),
and the site key comes from the WTP_BOT_SECRET GitHub secret (this repo is public: no key, article text or project rows are
committed - only the small "already seen" lists in state/radar_data/).

Steps = the server's run_pipeline.py: fetch articles -> screen them -> World Bank + EU TED + UK FTS -> classify -> v3 (official rows;
media rows stay for radar-v3, WTP_V3_MEDIA=actions) -> publish -> IATI + IFC + cninfo -> publish again.

PIPELINE_MODE
  shadow (default): writes nothing to the site and keeps no state; compares the day's rows with what the server published
                    (server runs 14:30 UTC, publishes ~14:38) -> state/pipeline_shadow_report.md
  write:            publishes (replaces the day's epc rows on the site, like the server) and saves state/radar_data/.
                    Only one writer per day: switch to write only after the server's cron is paused.

Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN, optional PIPELINE_MODE, PIPELINE_DATE, ANALYZE_MODEL, ANALYZER_BATCH (8).
"""
import os, re, sys, json, glob, shutil, datetime, subprocess, tempfile, logging

HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.join(HERE, "server")
ROOT = os.path.dirname(HERE)
STATE = os.path.join(ROOT, "state", "radar_data")              # committed: small "seen" lists only
KEEP = ("cn_seen.json", "iati_seen.json", "source_health.json", "title_cache.json", "brave_usage.json")
MODE = os.environ.get("PIPELINE_MODE", "shadow").strip().lower()
DATE = os.environ.get("PIPELINE_DATE") or datetime.datetime.utcnow().strftime("%Y-%m-%d")
MODEL = os.environ.get("ANALYZE_MODEL", "claude-haiku-5-5")
os.environ.setdefault("ANALYZER_BATCH", "8")                    # Haiku thinks before answering: 25 per batch overran the output limit
os.environ.setdefault("ANALYZER_MAX_TOKENS", "16000")
os.environ.setdefault("WTP_V3_MEDIA", "actions")                # media rows -> radar-v3 workflow (as on the server since 2026-10-24)
os.environ["WP_OPPS_SECRET"] = os.environ.get("WTP_BOT_SECRET", "").strip()

sys.path.insert(0, HERE)
import radar_enrich as rx                                        # site calls through Node (Cloudflare-safe), row listing

# working data folder = the server's data/ (git-ignored); seed it with yesterday's "seen" lists
WORK = os.path.join(SRV, "data")
os.makedirs(WORK, exist_ok=True)
for n in KEEP:
    if os.path.exists(os.path.join(STATE, n)):
        shutil.copy2(os.path.join(STATE, n), os.path.join(WORK, n))
SEEN_FILE = os.path.join(STATE, "seen_articles.json")
seen_ids = json.load(open(SEEN_FILE, encoding="utf-8")) if os.path.exists(SEEN_FILE) else {}

sys.path.insert(0, SRV)
for m in ("fetcher", "fieldsv2", "compliance"):
    sys.modules.pop(m, None)                                     # radar_enrich loaded radar/'s own helpers: use the server copies from here on
import run_pipeline as rp                                       # chdir's to radar/server, sets DATA_DIR = radar/server/data
import fetcher, openrouter_analyzer as oa

log = logging.getLogger("actions")


def claude_text(prompt):
    env = dict(os.environ)
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        env["CLAUDE_CODE_OAUTH_TOKEN"] = re.sub(r"\s+", "", os.environ["CLAUDE_CODE_OAUTH_TOKEN"])
    out = subprocess.run(["claude", "-p", "Follow the instructions in the input exactly and reply with the JSON only.", "--model", MODEL,
                          "--max-turns", "1", "--output-format", "json"], input=prompt, cwd=tempfile.mkdtemp(prefix="pipeline-"),
                         env=env, capture_output=True, text=True, timeout=900)
    try:
        return json.loads([ln for ln in out.stdout.splitlines() if ln.strip()][-1]).get("result") or ""
    except Exception:
        raise RuntimeError("claude CLI failed: " + (out.stdout or out.stderr)[:300])


oa.call_openrouter = claude_text                                 # analyzer, cn_contractors and title_translate all call this
oa.time.sleep = lambda s: None
_load_seen = fetcher.load_seen_urls
# 7-day "seen" memory without keeping article files; only earlier days (a re-run, or a shadow run after the server, must not
# treat the day's own articles as seen - the first shadow run 2026-10-25 found 0 rows that way)
fetcher.load_seen_urls = lambda d: _load_seen(d) | {k for k, v in seen_ids.items() if v < DATE}


def publish(date_str):
    """run_pipeline.step_publish_data, but through site.mjs (same endpoint and payload: replaces the day's epc rows)."""
    path = os.path.join(rp.DATA_DIR, f"opportunities_{date_str}.json")
    if not os.path.exists(path):
        log.warning("no opportunities file - nothing published")
        return False
    opps = json.load(open(path, encoding="utf-8"))
    r = rx.site_call("POST", "/wp-json/wtp/v1/opportunities", params={"secret": os.environ["WP_OPPS_SECRET"]},
                     json={"report_type": "epc", "report_date": date_str, "items": opps})
    ok = r.status_code < 300
    log.info(f"publish {date_str}: HTTP {r.status_code} {r.text[:200]}")
    return ok


def rows_for(date_str):
    path = os.path.join(rp.DATA_DIR, f"opportunities_{date_str}.json")
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []


def shadow_report(date_str, mine):
    """Compare with what the server published for the same report date (counts + project names; no full rows in this public repo)."""
    rx.DAYS, rx.BACKLOG = 2, False
    srv = [r for r in rx.get_rows() if str(r.get("report_date"))[:10] == date_str]
    # same article id, or names the analyzer's own de-duplication would call the same project ("Dangote Refinery" ~ "Dangote Refinery Project, Kenya")
    aid = lambda o: o.get("article_id") or o.get("id") or ""
    same = lambda a, b: (aid(a) and aid(a) == aid(b)) or oa._similarity(oa._normalize_name(a.get("project_name") or ""), oa._normalize_name(b.get("project_name") or "")) >= 0.6
    kind = lambda o: "official" if str(aid(o)).startswith(rp_official) else "media"
    both = [o for o in mine if any(same(o, r) for r in srv)]
    only_me = [o for o in mine if o not in both]
    only_srv = [r for r in srv if not any(same(o, r) for o in mine)]
    lines = [f"## {date_str} - shadow run {datetime.datetime.utcnow():%H:%M} UTC, model {MODEL}",
             f"Actions: {len(mine)} rows ({sum(kind(o) == 'official' for o in mine)} official) - server published: {len(srv)} rows - in both: {len(both)}", ""]
    lines += [f"- ACTIONS ONLY ({kind(o)}): {o.get('project_name')} | {o.get('country')} | {o.get('stage')}" for o in only_me]
    lines += [f"- SERVER ONLY: {r.get('project_name')} | {r.get('country')} | {r.get('stage')}" for r in only_srv]
    rep = os.path.join(ROOT, "state", "pipeline_shadow_report.md")
    old = open(rep, encoding="utf-8").read().split("\n", 2)[-1] if os.path.exists(rep) else ""
    open(rep, "w", encoding="utf-8").write("# Whole pipeline on Actions (shadow, writes nothing)\n\n" + "\n".join(lines) + "\n\n" + old[:60000])
    print("\n".join(lines))


rp_official = ("wb-", "ted-", "fts-", "iati-", "ifc-", "cn-")


def save_state(date_str):
    for n in KEEP:
        if os.path.exists(os.path.join(rp.DATA_DIR, n)):
            shutil.copy2(os.path.join(rp.DATA_DIR, n), os.path.join(STATE, n))
    arts = os.path.join(rp.DATA_DIR, f"articles_{date_str}.json")
    if os.path.exists(arts):
        for a in json.load(open(arts, encoding="utf-8")):
            seen_ids[a["id"]] = date_str
    cut = (datetime.date.fromisoformat(date_str) - datetime.timedelta(days=8)).isoformat()
    json.dump({k: v for k, v in seen_ids.items() if v >= cut}, open(SEEN_FILE, "w", encoding="utf-8"), indent=0)


def main():
    if not os.environ["WP_OPPS_SECRET"]:
        sys.exit("WTP_BOT_SECRET missing")
    if MODE not in ("shadow", "write"):
        sys.exit("PIPELINE_MODE must be shadow or write")
    log.info(f"EPC Radar pipeline on Actions - {DATE} - mode {MODE}")
    if not rp.step_fetcher(DATE):
        log.error("fetcher produced no articles (official sources still run)")
    else:
        rp.step_analyzer(DATE)
    rp.step_official_sources(DATE, rp.LIGHT_SOURCES)
    rp.step_classify(DATE)
    rp.step_v3(DATE)
    if MODE == "write":
        publish(DATE)
    rp.step_official_sources(DATE, rp.HEAVY_SOURCES)               # IATI + IFC + cninfo (the server runs these in a child process)
    rp.step_classify(DATE)
    rp.step_v3(DATE)
    if MODE == "write":
        publish(DATE)
        save_state(DATE)
    else:
        shadow_report(DATE, rows_for(DATE))


if __name__ == "__main__":
    main()
