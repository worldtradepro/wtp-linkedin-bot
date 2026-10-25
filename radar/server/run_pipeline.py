#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Daily Pipeline Orchestrator
=========================================
Runs the full pipeline: fetcher → groq_analyzer → post_builder
Designed to be called by cron on cPanel.

Usage:
    python run_pipeline.py                    # full run
    python run_pipeline.py --no-post          # build but don't post to forum
    python run_pipeline.py --date 2026-03-08  # specific date
    python run_pipeline.py --step fetcher     # run single step

Exit codes:
    0 = success
    1 = fetcher failed
    2 = analyzer failed (no articles or Groq error)
    3 = post builder failed
    4 = forum posting failed
"""

import os
import sys
import json
import logging
import argparse
import requests
from datetime import datetime, timezone
from pathlib import Path

# ── Setup ─────────────────────────────────────────────────────────────────────

# Ensure we're in the project directory
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(PROJECT_DIR)

# Load .env file if present
ENV_FILE = os.path.join(PROJECT_DIR, ".env")
if os.path.exists(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

# Set OUTPUT_DIR to project data/ subdirectory
DATA_DIR = os.path.join(PROJECT_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
os.environ.setdefault("OUTPUT_DIR", DATA_DIR)
os.environ.setdefault("SOURCE_FILE", os.path.join(PROJECT_DIR, "source.txt"))
os.environ.setdefault("KEYWORDS_FILE", os.path.join(PROJECT_DIR, "keywords.txt"))
os.environ.setdefault("PROBE_FILE", os.path.join(PROJECT_DIR, "probe_report.txt"))
os.environ.setdefault("HEALTH_FILE", os.path.join(DATA_DIR, "source_health.json"))

# Logging
LOG_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
log_file = os.path.join(LOG_DIR, f"pipeline_{today_str}.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("pipeline")


# ── Pipeline Steps ────────────────────────────────────────────────────────────

def step_fetcher(date_str: str) -> bool:
    """Step 1: Fetch articles from all sources."""
    log.info("=" * 60)
    log.info("STEP 1: FETCHER")
    log.info("=" * 60)
    try:
        import fetcher
        articles = fetcher.run(dry_run=False)
        log.info(f"Fetcher complete: {len(articles)} articles")
        return len(articles) > 0
    except Exception as e:
        log.error(f"Fetcher failed: {e}", exc_info=True)
        return False


def step_analyzer(date_str: str) -> bool:
    """Step 2: Analyze articles with OpenRouter."""
    log.info("=" * 60)
    log.info("STEP 2: OPENROUTER ANALYZER")
    log.info("=" * 60)

    articles_file = os.path.join(DATA_DIR, f"articles_{date_str}.json")
    if not os.path.exists(articles_file):
        log.warning(f"No articles file found: {articles_file}")
        return False

    # Check if articles file is empty
    with open(articles_file, encoding="utf-8") as f:
        articles = json.load(f)
    if not articles:
        log.warning("Articles file is empty, skipping analyzer")
        return False

    try:
        import openrouter_analyzer
        opps = openrouter_analyzer.run(date_str=date_str)
        log.info(f"Analyzer complete: {len(opps)} opportunities")
        return len(opps) > 0
    except Exception as e:
        log.error(f"Analyzer failed: {e}", exc_info=True)
        return False


LIGHT_SOURCES = (("World Bank", "wb_procurement"), ("EU TED + UK FTS", "europe_procurement"))
# Bulk files (hundreds of MB); run after publishing, in a child process, so a memory kill (exit 137,
# 2026-09-28..30) can no longer stop the day's post and map data.
HEAVY_SOURCES = (("Development banks (IATI)", "iati_projects"), ("IFC disclosures", "ifc_projects"),
                 # Chinese EPC contractors' exchange filings (PDF + one model call each); slow site, so here too (2026-10-15)
                 ("China contractors (cninfo filings)", "cn_contractors"))


def step_official_sources(date_str: str, sources=LIGHT_SOURCES + HEAVY_SOURCES) -> bool:
    """Step 2b: Append official tenders/awards to the day's opportunities.

    World Bank procurement, EU TED, UK Find a Tender and development-bank project
    pipelines (IATI files): structured data straight from official sources (no LLM). Each source is independent and non-fatal:
    the news-based opportunities still publish if an API is down.
    """
    log.info("=" * 60)
    log.info("STEP 2b: OFFICIAL SOURCES (World Bank, EU TED, UK FTS, IATI, IFC, cninfo)")
    log.info("=" * 60)
    ok = True
    for name, module in sources:
        try:
            n = __import__(module).merge_into_opportunities(date_str, DATA_DIR)
            log.info(f"{name}: {n} items merged into opportunities_{date_str}.json")
        except Exception as e:
            log.error(f"{name} failed: {e}", exc_info=True)
            ok = False
    return ok


def step_classify(date_str: str) -> bool:
    """Step 2c: check every opportunity's sector / sub-sector against its own text.

    The analyzer's label comes from a language model and is sometimes wrong or too coarse (a hospital
    filed under rail, a battery park under power, LNG carriers under LNG). classify_fix.py corrects
    it with fixed rules before anything is published, and takes out the rows about subjects the site
    does not cover (airports, hospitals, roads, bridges, sewage works ...; owner's decision 2026-10-10).
    Non-fatal: on any error the file stays as it is.
    """
    opps_file = os.path.join(DATA_DIR, f"opportunities_{date_str}.json")
    if not os.path.exists(opps_file):
        return False
    try:
        import classify_fix
        with open(opps_file, encoding="utf-8") as f:
            opps = json.load(f)
        kept, dropped = classify_fix.split(opps)
        n = classify_fix.apply(kept)
        if n or dropped:
            with open(opps_file, "w", encoding="utf-8") as f:
                json.dump(kept, f, ensure_ascii=False, indent=2)
        log.info(f"Classification check: {n} of {len(kept)} rows corrected, {len(dropped)} off-topic rows dropped")
        for o in dropped:
            log.info(f"  dropped (off-topic): {o.get('project_name')}")
        return True
    except Exception as e:
        log.error(f"Classification check failed (labels left as they are): {e}", exc_info=True)
        return False


def step_v3(date_str: str) -> bool:
    """Step 2d: v3 enrichment - verification / paid_eligible, project + event facts, own-words description.

    Official rows -> full. Media rows: page read + model extraction; Google News rows: publisher page found through the
    Brave Search API (monthly cap 999, spread over the month). Rows that cannot be verified stay in the database as
    'limited' and are never sent to paid flows. Non-fatal and fail-safe: on any error unverified rows are marked limited.
    """
    opps_file = os.path.join(DATA_DIR, f"opportunities_{date_str}.json")
    if not os.path.exists(opps_file):
        return False
    try:
        import v3_daily
        st = v3_daily.run(date_str, opps_file, use_brave=os.environ.get("WTP_V3_BRAVE", "1") == "1")
        log.info(f"v3 enrichment: {st}")
        return True
    except Exception as e:
        log.error(f"v3 enrichment failed (rows go out as limited): {e}", exc_info=True)
        try:
            with open(opps_file, encoding="utf-8") as f:
                raw = json.load(f)
            items = raw if isinstance(raw, list) else raw.get("opportunities", [])
            for o in items:
                if not o.get("verification"):
                    o["verification"], o["paid_eligible"] = "limited", 0
            with open(opps_file, "w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return False


def step_post_builder(date_str: str, do_post: bool = True) -> bool:
    """Step 3: Build HTML post and optionally publish to forum."""
    log.info("=" * 60)
    log.info("STEP 3: POST BUILDER")
    log.info("=" * 60)

    opps_file = os.path.join(DATA_DIR, f"opportunities_{date_str}.json")
    if not os.path.exists(opps_file):
        log.warning(f"No opportunities file found: {opps_file}")
        return False

    try:
        import post_builder
        result = post_builder.run(date_str=date_str)

        # run() returns (html_body, schema_json) tuple
        if isinstance(result, tuple):
            html_body, schema_json = result
        else:
            html_body, schema_json = result, None

        if not html_body:
            log.warning("Post builder returned empty HTML")
            return False
        log.info(f"Post built: {len(html_body)} chars")

        if do_post:
            log.info("Publishing to forum...")
            try:
                posted = post_builder.post_to_forum(html_body, date_str)
                topic_id = posted.get("topic_id")
                log.info(f"Published! topic_id={topic_id}")
                # Store Schema to wp_options after successful post
                if topic_id and schema_json:
                    post_builder.api_store_schema(topic_id, schema_json)
                    log.info(f"Schema stored for topic_id={topic_id}")
            except Exception as e:
                log.error(f"Forum posting failed: {e}", exc_info=True)
                # Don't fail the whole pipeline for posting errors
                return True
        else:
            log.info("--no-post flag set, skipping forum publish")

        return True
    except Exception as e:
        log.error(f"Post builder failed: {e}", exc_info=True)
        return False


def step_publish_data(date_str: str) -> bool:
    """Step 4: Push structured opportunity data to the website's dashboard API.

    Distinct from step_post_builder — that publishes a formatted HTML digest as
    a forum topic; this pushes the raw structured records (country, sector,
    stage, location_source, etc.) so the map dashboard has something to query.
    Safe to re-run: the endpoint replaces any existing rows for the same
    (report_type, report_date) before inserting.
    """
    log.info("=" * 60)
    log.info("STEP 4: PUBLISH STRUCTURED DATA")
    log.info("=" * 60)

    opps_file = os.path.join(DATA_DIR, f"opportunities_{date_str}.json")
    if not os.path.exists(opps_file):
        log.warning(f"No opportunities file found: {opps_file}")
        return False

    with open(opps_file, encoding="utf-8") as f:
        opps = json.load(f)

    wp_domain = os.environ.get("WP_DOMAIN", "worldtradepro.com").strip('"').strip("'")
    secret = os.environ.get("WP_OPPS_SECRET") or os.environ.get("WTP_BOT_SECRET", "")   # Actions: GitHub secret, never a literal (public repo)
    url = f"https://{wp_domain}/wp-json/wtp/v1/opportunities?secret={secret}"

    payload = {
        "report_type": "epc",
        "report_date": date_str,
        "items": opps,
    }

    try:
        r = requests.post(url, json=payload, timeout=30)
        r.raise_for_status()
        result = r.json()
        log.info(f"Published {result.get('inserted', 0)} structured records for {date_str}")
        return True
    except Exception as e:
        log.error(f"Publish structured data failed: {e}", exc_info=True)
        # Non-fatal: the forum post already went out even if this fails
        return False


def _count_opps(date_str: str) -> int:
    try:
        with open(os.path.join(DATA_DIR, f"opportunities_{date_str}.json"), encoding="utf-8") as f:
            return len(json.load(f))
    except (OSError, ValueError):
        return -1


def step_heavy_sources_isolated(date_str: str) -> bool:
    """IATI + IFC in a child process; re-publish the map data if they added items."""
    import subprocess
    before = _count_opps(date_str)
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "--step", "official_heavy",
                            "--date", date_str, "--child"], timeout=45 * 60)
        code = r.returncode
    except subprocess.TimeoutExpired:
        code = "timeout"
    after = _count_opps(date_str)
    if code != 0:
        log.error(f"Heavy official sources ended with {code} (137 = killed for memory); day already published")
    if after > before:
        log.info(f"Heavy sources added {after - before} items; re-publishing structured data")
        step_classify(date_str)
        step_v3(date_str)
        step_publish_data(date_str)
    return code == 0


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="EPC Radar Pipeline")
    parser.add_argument("--date", type=str, default=None,
                        help="Date (YYYY-MM-DD), defaults to today UTC")
    parser.add_argument("--no-post", action="store_true",
                        help="Build post but don't publish to forum")
    parser.add_argument("--step", type=str, default=None,
                        choices=["fetcher", "analyzer", "official", "official_light", "official_heavy",
                                 "classify", "v3", "post_builder", "publish_data"],
                        help="Run only a specific step")
    parser.add_argument("--child", action="store_true",
                        help="internal: started by the pipeline itself, which already holds the lock")
    args = parser.parse_args()

    date_str = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Daily forum threads stopped 2026-09-30 (user): the forum gets one weekly thread linking to the
    # Insights article. The post is still built (data/post_<date>.html); WTP_EPC_FORUM_POST=1 turns posting back on.
    do_post = not args.no_post and os.environ.get("WTP_EPC_FORUM_POST") == "1"

    # ── Concurrency lock ──────────────────────────────────────────────────────
    import fcntl
    LOCK_FILE = os.path.join(PROJECT_DIR, "pipeline.lock")
    lock_fh = open(LOCK_FILE, "w")
    try:
        if not args.child:
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.warning(f"Another pipeline instance is already running (lock: {LOCK_FILE}). Exiting.")
        lock_fh.close()
        sys.exit(0)
    # Lock is held for the lifetime of this process; released automatically on exit
    # ─────────────────────────────────────────────────────────────────────────

    log.info(f"EPC Radar Pipeline — {date_str}")
    log.info(f"Project dir: {PROJECT_DIR}")
    log.info(f"Data dir:    {DATA_DIR}")
    log.info(f"Post to forum: {do_post}")
    log.info(f"Python: {sys.executable}")

    start = datetime.now(timezone.utc)

    if args.step:
        # Run single step
        if args.step == "fetcher":
            ok = step_fetcher(date_str)
        elif args.step == "analyzer":
            ok = step_analyzer(date_str)
        elif args.step == "official":
            ok = step_official_sources(date_str)
        elif args.step == "official_light":
            ok = step_official_sources(date_str, LIGHT_SOURCES)
        elif args.step == "official_heavy":
            ok = step_official_sources(date_str, HEAVY_SOURCES)
        elif args.step == "classify":
            ok = step_classify(date_str)
        elif args.step == "v3":
            ok = step_v3(date_str)
        elif args.step == "post_builder":
            ok = step_post_builder(date_str, do_post)
        elif args.step == "publish_data":
            ok = step_publish_data(date_str)
        sys.exit(0 if ok else 1)

    # Full pipeline
    if not step_fetcher(date_str):
        log.error("Pipeline stopped: fetcher produced no articles")
        sys.exit(1)

    if not step_analyzer(date_str):
        log.warning("Analyzer produced no opportunities — still building empty post")

    step_official_sources(date_str, LIGHT_SOURCES)
    step_classify(date_str)
    step_v3(date_str)
    step_post_builder(date_str, do_post)
    step_publish_data(date_str)
    step_heavy_sources_isolated(date_str)

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    log.info(f"Pipeline complete in {elapsed:.0f}s")
    sys.exit(0)


if __name__ == "__main__":
    main()