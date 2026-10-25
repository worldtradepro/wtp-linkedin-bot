#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — OpenRouter Analyzer
=============================
Reads articles_YYYY-MM-DD.json, sends articles in batched prompts
to OpenRouter, extracts structured EPC project opportunities with
strong emphasis on accurate geolocation (project site first, company
HQ as a labeled fallback).

Output: opportunities_YYYY-MM-DD.json

Usage:
    python openrouter_analyzer.py                        # analyze today's articles
    python openrouter_analyzer.py --date 2026-03-08      # specific date
    python openrouter_analyzer.py --dry-run              # print prompt, don't call API
    python openrouter_analyzer.py --input articles.json  # custom input file

Required env vars:
    OPENROUTER_API_KEY

Optional env vars:
    OUTPUT_DIR         (default: .)
    OPENROUTER_MODEL    (default: openai/gpt-4o-mini)
"""
from __future__ import annotations

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
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass

_load_env_file(os.path.join(os.path.dirname(__file__), ".env"))

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
import fieldsv2
log = logging.getLogger("analyzer")

# ── Config ────────────────────────────────────────────────────────────────────
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OUTPUT_DIR         = os.getenv("OUTPUT_DIR", ".")
OPENROUTER_MODEL   = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

# Fallback chain — tried in order if primary model fails
OPENROUTER_MODEL_FALLBACKS = [
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
    "anthropic/claude-3.5-haiku",
]

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

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
  - Data Centers
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
- Data centre projects (sector "Logistics & Infrastructure", subsector "Data Centers"): new campuses,
  expansions, financing, construction contracts, and their dedicated power supply. A power plant, grid
  connection, turbine or battery order made FOR a data centre keeps its own energy subsector.

Ignore:
- Pure financial results, earnings reports, dividend announcements
- Personnel changes, leadership appointments
- ESG/sustainability reports with no project content
- Pure geopolitical or conflict news with no identifiable project or procurement angle
- Articles with no identifiable project, asset, or procurement event
- Projects outside the taxonomy below: airports, hospitals, schools, universities, housing, hotels,
  stadiums, museums, roads, highways and bridges, drinking-water and sewage works, defence
- Historical events (FID already taken, project already built) UNLESS the article
  was published within the past 36 hours AND reports a genuinely new development.
  If the article is simply a republished or re-indexed old story, omit it.

GEOLOCATION — read this carefully, accuracy here matters more than anything else:
1. FIRST priority: identify the actual physical location of the project, asset, or
   procurement event (the country where the plant/mine/pipeline/port/construction site
   physically is, or — for a vessel/equipment order — the country where the vessel
   will operate or the equipment will be installed, if stated). Read the full title
   AND summary text carefully; do not skim only the first sentence.
2. If the physical project location is genuinely not stated anywhere in the article
   (common for equipment orders, corporate deals, MoUs, or moving assets like ships
   that have no fixed site), fall back to the headquarters country of the primary
   company named in the article (the buyer/operator, not a shipbuilder or law firm
   mentioned only in passing). Use your knowledge of well-known company headquarters.
   Set "location_source" to "company_hq" in this case.
3. Only use "Unknown" for country if NEITHER the project site NOR any identifiable
   company headquarters can be determined. Do not guess a country with low confidence
   just to avoid "Unknown" — a wrong country is worse than an honest "Unknown".
4. Never fabricate a location. If genuinely global/multi-country (e.g. OPEC+ policy,
   a multinational framework agreement spanning several countries), set country to
   "Global" and region to "Global", with location_source "global".

SUBSECTOR — read this carefully, this field is frequently left as "Unknown" when
the article actually gives enough to infer it; do not default to "Unknown" out of
laziness:
1. Pick the CLOSEST matching subsector from the taxonomy list under the chosen
   sector, based on any technology, facility type, equipment, or activity named
   anywhere in the title or body — not only if the subsector name itself appears
   verbatim. Examples: a battery/BESS project -> Renewables. An offshore field
   development, drilling, subsea, or upstream/midstream/downstream project ->
   Oil & Gas. An LNG storage, regasification, or import/export terminal -> LNG.
   A nuclear plant or SMR -> Power & Transmission. A grid, substation, or
   transmission-line project -> Power & Transmission. A refinery or
   petrochemical plant/expansion -> Refining & Petrochemicals. A desalination or
   water-treatment plant -> Water & Desalination.
2. Never output "EPC", "Infrastructure Development", "Energy Generation", or any
   other label describing the DEAL TYPE rather than the underlying technology --
   those describe every row in this dataset and carry no classifying information.
   Map to the closest real subsector instead.
3. Only output "Unknown" if the article genuinely never names or implies any
   specific technology, facility type, or equipment for the project -- the same
   bar as the country rule above: an honest "Unknown" beats a guessed label, but
   a real, inferable label beats a lazy "Unknown".
4. Exception to rule 1 (verbatim taxonomy label) for Energy > Renewables only:
   if the article names a specific renewable technology -- wind, solar,
   hydropower, geothermal, or battery/BESS storage -- use that word itself
   (e.g. "Wind", "Solar", "Battery Storage") instead of the generic
   "Renewables" label. Every map pin for this category was otherwise reading
   as an identical generic "renewable energy" dot regardless of which
   technology it actually was -- a wind farm and a solar farm are visibly
   different things and should say so. Fall back to plain "Renewables" only
   when the article doesn't name a specific one of these technologies.

DESCRIPTION RULE: write "description" in your own words from the facts, naming the company, the project and what happened. Do NOT reuse the article headline or any run of 5+ consecutive words from it. Leave any field empty when the text does not state it - never guess.

Return ONLY a valid JSON array. No markdown, no explanation, no preamble.
Each element must follow the exact schema provided.
If an article yields no valid opportunity, omit it entirely from the output.
"""

def build_prompt(articles: list[dict]) -> str:
    """Build the batched analysis prompt."""

    # Format articles for prompt — use the FULL summary field (fetcher already
    # captures up to BODY_CHARS of article body text; don't truncate further here)
    articles_text = ""
    for i, a in enumerate(articles, 1):
        summary = (a.get('summary') or '')
        articles_text += f"""
---ARTICLE {i}---
ID: {a['id']}
Source: {a['source_name']} ({a['source_category']}) [credibility: {a['credibility']}★]
Title: {a['title']}
Published: {a['published']}
Summary/Body excerpt: {summary}
URL: {a['url']}
"""

    schema = """
Output schema for each opportunity (JSON array):
[
  {
    "article_id":      "string — the ID field from the article",
    "project_name":    "string — concise project name, e.g. 'Ruwais LNG Expansion'",
    "country":         "string — country where project is located, ISO name, or 'Global'",
    "region":          "string — one of: Africa | Middle East | Europe | Asia Pacific | Americas | Global",
    "location_source": "string — one of: project | company_hq | global | unknown — how the country was determined",
    "company_name":    "string — primary company name used for company_hq fallback, empty if not applicable",
    "sector":          "string — top-level sector from taxonomy",
    "subsector":       "string — MUST be exactly one of the subsector options listed under that sector in the taxonomy below (copy the label verbatim, do not invent new labels or leave the sector's own name here)",
    "stage":           "string — one of: S1-Feasibility | S2-Development | S3-Pre-FID | S4-Tender | S5-Awarded",
    "scale":           "string — one of: Large (>$500M or >1GW) | Medium ($50-500M) | Small (<$50M) | Unknown",
    "description":     "string — one sentence max 120 chars, factual, no hype, own words (see DESCRIPTION RULE)",
    "owner":           "string — project owner / sponsor / developer; empty if not stated",
    "site":            "string — city, field, port or site inside the country; empty if not stated",
    "capacity":        "string — capacity with unit exactly as stated, e.g. '4.8 GWh'; empty if not stated",
    "contractors":     "array of {name, role}; [] if none",
    "financiers":      "array of names; [] if none",
    "reference_id":    "string — tender number / official project ID if stated; empty otherwise",
    "event_type":      "string — what THIS article reports, one of: Tender | Award | FID | Financing | Permit/Approval | Study/FEED | Construction start | Delivery/Commissioning | Acquisition/Sale | Renewal/Extension | Offtake/Supply agreement | Equipment/vessel order | Other (an MoU/agreement is not an Award; a vessel delivery is Delivery/Commissioning; a sale is Acquisition/Sale)",
    "key_dates":       "array of {label, date} as stated in the text; [] if none",
    "value_amount":    "string — number only, TOTAL deal/project value as stated; empty if not stated; NEVER a unit price (per MW, per tonne)",
    "value_unit":      "string — thousand | million | billion | unstated",
    "value_currency":  "string — ISO code (USD, EUR ...), empty if not stated",
    "value_basis":     "string — reported | estimated | unstated",
    "source_url":      "string — URL of the original article",
    "credibility":      "integer — credibility stars 1-5 from source",
    "confidence":       "string — one of: High | Medium | Low (your confidence this is a real project or procurement signal)"
  }
]
"""

    taxonomy_block = f"\nSector taxonomy to use:\n{SECTOR_TAXONOMY}\n"

    # OpenRouter models generally support much larger context windows than
    # the Groq free tier did — raise the ceiling accordingly.
    MAX_PROMPT_CHARS = 60_000  # ~30K tokens, safe for gpt-4o-mini / gemini-flash / claude-haiku

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


# ── OpenRouter call ───────────────────────────────────────────────────────────

def call_openrouter(prompt: str) -> str:
    """Call OpenRouter API. Returns raw response text."""
    if not OPENROUTER_API_KEY:
        raise RuntimeError("Missing OPENROUTER_API_KEY environment variable")

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://worldtradepro.com",
        "X-Title": "WTP EPC Radar",
    }
    primary = OPENROUTER_MODEL
    models_to_try = [primary] + [m for m in OPENROUTER_MODEL_FALLBACKS if m != primary]

    for model in models_to_try:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": int(os.getenv("ANALYZER_MAX_TOKENS", "8192")),
        }
        for attempt in range(2):  # 2 attempts per model
            try:
                log.info(f"Calling OpenRouter: {model} (attempt {attempt + 1})")
                r = requests.post(OPENROUTER_API_URL, headers=headers, json=payload, timeout=90)
                if r.status_code == 429:
                    wait = 15 * (attempt + 1)
                    log.warning(f"Rate limited on {model}, waiting {wait}s...")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"].strip()
            except Exception as e:
                log.warning(f"OpenRouter {model} attempt {attempt + 1} failed: {e}")
                if attempt < 1:
                    time.sleep(5)
        log.warning(f"Model {model} exhausted, trying next fallback...")

    raise RuntimeError("OpenRouter API failed — all models exhausted")


def parse_response(raw: str) -> list[dict]:
    """Parse OpenRouter JSON response, stripping markdown fences if present."""
    text = raw.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)
    text = text.strip()

    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
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

    valid_stages = {"S1-Feasibility", "S2-Development", "S3-Pre-FID",
                    "S4-Tender", "S5-Awarded"}
    if opp.get("stage") not in valid_stages:
        log.debug(f"Invalid stage '{opp.get('stage')}' for {opp.get('project_name')}")
        return False

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
    if not opp.get("location_source"):
        opp["location_source"] = "unknown"
    opp = normalize_sector(opp)
    opp = normalize_subsector(opp)
    opp["source_type"] = fieldsv2.derive_source_type(opp)
    opp = fieldsv2.guard_description(opp, article.get("title", ""))
    return opp


# ── Sector normalization ──────────────────────────────────────────────────────
# The model sometimes puts a SUBSECTOR value directly into the "sector" field
# (e.g. "LNG" or "Oil & Gas" as a top-level sector) instead of following the
# Energy > {Oil & Gas, LNG, Renewables, ...} hierarchy in SECTOR_TAXONOMY.
# This deterministically folds those leaked subsector values back under their
# correct top-level sector, so "sector" always contains one of the 4 real
# top-level buckets and "subsector" carries the detail.
TOP_LEVEL_SECTORS = {"Energy", "Mining & Metals", "Agriculture", "Logistics & Infrastructure"}

SUBSECTOR_TO_SECTOR = {
    "oil & gas": "Energy", "lng": "Energy", "refining & petrochemicals": "Energy",
    "renewables": "Energy", "hydrogen & ammonia": "Energy", "power & transmission": "Energy",
    "water & desalination": "Energy",
    "mine development": "Mining & Metals", "processing & smelting": "Mining & Metals",
    "critical minerals": "Mining & Metals",
    "fertilizer plants": "Agriculture", "grain & food infrastructure": "Agriculture",
    "irrigation & water": "Agriculture",
    "ports & terminals": "Logistics & Infrastructure", "pipelines & storage": "Logistics & Infrastructure",
    "rail & inland transport": "Logistics & Infrastructure", "shipyard & fleet": "Logistics & Infrastructure",
    "data centers": "Logistics & Infrastructure", "data centres": "Logistics & Infrastructure",
    "logistics": "Logistics & Infrastructure",
}


def normalize_sector(opp: dict) -> dict:
    sector = (opp.get("sector") or "").strip()
    if sector in TOP_LEVEL_SECTORS:
        return opp
    mapped = SUBSECTOR_TO_SECTOR.get(sector.lower())
    if mapped:
        if not opp.get("subsector"):
            opp["subsector"] = sector
        opp["sector"] = mapped
    return opp


# ── Subsector normalization ───────────────────────────────────────────────────
# Even with the strict-taxonomy prompt instruction above, the model still
# occasionally emits a close-but-not-listed label (e.g. "Nuclear", "Drilling",
# "Refinery Development") or a vague deal-type word that isn't a real
# technology classification at all ("EPC", "Infrastructure Development").
# Fold the former deterministically onto the real taxonomy entry; blank out
# the latter so it reads as "not stated" (same as a genuinely empty
# subsector) instead of masquerading as classification content.
SUBSECTOR_FOLD = {
    "nuclear": "Power & Transmission", "coal": "Power & Transmission",
    "coal power development": "Power & Transmission",
    "grid": "Power & Transmission", "transmission": "Power & Transmission",
    "substation": "Power & Transmission",
    "drilling": "Oil & Gas", "subsea": "Oil & Gas", "subsea systems": "Oil & Gas",
    "upstream": "Oil & Gas", "midstream": "Oil & Gas", "downstream": "Oil & Gas",
    "refinery development": "Refining & Petrochemicals", "refining": "Refining & Petrochemicals",
    "petrochemicals": "Refining & Petrochemicals",
    "lng infrastructure": "LNG", "regasification": "LNG", "liquefaction": "LNG",
    "desalination": "Water & Desalination", "water": "Water & Desalination",
    # wind/solar/hydropower/geothermal/battery are deliberately NOT folded to
    # "Renewables" here (2026-09-06) - that used to be the point (collapse
    # near-duplicate labels), but for these specific technologies it was
    # throwing away real distinctions the map wants to show (a wind farm and
    # a solar farm are visibly different, unlike "Refining"/"Refinery
    # Development" which really are the same thing worded two ways). The
    # prompt now asks the model for these specific labels directly; see the
    # SUBSECTOR rule 4 exception above.
    "hydrogen": "Hydrogen & Ammonia", "ammonia": "Hydrogen & Ammonia",
}

VAGUE_SUBSECTORS = {"epc", "infrastructure development", "energy generation", "unknown"}


def normalize_subsector(opp: dict) -> dict:
    sub = (opp.get("subsector") or "").strip()
    if not sub:
        return opp
    key = sub.lower()
    if key in VAGUE_SUBSECTORS:
        opp["subsector"] = ""
        return opp
    folded = SUBSECTOR_FOLD.get(key)
    if folded:
        opp["subsector"] = folded
    return opp


# ── Deduplication ─────────────────────────────────────────────────────────────

def _normalize_name(name: str) -> str:
    """Normalize project name for fuzzy matching.
    Strips common suffixes, lowercases, removes punctuation."""
    import re as _re
    name = name.lower().strip()
    for suffix in ["project", "expansion", "development", "contract",
                   "plant", "facility", "terminal", "mine", "farm",
                   "construction", "works", "program", "programme"]:
        name = _re.sub(r'\s+' + suffix + r'$', '', name)
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

            best = max(cluster, key=lambda o: (
                o.get("credibility", 0),
                len(o.get("description", "")),
            ))

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
        "data center", "data centre", "hyperscale",
    ]

    def has_strong_signal(article):
        title = (article.get("title") or "").lower()
        summary = (article.get("summary") or "").lower()
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

    articles_by_id = {a["id"]: a for a in articles}

    # ── Batch processing: larger batches now that context budget is bigger ───
    BATCH_SIZE = int(os.getenv("ANALYZER_BATCH", "25"))   # Haiku 5.5 thinks before answering: 8 per batch keeps the answer inside the output limit
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
            raw = call_openrouter(prompt)
            log.info(f"Batch {batch_num} response: {len(raw)} chars")
            if verbose:
                print(f"\n── RAW OPENROUTER RESPONSE (batch {batch_num}) ────────────────────")
                print(raw)
                print("─────────────────────────────────────────────────────────\n")
            batch_opps = parse_response(raw)
            log.info(f"Batch {batch_num}: parsed {len(batch_opps)} opportunities")
            all_raw_opps.extend(batch_opps)
        except Exception as e:
            log.error(f"Batch {batch_num} failed: {e} — skipping")
            continue

        # Short courtesy pause between batches (OpenRouter has no ~6K tok/min
        # free-tier throttle like Groq did, but stay polite to provider limits)
        if batch_num < len(batches):
            time.sleep(5)

    if dry_run:
        return []

    log.info(f"Total raw opportunities across all batches: {len(all_raw_opps)}")

    opportunities = all_raw_opps
    log.info(f"Parsed {len(opportunities)} opportunities from OpenRouter")

    valid_opps = []
    for opp in opportunities:
        if validate_opportunity(opp):
            opp = enrich_opportunity(opp, articles_by_id)
            valid_opps.append(opp)
        else:
            reason = "low_confidence" if opp.get("confidence", "").lower() == "low" else "invalid_fields"
            log.info(f"  Dropped [{reason}]: {opp.get('project_name','?')} (confidence={opp.get('confidence','?')})")

    log.info(f"Valid opportunities after filtering: {len(valid_opps)}")

    valid_opps = deduplicate_opportunities(valid_opps)

    by_sector = {}
    by_location_source = {}
    for opp in valid_opps:
        s = opp.get("sector", "Unknown")
        by_sector[s] = by_sector.get(s, 0) + 1
        ls = opp.get("location_source", "unknown")
        by_location_source[ls] = by_location_source.get(ls, 0) + 1
    for sector, count in sorted(by_sector.items()):
        log.info(f"  {sector:30s}: {count}")
    log.info("Location source breakdown:")
    for ls, count in sorted(by_location_source.items()):
        log.info(f"  {ls:15s}: {count}")

    if not date_str:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = os.path.join(OUTPUT_DIR, f"opportunities_{date_str}.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(valid_opps, f, indent=2, ensure_ascii=False)

    log.info(f"Saved → {out_path}")
    return valid_opps


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="EPC Radar OpenRouter Analyzer")
    parser.add_argument("--date",    type=str, default=None,
                        help="Date to analyze (YYYY-MM-DD), defaults to today")
    parser.add_argument("--input",   type=str, default=None,
                        help="Custom input articles JSON file")
    parser.add_argument("--verbose", action="store_true",
                        help="Print raw OpenRouter response")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompt only, don't call OpenRouter")
    args = parser.parse_args()

    run(
        input_file=args.input,
        date_str=args.date,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )
