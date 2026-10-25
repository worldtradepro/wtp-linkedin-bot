#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — World Bank procurement notices source
==================================================
Pulls World Bank-financed goods/works tenders and contract awards from the
official procurement-notices API, keeps only commodity-related EPC work
(energy, mining, agriculture, commodity logistics) and converts each notice to
the same opportunity schema the analyzer produces.

Official structured data, so no LLM step: stage, country, winner, winner
country and signed contract value come straight from the notice.

Usage:
    python wb_procurement.py                      # today, print summary
    python wb_procurement.py --date 2026-09-25    # notices published that day
    python wb_procurement.py --days 30 --dry-run  # backtest window, no files written

Pipeline use (run_pipeline.py, after the analyzer):
    import wb_procurement; wb_procurement.merge_into_opportunities(date_str, DATA_DIR)
"""

import argparse
import html
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger("wb_procurement")

API_URL = "https://search.worldbank.org/api/v2/procnotices"
FX_URL = "https://open.er-api.com/v6/latest/USD"
NOTICE_URL = "https://projects.worldbank.org/en/projects-operations/procurement-detail/{id}"

GROUPS = ("GO", "CW")  # goods, civil works (consulting/non-consulting services are not EPC)
NOTICE_TYPES = {
    "Invitation for Bids": "S4-Tender",
    "Invitation for Prequalification": "S4-Tender",
    "Contract Award": "S5-Awarded",
}
# RFQ = shopping for small purchases, Direct Selection = no competition: neither is a lead
OPEN_METHODS = {"RFB", "RFP"}
MIN_AWARD_USD = float(os.environ.get("WB_MIN_AWARD_USD", 1_000_000))

# (sector, subsector, pattern) — first match wins, so specific before generic.
# Matched against contract title + scope of contract (see classify()).
RULES = [
    # Irrigation before renewables: a solar-pumped irrigation scheme is an irrigation job.
    ("Agriculture", "Irrigation & Water", r"irrigat|aménagements? hydro-?agricoles?|périmètres? irrigués?|riego|irriga[çc]"),
    ("Energy", "LNG", r"\bLNG\b|liquefied natural gas"),
    ("Energy", "Refining & Petrochemicals", r"refiner(y|ies)|petrochemical|raffinerie"),
    ("Energy", "Oil & Gas", r"\b(oil|gas) (field|well|processing|compressor)|gas turbine|\bLPG\b|upstream"),
    ("Logistics & Infrastructure", "Pipelines & Storage", r"(gas|oil|fuel|petroleum) pipeline|storage tanks?|fuel depot|gazoduc|oléoduc"),
    ("Energy", "Hydrogen & Ammonia", r"hydrogen|electroly[sz]er|green ammonia"),
    ("Energy", "Renewables", r"solar|photovoltaic|\bPV\b|wind (farm|turbine|power)|hydro ?power|hydroelectric|geothermal|"
                             r"battery energy storage|\bBESS\b|mini-?grids?|solaire|éolien|hydroélectrique|energ[ií]a solar|fotovoltaic|e[óo]lic"),
    ("Energy", "Power & Transmission", r"power (plant|station)|sub-?stations?|transmission line|\d+\s?kV\b|high voltage|transformers?|switchgear|"
                                       r"interconnect|electrification|distribution (network|line)s?|thermal power|poste source|postes? de transformation|"
                                       r"ligne (de transport|haute tension|HTA|HTB)|MT/BT|moyenne tension|postes? de distribution|"
                                       r"subesta[çc]|linha de transmiss|centrale (thermique|électrique)|subestaci|l[ií]nea de transmisi"),
    ("Energy", "Water & Desalination", r"desalinat|dessalement|desalaci"),
    ("Mining & Metals", "Processing & Smelting", r"smelter|refinery of (copper|gold)|concentrator|beneficiation"),
    ("Mining & Metals", "Critical Minerals", r"lithium|cobalt|rare earth|graphite|critical mineral"),
    ("Mining & Metals", "Mine Development", r"\bmine\b|mining|tailings|minier|miner[ií]a"),
    ("Agriculture", "Fertilizer Plants", r"fertili[sz]er|urea plant|phosphate plant|engrais"),
    ("Agriculture", "Grain & Food Infrastructure", r"silos?\b|grain (storage|warehouse|terminal)|cold (storage|chain)|agro-?processing|rice mill|"
                                                   r"milling plant|abattoir|slaughter|food processing|entrepôts? de stockage|magasins? de stockage"),
    # Dams last, so hydropower dams stay under Renewables
    ("Agriculture", "Irrigation & Water", r"\bdams?\b|barrage|represa"),
    ("Logistics & Infrastructure", "Ports & Terminals", r"\bport (expansion|terminal|infrastructure|development)|seaport|harbou?r|jetty|berths?\b|quay|"
                                                        r"container terminal|dry port|land port|terminal portuaire|infrastructures? portuaires?|muelle|\bpuerto\b|"
                                                        r"\bporto do\b|terminal portu|ber[çc]o de atraca"),
    ("Logistics & Infrastructure", "Rail & Inland Transport", r"railway|rail (line|track)|\brailways?\b|ferrocarril|chemin de fer|ferroviaire|inland waterway"),
]
RULES = [(s, sub, re.compile(p, re.I)) for s, sub, p in RULES]

# Titles that are clearly not commodity EPC even when a rule keyword appears
# ("solar lighting for schools", "pipeline" for drinking water, the Haitian capital
# matching "port", ...).
EXCLUDE = re.compile(
    r"school|[ée]coles?\b|classroom|hospital|health (post|cent)|clinic|laptop|computer|\bICT\b|routers?|network switch|"
    r"furniture|vehicle|pick ?-?ups?\b|motorcycle|tractors?|office|bureaux|headquarters|siège|toilet|latrine|sanitation|"
    r"assainissement|stationery|canteen|cantine|medical|drinking water|potable|water (supply|points?)|adduction d.eau|"
    r"agua potable|sewer|drain|street ?light|éclairage public|housing|market stalls?|livestock markets?|shelter|"
    r"surveying|tools and materials|kits?\b|fingerlings|resettlement|demining|passenger terminal|security system|"
    r"asset performance|software|draisine|"
    # water utilities and health facilities (2026-09-30: "Water Transmission Lines" read as power, Severn Trent groundworks as mining)
    r"waste ?water|water transmission|water mains?|trenchless|groundworks|health complex|upazila health",
    re.I)

# World Bank country names -> the map's five regions. Unlisted names (regional
# programs such as "Western and Central Africa") fall back to WB_REGION_HINTS.
REGION_BY_COUNTRY = {}
CANON = {}  # lowercase -> name as written
for _region, _names in {
    "Africa": "Algeria|Angola|Benin|Botswana|Burkina Faso|Burundi|Cabo Verde|Cameroon|Central African Republic|Chad|Comoros|"
              "Congo, Democratic Republic of|Congo, Republic of|Cote d'Ivoire|Côte d'Ivoire|Djibouti|Egypt, Arab Republic of|"
              "Equatorial Guinea|Eritrea|Eswatini|Ethiopia|Gabon|Gambia, The|Ghana|Guinea|Guinea-Bissau|Kenya|Lesotho|Liberia|"
              "Libya|Madagascar|Malawi|Mali|Mauritania|Mauritius|Morocco|Mozambique|Namibia|Niger|Nigeria|Rwanda|"
              "Sao Tome and Principe|Senegal|Seychelles|Sierra Leone|Somalia|South Africa|South Sudan|Sudan|Tanzania|Togo|"
              "Tunisia|Uganda|Zambia|Zimbabwe",
    "Middle East": "Bahrain|Iran, Islamic Republic of|Iraq|Jordan|Kuwait|Lebanon|Oman|Qatar|Saudi Arabia|Syrian Arab Republic|"
                   "United Arab Emirates|West Bank and Gaza|Yemen, Republic of",
    "Europe": "Albania|Armenia|Azerbaijan|Belarus|Bosnia and Herzegovina|Bulgaria|Croatia|Georgia|Kosovo|Moldova|Montenegro|"
              "North Macedonia|Poland|Romania|Serbia|Turkiye|Türkiye|Ukraine|Greece|Hungary",
    "Asia Pacific": "Afghanistan|Bangladesh|Bhutan|Cambodia|China|Fiji|India|Indonesia|Kazakhstan|Kiribati|Kyrgyz Republic|"
                    "Lao People's Democratic Republic|Malaysia|Maldives|Marshall Islands|Micronesia, Federated States of|Mongolia|"
                    "Myanmar|Nauru|Nepal|Pakistan|Palau|Papua New Guinea|Philippines|Samoa|Solomon Islands|Sri Lanka|Tajikistan|"
                    "Thailand|Timor-Leste|Tonga|Turkmenistan|Tuvalu|Uzbekistan|Vanuatu|Vietnam|Viet Nam",
    "Americas": "Argentina|Belize|Bolivia|Brazil|Chile|Colombia|Costa Rica|Dominica|Dominican Republic|Ecuador|El Salvador|"
                "Grenada|Guatemala|Guyana|Haiti|Honduras|Jamaica|Mexico|Nicaragua|Panama|Paraguay|Peru|Saint Lucia|"
                "St. Lucia|St. Vincent and the Grenadines|Suriname|Uruguay",
}.items():
    for _n in _names.split("|"):
        REGION_BY_COUNTRY[_n.strip().lower()] = _region
        CANON[_n.strip().lower()] = _n.strip()

WB_REGION_HINTS = [
    ("Africa", r"africa"), ("Middle East", r"middle east|north africa"), ("Europe", r"europe"),
    ("Asia Pacific", r"asia|pacific"), ("Americas", r"america|caribbean"),
]

# WB long-form names -> the short names the rest of the site uses
COUNTRY_CLEAN = {
    "Egypt, Arab Republic of": "Egypt", "Congo, Democratic Republic of": "DR Congo", "Congo, Republic of": "Congo",
    "Gambia, The": "Gambia", "Iran, Islamic Republic of": "Iran", "Yemen, Republic of": "Yemen",
    "Lao People's Democratic Republic": "Laos", "Kyrgyz Republic": "Kyrgyzstan", "Syrian Arab Republic": "Syria",
    "Micronesia, Federated States of": "Micronesia", "Viet Nam": "Vietnam", "Turkiye": "Türkiye",
    "Cote d'Ivoire": "Côte d'Ivoire",
}

# Names that can follow "Country:" in award notices (borrower countries plus the
# usual bidder home countries). Longest first so the longest name matches.
for _n in ["China", "India", "Korea, Republic of", "Korea", "Japan", "Spain", "France", "Italy", "Germany", "Portugal",
           "United States", "United Kingdom", "Canada", "Brazil", "Netherlands", "Belgium", "Austria", "Switzerland",
           "Sweden", "Norway", "Denmark", "Finland", "Czech Republic", "Czechia", "Israel", "Singapore",
           "Russian Federation", "Australia", "New Zealand", "Hong Kong", "Taiwan", "Somalia, Federal Republic of"]:
    CANON.setdefault(_n.lower(), _n)
# Spellings seen in notices (local languages, accents lost in the feed) -> canonical
ALIASES = {"brasil": "Brazil", "turkey": "Türkiye", "turkiye": "Türkiye", "türkiye": "Türkiye", "maurice": "Mauritius",
           "hati": "Haiti", "haïti": "Haiti", "rpublique centrafricaine": "Central African Republic",
           "république centrafricaine": "Central African Republic", "somalia, federal republic of": "Somalia"}
BIDDER_COUNTRIES = sorted(set(CANON.values()) | set(COUNTRY_CLEAN) | set(ALIASES), key=len, reverse=True)
BIDDER_COUNTRY_RX = re.compile(r"Country:\s*(" + "|".join(re.escape(c) for c in BIDDER_COUNTRIES) + r")\b", re.I)


def canonical_country(name: str) -> str:
    """Any spelling from a notice -> the short name the site uses."""
    low = name.strip().lower()
    if low in ALIASES:
        return ALIASES[low]
    written = CANON.get(low, name.strip())
    return COUNTRY_CLEAN.get(written, written)


def _text(notice_html: str) -> str:
    t = re.sub(r"<[^>]+>", " ", notice_html or "")
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def _region(country: str) -> str:
    r = REGION_BY_COUNTRY.get(country.lower())
    if r:
        return r
    for region, pat in WB_REGION_HINTS:
        if re.search(pat, country, re.I):
            return region
    return "Global"


def _scale(usd):
    if usd is None:
        return "Unknown"
    if usd >= 500e6:
        return "Large"
    if usd >= 50e6:
        return "Medium"
    return "Small"


def _money(usd):
    return f"US${usd / 1e6:,.1f}M" if usd >= 1e6 else f"US${usd / 1e3:,.0f}k"


def load_fx() -> dict:
    try:
        return requests.get(FX_URL, timeout=30).json().get("rates", {})
    except Exception as e:
        log.warning(f"FX rates unavailable ({e}); award values will be skipped")
        return {}


def parse_award(text: str, fx: dict):
    """Winner name, winner country and signed contract value (USD) from an award notice."""
    winner = winner_country = None
    m = re.search(r"Awarded Bidder\(s\):\s*(.+?)(?:Bid Price|Evaluated Bid|Signed Contract|Evaluation Scores|$)", text)
    if m:
        # One entry per bidder: "NAME (supplier id) address Country: X", repeated for JVs.
        section, names, countries, pos = m.group(1), [], [], 0
        for cm in BIDDER_COUNTRY_RX.finditer(section):
            entry = section[pos:cm.start()]
            im = re.search(r"^(.*?)\s*\(\d{3,}\)", entry.strip())
            if im and im.group(1).strip(" ,;"):
                names.append(im.group(1).strip(" ,;"))
            c = canonical_country(cm.group(1))
            if c not in countries:
                countries.append(c)
            pos = cm.end()
        if names:
            winner = " / ".join(names)[:150]
        if countries:
            winner_country = " / ".join(countries)
    usd = None
    m = re.search(r"Signed Contract price\s+([A-Z]{3})\s*([\d,]+(?:\.\d+)?)", text)
    if m and fx.get(m.group(1)):
        usd = float(m.group(2).replace(",", "")) / fx[m.group(1)]
    return winner, winner_country, usd


def classify(notice: dict, text: str):
    title = notice.get("bid_description") or ""
    if EXCLUDE.search(title):
        return None
    m = re.search(r"Scope of Contract:\s*(.{0,500})", text)
    # Tenders have no scope field, and their letterhead ("Ministère ... des Ressources
    # Minières") would misclassify them, so a tender is judged on its title alone.
    scope = m.group(1) if m else ""
    # The project name is deliberately left out: an "irrigation" or "energy" program
    # also buys routers and pick-ups, and only the contract itself says what is bought.
    hay = f"{title} | {scope}"
    for sector, sub, rx in RULES:
        if rx.search(hay):
            return sector, sub
    return None


def fetch_notices(since: str, until: str) -> list:
    """All goods/works notices with submission_date in [since, until] (YYYY-MM-DD)."""
    out = []
    for grp in GROUPS:
        offset = 0
        while True:
            r = requests.get(API_URL, params={
                "format": "json", "rows": 500, "os": offset, "srt": "submission_date", "order": "desc",
                "procurement_group_exact": grp,
            }, timeout=60)
            r.raise_for_status()
            batch = r.json().get("procnotices") or []
            for n in batch:
                d = (n.get("submission_date") or "")[:10]
                if since <= d <= until:
                    out.append(n)
            if not batch or (batch[-1].get("submission_date") or "")[:10] < since or offset > 20000:
                break
            offset += 500
    return out


def to_opportunity(n: dict, fx: dict):
    ntype = n.get("notice_type")
    if ntype not in NOTICE_TYPES or n.get("procurement_method_code") not in OPEN_METHODS:
        return None
    text = _text(n.get("notice_text"))
    cls = classify(n, text)
    if not cls:
        return None
    sector, subsector = cls
    stage = NOTICE_TYPES[ntype]
    raw_country = (n.get("project_ctry_name") or "").strip()
    title = re.sub(r"\s+", " ", n.get("bid_description") or "").strip()
    region = _region(raw_country)
    if raw_country.lower() in REGION_BY_COUNTRY:
        country, location_source = canonical_country(raw_country), "project"
    else:
        # Regional program ("Eastern and Southern Africa"): the country is usually
        # in the tender's own "Country:" line or its title.
        country, location_source = "", "unknown"
        m = re.search(r"Country:\s*([^:]{2,40}?)\s+(?:Name of Project|Project|Contract Title|Loan)", text)
        cands = [m.group(1)] if m else []
        cands.append(title)
        for cand in cands:
            hit = next((c for c in REGION_BY_COUNTRY if re.search(r"\b" + re.escape(c) + r"\b", cand, re.I)), None)
            if hit:
                country, location_source, region = canonical_country(hit), "project", REGION_BY_COUNTRY[hit]
                break

    winner = winner_country = usd = award_date = None
    if stage == "S5-Awarded":
        m = re.search(r"Notification of Award Issued \(YYYY/MM/DD\)\s*(\d{4})/(\d{2})/(\d{2})", text)
        award_date = "-".join(m.groups()) if m else None
        winner, winner_country, usd = parse_award(text, fx)
        if usd is None or usd < MIN_AWARD_USD:
            return None
        desc = f"World Bank-financed contract {_money(usd)} awarded to {winner or 'n/a'}" + \
               (f" ({winner_country})" if winner_country else "") + f": {title}"
    else:
        what = "prequalification" if "Prequalification" in ntype else "open tender"
        desc = f"World Bank-financed {what} ({n.get('project_name', '').strip()}): {title}"

    return {
        "article_id": f"wb-{n['id']}",
        "project_name": title[:255],
        "country": country,
        "region": region,
        "city": "",
        "lat": None,
        "lng": None,
        "location_source": location_source,
        "company_name": (winner or "")[:150],
        "sector": sector,
        "subsector": subsector,
        "stage": stage,
        "scale": _scale(usd),
        "description": desc[:255],
        "source_url": NOTICE_URL.format(id=n["id"]),
        "source_name": "World Bank Procurement",
        "credibility": 5,
        "confidence": "High",
        # Extra fields: ignored by the current ingest endpoint, kept in the JSON
        # for the China-sourcing view (who wins, from where, for how much).
        "contract_value_usd": round(usd) if usd else None,
        "winner_country": winner_country,
        "wb_project_id": n.get("project_id"),
        "notice_date": (n.get("submission_date") or "")[:10],
        "award_date": award_date,
    }


def collect(since: str, until: str) -> list:
    fx = load_fx()
    notices = fetch_notices(since, until)
    opps = [o for o in (to_opportunity(n, fx) for n in notices) if o]
    log.info(f"World Bank: {len(notices)} goods/works notices {since}..{until} -> {len(opps)} commodity EPC items")
    return opps


def merge_into_opportunities(date_str: str, data_dir: str, lookback_days: int = 1) -> int:
    """Append the day's World Bank items to opportunities_<date>.json (idempotent).

    Notices dated the previous `lookback_days` days are included too, because the
    API indexes some notices a day late; the site's dedupe collapses repeats.
    """
    until = date_str
    since = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    items = collect(since, until)
    from title_translate import translate  # lazy: title_translate reaches the analyzer
    items = translate(items, data_dir)
    return merge_items(date_str, data_dir, "wb-", items)


def merge_items(date_str: str, data_dir: str, prefix: str, items: list) -> int:
    """Replace this source's items (article_id starting with `prefix`) in
    opportunities_<date>.json, keeping everything else. Safe to re-run."""
    path = os.path.join(data_dir, f"opportunities_{date_str}.json")
    existing = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = json.load(f) or []
    kept = [o for o in existing if not str(o.get("article_id", "")).startswith(prefix)]
    seen = set()
    for o in items:
        if o["article_id"] not in seen:
            kept.append(o)
            seen.add(o["article_id"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False, indent=2)
    return len(seen)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    ap = argparse.ArgumentParser(description="World Bank procurement -> EPC opportunities")
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--days", type=int, default=1, help="window size ending at --date")
    ap.add_argument("--dry-run", action="store_true", help="print only, write nothing")
    ap.add_argument("--out", default=None, help="write items to this JSON file")
    args = ap.parse_args()

    since = (datetime.strptime(args.date, "%Y-%m-%d") - timedelta(days=args.days - 1)).strftime("%Y-%m-%d")
    opps = collect(since, args.date)
    for o in sorted(opps, key=lambda o: (o["stage"], -(o["contract_value_usd"] or 0))):
        val = _money(o["contract_value_usd"]) if o["contract_value_usd"] else "-"
        print(f"{o['notice_date']} {o['stage'][:2]} {o['sector'][:10]:10} {o['subsector'][:22]:22} {o['country'][:16]:16} "
              f"{val:>10} {(o['winner_country'] or ''):12} {o['project_name'][:70]}")
    if args.out and not args.dry_run:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(opps, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
