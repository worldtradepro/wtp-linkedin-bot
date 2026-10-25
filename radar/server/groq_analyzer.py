#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Groq Analyzer
=============================
Reads articles_YYYY-MM-DD.json, sends all articles in one batched prompt
to Groq (Llama 3.3-70B), extracts structured EPC project opportunities.

Output: opportunities_YYYY-MM-DD.json

Usage:
    python groq_analyzer.py                        # analyze today's articles
    python groq_analyzer.py --date 2026-03-08      # specific date
    python groq_analyzer.py --dry-run              # print prompt, don't call API
    python groq_analyzer.py --input articles.json  # custom input file

Required env vars:
    GROQ_API_KEY

Optional env vars:
    OUTPUT_DIR       (default: .)
    GROQ_MODEL       (default: llama-3.3-70b-versatile)
"""

import os
import re
import json
import argparse
import time
import logging
from datetime import datetime, timezone
from pathlib import Path

import requests

# ── Load .env from script directory ───────────────────────────────────────────
def _load_env_file(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass

_load_env_file(os.path.join(os.path.dirname(__file__), ".env"))

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("analyzer")

# ── Config ────────────────────────────────────────────────────────────────────
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
OUTPUT_DIR   = os.getenv("OUTPUT_DIR", ".")
GROQ_MODEL   = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# Fallback chain — tried in order if primary model fails
GROQ_MODEL_FALLBACKS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama3-8b-8192",
    "gemma2-9b-it",
]

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"

# ── Sector taxonomy (matches post_builder) ────────────────────────────────────
SECTOR_TAXONOMY = """
Energy:
  - Oil & Gas
  - LNG
  - Refining & Petrochemicals
  - Renewables
  - Hydrogen & Ammonia
  - Power & Transmission
  - Water & Desalination

Mining & Metals:
  - Mine Development
  - Processing & Smelting
  - Critical Minerals

Agriculture:
  - Fertilizer Plants
  - Grain & Food Infrastructure
  - Irrigation & Water

Logistics & Infrastructure:
  - Ports & Terminals
  - Pipelines & Storage
  - Rail & Inland Transport
  - Shipyard & Fleet
"""

# ── Prompt ────────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a commodity supply chain intelligence analyst.
Your job is to read industry news articles and extract structured signals about
large capital projects and procurement events that matter to supply chain players —
EPC contractors, major equipment vendors, and materials/services suppliers.

Focus on ANY of the following signals:
- EPC/EPCI contract awards, FIDs, tenders, FEED awards, groundbreakings
- New infrastructure developments (plants, terminals, mines, pipelines, ports, vessels)
- Equipment procurement: major orders for turbines, compressors, vessels, mining equipment,
  transformers, subsea hardware, or any high-value capital equipment
- MoUs or framework agreements between project owners and equipment/service suppliers
  (these signal upcoming procurement even without a final contract)
- Financing closes, investment decisions, government approvals for major projects
- Vessel newbuild orders (signals shipyard procurement and fleet expansion)
- Capacity expansions, restarts, brownfield upgrades, or retrofits/conversions at existing facilities
- Long-term charter or lease agreements for vessels, equipment, or infrastructure
  (these signal ongoing operational procurement for maintenance, spares, and services)

Ignore:
- Pure financial results, earnings reports, dividend announcements
- Personnel changes, leadership appointments
- ESG/sustainability reports with no project content
- Pure geopolitical or conflict news with no identifiable project or procurement angle
- Articles with no identifiable project, asset, or procurement event
- Historical events (FID already taken, project already built) UNLESS the article
  was published within the past 36 hours AND reports a genuinely new development.
  If the article is simply a republished or re-indexed old story, omit it.

Return ONLY a valid JSON array. No markdown, no explanation, no preamble.
Each element must follow the exact schema provided.
If an article yields no valid opportunity, omit it entirely from the output.
"""

def build_prompt(articles: list[dict]) -> str:
    """Build the batched analysis prompt."""

    # Format articles for prompt
    articles_text = ""
    for i, a in enumerate(articles, 1):
        summary = (a.get('summary') or '')[:150]
        articles_text += f"""
---ARTICLE {i}---
ID: {a['id']}
Source: {a['source_name']} ({a['source_category']}) [credibility: {a['credibility']}★]
Title: {a['title']}
Published: {a['published']}
Summary: {summary}
URL: {a['url']}
"""

    schema = """
Output schema for each opportunity (JSON array):
[
  {
    "article_id":   "string — the ID field from the article",
    "project_name": "string — concise project name, e.g. 'Ruwais LNG Expansion'",
    "country":      "string — country where project is located, ISO name",
    "region":       "string — one of: Africa | Middle East | Europe | Asia Pacific | Americas | Global",
    "sector":       "string — top-level sector from taxonomy",
    "subsector":    "string — subsector from taxonomy",
    "stage":        "string — one of: S1-Feasibility | S2-Development | S3-Pre-FID | S4-Tender | S5-Awarded",
    "scale":        "string — one of: Large (>$500M or >1GW) | Medium ($50-500M) | Small (<$50M) | Unknown",
    "description":  "string — one sentence max 120 chars, factual, no hype",
    "source_url":   "string — URL of the original article",
    "credibility":  "integer — credibility stars 1-5 from source",
    "confidence":   "string — one of: High | Medium | Low (your confidence this is a real project or procurement signal)"
  }
]
"""

    taxonomy_block = f"\nSector taxonomy to use:\n{SECTOR_TAXONOMY}\n"

    MAX_PROMPT_CHARS = 20_000  # ~10K tokens, safe ceiling for Groq free tier

    prompt = f"""{SYSTEM_PROMPT}

{taxonomy_block}
{schema}

Stage definitions:
- S1-Feasibility: feasibility study, EIA, MOU, concept study, exploration
- S2-Development: FEED, pre-FEED, financing, PPA, permitting, DFS
- S3-Pre-FID:     FID imminent, FEED complete, board approval pending
- S4-Tender:      EPC tender, ITT, RFQ, bidding, shortlist, LOI
- S5-Awarded:     contract award, LOA, NTP, groundbreaking, construction start,
                  vessel/equipment newbuild order, long-term charter/lease signed,
                  retrofit or conversion contract awarded

Scale definitions:
- Large:   any of: >$500M capital value | >1GW (power/renewables) | >1Mtpa (LNG/fertilizer/minerals) |
           >10Mtpa (bulk commodities) | >500ktpa (metals/aluminium) | explicitly "world-scale" / "major"
- Medium:  any of: $50M–$500M | 100MW–1GW | 0.1–1Mtpa
- Small:   <$50M or <100MW or <0.1Mtpa
- Unknown: no value, capacity, or throughput mentioned in the article

Now analyze these {len(articles)} articles and return the JSON array:
{articles_text}"""

    if len(prompt) > MAX_PROMPT_CHARS:
        log.warning(f"Prompt too large ({len(prompt):,} chars), truncating to {MAX_PROMPT_CHARS:,}")
        prompt = prompt[:MAX_PROMPT_CHARS]

    return prompt


# ── Groq call ─────────────────────────────────────────────────────────────────

def call_groq(prompt: str) -> str:
    """Call Groq API. Returns raw response text."""
    if not GROQ_API_KEY:
        raise RuntimeError("Missing GROQ_API_KEY environment variable")

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    # Build model list: primary first, then fallbacks (deduped)
    primary = GROQ_MODEL
    models_to_try = [primary] + [m for m in GROQ_MODEL_FALLBACKS if m != primary]

    for model in models_to_try:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": 4096,
        }
        for attempt in range(2):  # 2 attempts per model
            try:
                log.info(f"Calling Groq: {model} (attempt {attempt + 1})")
                r = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=60)
                if r.status_code == 429:
                    wait = 30 * (attempt + 1)
                    log.warning(f"Rate limited on {model}, waiting {wait}s...")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"].strip()
            except Exception as e:
                log.warning(f"Groq {model} attempt {attempt + 1} failed: {e}")
                if attempt < 1:
                    time.sleep(5)
        log.warning(f"Model {model} exhausted, trying next fallback...")

    raise RuntimeError("Groq API failed — all models exhausted")


def parse_response(raw: str) -> list[dict]:
    """Parse Groq JSON response, stripping markdown fences if present."""
    # Strip ```json ... ``` or ``` ... ```
    text = raw.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)
    text = text.strip()

    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        # Sometimes model wraps in {"opportunities": [...]}
        for key in ["opportunities", "results", "projects", "data"]:
            if isinstance(data, dict) and key in data:
                return data[key]
        log.warning("Unexpected JSON structure, returning empty list")
        return []
    except json.JSONDecodeError as e:
        log.error(f"JSON parse error: {e}")
        log.error(f"Raw response (first 500 chars): {raw[:500]}")
        return []


def validate_opportunity(opp: dict) -> bool:
    """Basic validation of opportunity fields."""
    required = ["article_id", "project_name", "country", "sector",
                "stage", "scale", "description", "source_url"]
    for field in required:
        if not opp.get(field):
            log.debug(f"Missing field '{field}' in opportunity: {opp.get('project_name','?')}")
            return False

    # Stage must be valid
    valid_stages = {"S1-Feasibility", "S2-Development", "S3-Pre-FID",
                    "S4-Tender", "S5-Awarded"}
    if opp.get("stage") not in valid_stages:
        log.debug(f"Invalid stage '{opp.get('stage')}' for {opp.get('project_name')}")
        return False

    # Filter out Low confidence opportunities
    if opp.get("confidence") == "Low":
        log.debug(f"Low confidence, skipping: {opp.get('project_name')}")
        return False

    return True


def enrich_opportunity(opp: dict, articles_by_id: dict) -> dict:
    """Add fields from original article that model may not have set."""
    article = articles_by_id.get(opp.get("article_id"), {})
    if not opp.get("credibility") and article.get("credibility"):
        opp["credibility"] = article["credibility"]
    if not opp.get("source_name"):
        opp["source_name"] = article.get("source_name", "")
    if not opp.get("published"):
        opp["published"] = article.get("published", "")
    if not opp.get("source_category"):
        opp["source_category"] = article.get("source_category", "")
    return opp


# ── Deduplication ─────────────────────────────────────────────────────────────

def _normalize_name(name: str) -> str:
    """Normalize project name for fuzzy matching.
    Strips common suffixes, lowercases, removes punctuation."""
    import re as _re
    name = name.lower().strip()
    # Remove common trailing words that vary across sources
    for suffix in ["project", "expansion", "development", "contract",
                   "plant", "facility", "terminal", "mine", "farm",
                   "construction", "works", "program", "programme"]:
        name = _re.sub(r'\s+' + suffix + r'$', '', name)
    # Remove punctuation and extra whitespace
    name = _re.sub(r'[^\w\s]', '', name)
    name = _re.sub(r'\s+', ' ', name).strip()
    return name


def _similarity(a: str, b: str) -> float:
    """Simple word-overlap similarity between two normalized strings."""
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    return len(intersection) / min(len(words_a), len(words_b))


def deduplicate_opportunities(opps: list[dict]) -> list[dict]:
    """Merge duplicate opportunities that describe the same project.

    Two opportunities are considered duplicates when:
      - Same country (exact match)
      - Same sector (exact match)
      - Project name similarity >= 0.6 (word overlap)

    Among duplicates, keep the one with highest credibility.
    If tied, keep the one with the longest description.
    """
    if not opps:
        return opps

    # Group candidates by (country, sector) for efficient comparison
    from collections import defaultdict
    groups = defaultdict(list)
    for opp in opps:
        key = (opp.get("country", "").lower(), opp.get("sector", "").lower())
        groups[key].append(opp)

    deduped = []
    for key, group in groups.items():
        if len(group) == 1:
            deduped.append(group[0])
            continue

        # Cluster similar project names within the group
        used = [False] * len(group)
        for i in range(len(group)):
            if used[i]:
                continue
            cluster = [group[i]]
            name_i = _normalize_name(group[i].get("project_name", ""))
            for j in range(i + 1, len(group)):
                if used[j]:
                    continue
                name_j = _normalize_name(group[j].get("project_name", ""))
                if _similarity(name_i, name_j) >= 0.6:
                    cluster.append(group[j])
                    used[j] = True
            used[i] = True

            # Pick best from cluster: highest credibility, then longest description
            best = max(cluster, key=lambda o: (
                o.get("credibility", 0),
                len(o.get("description", "")),
            ))

            # Collect all unique source names for reference
            all_sources = list(dict.fromkeys(
                o.get("source_name", "") for o in cluster if o.get("source_name")
            ))
            if len(cluster) > 1:
                best["source_name"] = " / ".join(all_sources[:3])
                log.info(f"  Dedup: merged {len(cluster)} entries → '{best.get('project_name')}' (sources: {', '.join(all_sources)})")

            deduped.append(best)

    log.info(f"Deduplication: {len(opps)} → {len(deduped)} opportunities")
    return deduped


# ── Main ──────────────────────────────────────────────────────────────────────

def run(input_file: str = None, date_str: str = None,
        dry_run: bool = False, verbose: bool = False) -> list[dict]:

    # Resolve input file
    if not input_file:
        if not date_str:
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        input_file = os.path.join(OUTPUT_DIR, f"articles_{date_str}.json")

    if not os.path.exists(input_file):
        log.error(f"Input file not found: {input_file}")
        return []

    with open(input_file, encoding="utf-8") as f:
        articles = json.load(f)

    if not articles:
        log.info("No articles to analyze")
        return []

    log.info(f"Loaded {len(articles)} articles from {input_file}")

    # ── Pre-filter: keep only articles with strong EPC/procurement signals ────
    STRONG_SIGNALS = [
        "award", "awarded", "contract", "epc", "epci", "epcm", "feed",
        "fid", "tender", "itt", "rfq", "rfp", "loi", "loa", "ntp",
        "order", "newbuild", "groundbreaking", "construction start",
        "first steel", "sanction", "sanctioned", "financial close",
        "charter", "offtake", "purchase order", "supply agreement",
        "preferred supplier", "shortlist", "prequalif", "procurement",
        "fpso", "flng", "fsru", "liquefaction", "regasification",
        "refinery", "cracker", "smelter", "concentrator", "mine development",
        "pipeline project", "terminal expansion", "port expansion",
        "power plant", "solar farm", "wind farm", "electrolyser",
    ]

    def has_strong_signal(article):
        title = (article.get("title") or "").lower()
        summary = (article.get("summary") or "")[:300].lower()
        text = f"{title} {summary}"
        return any(sig in text for sig in STRONG_SIGNALS)

    filtered = [a for a in articles if has_strong_signal(a)]
    skipped = len(articles) - len(filtered)
    if skipped:
        log.info(f"Pre-filter: {len(filtered)}/{len(articles)} articles kept ({skipped} skipped — no strong EPC signal)")
    articles = filtered

    if not articles:
        log.info("No articles passed pre-filter")
        return []

    # Build lookup by article ID for enrichment
    articles_by_id = {a["id"]: a for a in articles}

    # ── Batch processing: split articles into chunks of 15 ───────────────────
    BATCH_SIZE = 15
    batches = [articles[i:i+BATCH_SIZE] for i in range(0, len(articles), BATCH_SIZE)]
    log.info(f"Processing {len(articles)} articles in {len(batches)} batch(es) of up to {BATCH_SIZE}")

    all_raw_opps = []

    for batch_num, batch in enumerate(batches, 1):
        prompt = build_prompt(batch)
        log.info(f"Batch {batch_num}/{len(batches)}: {len(batch)} articles, {len(prompt)} chars / ~{len(prompt)//4} tokens")

        if dry_run:
            log.info(f"[DRY RUN] Batch {batch_num} prompt preview (first 500 chars):")
            print(prompt[:500])
            continue

        try:
            raw = call_groq(prompt)
            log.info(f"Batch {batch_num} response: {len(raw)} chars")
            if verbose:
                print(f"\n── RAW GROQ RESPONSE (batch {batch_num}) ────────────────────")
                print(raw)
                print("─────────────────────────────────────────────────────────\n")
            batch_opps = parse_response(raw)
            log.info(f"Batch {batch_num}: parsed {len(batch_opps)} opportunities")
            all_raw_opps.extend(batch_opps)
        except Exception as e:
            log.error(f"Batch {batch_num} failed: {e} — skipping")
            continue

        # Wait between batches to respect Groq rate limit (~6K tokens/min)
        if batch_num < len(batches):
            log.info("Waiting 90s between batches (Groq rate limit)...")
            time.sleep(90)

    if dry_run:
        return []

    log.info(f"Total raw opportunities across all batches: {len(all_raw_opps)}")

    # Parse and validate
    opportunities = all_raw_opps
    log.info(f"Parsed {len(opportunities)} opportunities from Groq")

    valid_opps = []
    for opp in opportunities:
        if validate_opportunity(opp):
            opp = enrich_opportunity(opp, articles_by_id)
            valid_opps.append(opp)
        else:
            reason = "low_confidence" if opp.get("confidence", "").lower() == "low" else "invalid_fields"
            log.info(f"  Dropped [{reason}]: {opp.get('project_name','?')} (confidence={opp.get('confidence','?')})")

    log.info(f"Valid opportunities after filtering: {len(valid_opps)}")

    # Deduplicate similar opportunities
    valid_opps = deduplicate_opportunities(valid_opps)

    # Summary by sector
    by_sector = {}
    for opp in valid_opps:
        s = opp.get("sector", "Unknown")
        by_sector[s] = by_sector.get(s, 0) + 1
    for sector, count in sorted(by_sector.items()):
        log.info(f"  {sector:30s}: {count}")

    # Save output
    if not date_str:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = os.path.join(OUTPUT_DIR, f"opportunities_{date_str}.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(valid_opps, f, indent=2, ensure_ascii=False)

    log.info(f"Saved → {out_path}")
    return valid_opps


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="EPC Radar Groq Analyzer")
    parser.add_argument("--date",    type=str, default=None,
                        help="Date to analyze (YYYY-MM-DD), defaults to today")
    parser.add_argument("--input",   type=str, default=None,
                        help="Custom input articles JSON file")
    parser.add_argument("--verbose", action="store_true",
                        help="Print raw Groq response")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompt only, don't call Groq")
    args = parser.parse_args()

    run(
        input_file=args.input,
        date_str=args.date,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )