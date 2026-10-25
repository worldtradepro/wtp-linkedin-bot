#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — European official procurement sources
==================================================
  * EU  : TED (Tenders Electronic Daily) search API v3, anonymous
  * UK  : Find a Tender (FTS) OCDS release API, anonymous

Both use CPV codes, so classification is by code rather than keywords: only
commodity-related EPC (power, renewables, oil & gas, pipelines, mining plant,
ports, freight rail, ships) is kept; buildings, water/sewage, roads, street
lighting and IT never enter. Output uses the same opportunity schema as the
analyzer and wb_procurement.

Usage:
    python europe_procurement.py --date 2026-09-24             # one day, print
    python europe_procurement.py --date 2026-09-24 --days 7    # backtest window
    python europe_procurement.py --source ted|fts ...          # one source only

Pipeline use (run_pipeline.py step_official_sources):
    europe_procurement.merge_into_opportunities(date_str, DATA_DIR)
"""

import argparse
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import requests

from title_translate import translate
from wb_procurement import EXCLUDE, _money, _scale, load_fx, merge_items

log = logging.getLogger("europe_procurement")

TED_URL = "https://api.ted.europa.eu/v3/notices/search"
TED_NOTICE_URL = "https://ted.europa.eu/en/notice/-/detail/{id}"
FTS_URL = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages"
FTS_NOTICE_URL = "https://www.find-tender.service.gov.uk/Notice/{id}"

# Europe publishes far more small contracts than the World Bank, so the bar is
# higher; rail is mostly passenger-network upkeep here, so only big rail counts.
MIN_VALUE_USD = 20_000_000
MIN_VALUE_BY_SUB = {"Rail & Inland Transport": 50_000_000}

E, M, A, L = "Energy", "Mining & Metals", "Agriculture", "Logistics & Infrastructure"
# CPV prefix -> (sector, subsector, strong). Longest prefix wins.
# strong = the code alone proves a large commodity asset (a power plant, a refinery,
# a harbour), so a tender is kept even when the buyer publishes no value.
CPV_MAP = {
    "09331": (E, "Renewables", False),            # solar panels
    "09332": (E, "Renewables", False),            # solar installation
    "31712331": (E, "Renewables", False),         # photovoltaic cells
    "3144": (E, "Renewables", False),             # batteries (storage)
    "3112": (E, "Power & Transmission", False),   # generators
    "3117": (E, "Power & Transmission", False),   # transformers
    "312": (E, "Power & Transmission", False),    # switchgear, distribution & control apparatus
    "3132": (E, "Power & Transmission", False),   # power distribution cables
    "42112": (E, "Power & Transmission", True),   # turbine installations
    "4216": (E, "Power & Transmission", False),   # boiler installations
    "452511": (E, "Power & Transmission", True),  # power plants
    "45251120": (E, "Renewables", True),          # hydro-electric plant
    "45251141": (E, "Renewables", True),          # geothermal plant
    "45251160": (E, "Renewables", True),          # wind-power installation
    "452512": (E, "Power & Transmission", True),  # heating plants / CHP
    "452314": (E, "Power & Transmission", False), # power lines
    "452322": (E, "Power & Transmission", False), # substations, overhead lines
    "45253": (E, "Refining & Petrochemicals", True),  # chemical processing plant
    "45255": (E, "Oil & Gas", True),              # oil & gas industry works
    "452552": (E, "Refining & Petrochemicals", True),  # refinery
    "45255210": (L, "Pipelines & Storage", True), # oil terminal
    "452553": (E, "LNG", True),                   # gas terminal
    "76": (E, "Oil & Gas", True),                 # oil & gas services (drilling, pipeline inspection)
    "452311": (L, "Pipelines & Storage", False),  # pipeline construction
    "452312": (L, "Pipelines & Storage", True),   # oil & gas pipelines
    "4416110": (L, "Pipelines & Storage", False), # gas pipelines
    "4416140": (L, "Pipelines & Storage", False), # underwater pipelines
    "44611": (L, "Pipelines & Storage", False),   # tanks
    "431": (M, "Mine Development", True),         # mining equipment
    "452541": (M, "Mine Development", True),      # mining plant
    "4341": (M, "Processing & Smelting", False),   # mineral-processing machinery
    "437": (M, "Processing & Smelting", False),   # metallurgy machinery
    "45247": (A, "Irrigation & Water", False),    # dams, canals, irrigation channels
    "45241": (L, "Ports & Terminals", True),      # harbour works
    "45244": (L, "Ports & Terminals", False),     # marine construction
    "452341": (L, "Rail & Inland Transport", False),  # railway construction
    "3461": (L, "Rail & Inland Transport", False),    # locomotives
    "34621": (L, "Rail & Inland Transport", False),   # freight wagons
    "34632": (L, "Rail & Inland Transport", False),   # railway traffic-control equipment
    "45213320": (L, "Rail & Inland Transport", False),  # railway buildings (stations, depots)
    "3451": (L, "Shipyard & Fleet", True),           # ships
}
# Prefixes that disqualify a notice when they are its MAIN code, even if a
# secondary code maps above (a housing project that also lists "geothermal").
CPV_EXCLUDE = ("4521", "452313", "452321", "452324", "45252", "45233", "4531", "45316", "3152", "4523412", "34622",
               "45255110", "48", "72", "79", "85", "90")
# Catch-all main codes ("construction work"): accepted only when a secondary code
# is a strong one, e.g. main 45000000 + 45251100 power plant.
GENERIC_MAIN = ("45000000", "45100000", "45200000", "45220000", "45223000", "45300000", "45400000", "71000000")

# Title noise the CPV code cannot see (street lighting is filed as power lines)
EXCLUDE_EU = re.compile(r"corrigend|medizin|wasserleitung|water pipe|pipeline notice|spare parts|ersatzteil|pièces de rechange|części (rezerwowe|zamienne)|"
                        r"charging station|ladestation|borne de recharge|dobíjecí|street ?light|beleuchtung|éclairage|illuminazione|oświetleni|alumbrado|verlichting|apgaismojum|"
                        r"osvětlení|osvetlen|világítás|iluminat|valaistu|belysning|housing|logements|wohnungen", re.I)

ISO3 = {
    "AUT": "Austria", "BEL": "Belgium", "BGR": "Bulgaria", "HRV": "Croatia", "CYP": "Cyprus", "CZE": "Czechia",
    "DNK": "Denmark", "EST": "Estonia", "FIN": "Finland", "FRA": "France", "DEU": "Germany", "GRC": "Greece",
    "HUN": "Hungary", "IRL": "Ireland", "ITA": "Italy", "LVA": "Latvia", "LTU": "Lithuania", "LUX": "Luxembourg",
    "MLT": "Malta", "NLD": "Netherlands", "POL": "Poland", "PRT": "Portugal", "ROU": "Romania", "SVK": "Slovakia",
    "SVN": "Slovenia", "ESP": "Spain", "SWE": "Sweden", "NOR": "Norway", "ISL": "Iceland", "LIE": "Liechtenstein",
    "CHE": "Switzerland", "GBR": "United Kingdom", "SRB": "Serbia", "MNE": "Montenegro", "MKD": "North Macedonia",
    "ALB": "Albania", "BIH": "Bosnia and Herzegovina", "UKR": "Ukraine", "MDA": "Moldova", "GEO": "Georgia",
    "TUR": "Türkiye", "CHN": "China", "KOR": "Korea", "JPN": "Japan", "USA": "United States", "CAN": "Canada",
    "IND": "India", "ISR": "Israel", "ARE": "United Arab Emirates", "SGP": "Singapore", "AUS": "Australia",
    "EGY": "Egypt", "MAR": "Morocco", "BRA": "Brazil", "ZAF": "South Africa",
}
EUROPE = {n for c, n in ISO3.items() if c not in {"TUR", "CHN", "KOR", "JPN", "USA", "CAN", "IND", "ISR", "ARE",
                                                   "SGP", "AUS", "EGY", "MAR", "BRA", "ZAF"}} | {"Türkiye"}


def cpv_class(codes):
    """(sector, subsector, strong) from a notice's CPV list (main code first), or None."""
    codes = [str(c).strip() for c in codes if c]
    if not codes or codes[0].startswith(CPV_EXCLUDE):
        return None

    def lookup(code):
        best = max((p for p in CPV_MAP if code.startswith(p)), key=len, default=None)
        return CPV_MAP[best] if best else None

    main = lookup(codes[0])
    if main:
        return main
    if codes[0] in GENERIC_MAIN:
        # Needs one strong secondary to qualify; the label is the most listed
        # subsector (Rail Baltica lists many rail codes and one pipeline code).
        hits = [c for c in map(lookup, codes[1:]) if c]
        if not any(c[2] for c in hits):
            return None
        return max(hits, key=lambda c: sum(h[1] == c[1] for h in hits))
    return None  # main code is something else (bridge, workshop kit, ...)


def _country(code):
    return ISO3.get(code, code) if code else ""


def _region(country):
    return "Europe" if country in EUROPE else "Global"


def _usd(amount, cur, fx):
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return None
    if not amount or not cur or not fx.get(cur):
        return None
    return amount / fx[cur]


def _keep(stage, sub, strong, usd):
    if usd is not None:
        # Framework "pipeline" notices sum a whole council's spend: not one project
        return MIN_VALUE_BY_SUB.get(sub, MIN_VALUE_USD) <= usd < 20e9
    return strong and stage != "S5-Awarded"  # an award without a value is not worth a pin


SOURCE_NAMES = {"EU": "EU TED", "UK": "UK Find a Tender"}


def _opp(src, nid, url, title, country, sector, sub, stage, usd, buyer, winners, winner_countries, deadline, award_date, date):
    if stage == "S5-Awarded":
        who = " / ".join(winners)[:150] or "n/a"
        wc = " / ".join(winner_countries)
        desc = f"{src} contract {_money(usd)} awarded to {who}" + (f" ({wc})" if wc else "") + f" by {buyer}: {title}"
    else:
        kind = {"S3-Pre-FID": "planned procurement", "S4-Tender": "open tender"}[stage]
        extra = [f"est. {_money(usd)}" if usd else "", f"deadline {deadline}" if deadline else ""]
        extra = ", ".join(x for x in extra if x)
        desc = f"{src} {kind} by {buyer}" + (f" ({extra})" if extra else "") + f": {title}"
    return {
        "article_id": nid,
        "project_name": title[:255],
        "country": country,
        "region": _region(country),
        "city": "",
        "lat": None,
        "lng": None,
        "location_source": "project" if country else "unknown",
        "company_name": " / ".join(winners)[:150] if stage == "S5-Awarded" else "",
        "sector": sector,
        "subsector": sub,
        "stage": stage,
        "scale": _scale(usd),
        "description": desc[:255],
        "source_url": url,
        "source_name": SOURCE_NAMES[src],
        "credibility": 5,
        "confidence": "High",
        "contract_value_usd": round(usd) if usd else None,
        "winner_country": " / ".join(winner_countries) or None,
        "buyer": buyer,
        "deadline": deadline,
        "notice_date": date,
        "award_date": award_date,
    }


# ── EU TED ────────────────────────────────────────────────────────────────────

TED_FIELDS = ["publication-number", "notice-title", "notice-type", "buyer-country", "place-of-performance",
              "classification-cpv", "publication-date", "buyer-name", "total-value", "total-value-cur",
              "winner-name", "winner-country", "deadline-receipt-tender-date-lot"]


def _ted_stage(notice_type):
    t = notice_type or ""
    if t.startswith("can-") and t != "can-modif":
        return "S5-Awarded"
    if t.startswith("cn-"):
        return "S4-Tender"
    if t.startswith("pin-") and t != "pin-buyer":
        return "S3-Pre-FID"
    return None  # corrigenda, modifications, VEAT, buyer profiles


def _first(v):
    if isinstance(v, dict):
        v = next(iter(v.values()), None)
    if isinstance(v, list):
        v = v[0] if v else None
    return v


def fetch_ted(day):
    """All TED notices published on `day` (YYYY-MM-DD) under any mapped CPV branch."""
    roots = sorted({p.ljust(8, "0") for p in CPV_MAP})
    query = f"publication-date = {day.replace('-', '')} AND classification-cpv IN ({' '.join(roots)})"
    out, page = [], 1
    while True:
        r = requests.post(TED_URL, json={"query": query, "fields": TED_FIELDS, "limit": 250, "page": page}, timeout=60)
        r.raise_for_status()
        batch = r.json().get("notices") or []
        out += batch
        if len(batch) < 250 or page >= 40:
            break
        page += 1
    return out


def ted_to_opportunity(n, fx):
    stage = _ted_stage(n.get("notice-type"))
    cls = cpv_class(n.get("classification-cpv") or [])
    if not stage or not cls:
        return None
    sector, sub, strong = cls
    titles = n.get("notice-title") or {}
    title = titles.get("eng") or _first(titles) or ""
    # "Germany – Drilling and exploration work – <original title>": drop the country prefix
    title = re.sub(r"^[^–]{2,40}–\s*", "", title).strip()
    if EXCLUDE.search(title) or EXCLUDE_EU.search(title):
        return None
    usd = _usd(n.get("total-value"), _first(n.get("total-value-cur")), fx)
    if not _keep(stage, sub, strong, usd):
        return None
    place = [c for c in (n.get("place-of-performance") or []) if len(c) == 3]
    country = _country(place[0] if place else _first(n.get("buyer-country")))
    winners, seen = [], set()
    for w in (n.get("winner-name") or {}).values() if isinstance(n.get("winner-name"), dict) else []:
        for name in w:
            if name.lower() not in seen:
                winners.append(name)
                seen.add(name.lower())
    wcs = list(dict.fromkeys(_country(c) for c in (n.get("winner-country") or [])))
    deadline = (_first(n.get("deadline-receipt-tender-date-lot")) or "")[:10] or None
    date = (n.get("publication-date") or "")[:10]
    return _opp("EU", f"ted-{n['publication-number']}", TED_NOTICE_URL.format(id=n["publication-number"]), title,
                country, sector, sub, stage, usd, _first(n.get("buyer-name")) or "", winners, wcs, deadline,
                None, date)


# ── UK Find a Tender ─────────────────────────────────────────────────────────

FTS_STAGE = {"planning": "S3-Pre-FID", "tender": "S4-Tender", "award": "S5-Awarded"}


def _fts_get(url, params, tries=5):
    """FTS answers 429 when paged quickly: wait (Retry-After or backoff) and retry."""
    for i in range(tries):
        r = requests.get(url, params=params, headers={"Accept": "application/json"}, timeout=60)
        if r.status_code != 429:
            r.raise_for_status()
            time.sleep(1)  # stay polite between pages
            return r.json()
        wait = int(r.headers.get("Retry-After") or 0) or 10 * (i + 1)
        log.info(f"FTS rate limited, waiting {wait}s")
        time.sleep(min(wait, 120))
    r.raise_for_status()


def fetch_fts(day):
    nxt = None
    params = {"updatedFrom": f"{day}T00:00:00",
              "updatedTo": (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"),
              "limit": 100}
    out = []
    for _ in range(100):
        d = _fts_get(nxt or FTS_URL, None if nxt else params)
        out += d.get("releases") or []
        nxt = (d.get("links") or {}).get("next")
        if not nxt or not d.get("releases"):
            break
    return out


def fts_to_opportunity(x, fx):
    tags = x.get("tag") or []
    stage = next((FTS_STAGE[t] for t in tags if t in FTS_STAGE), None)
    if not stage:
        return None
    tender = x.get("tender") or {}
    awards = x.get("awards") or []
    codes = []
    if tender.get("classification"):
        codes.append(tender["classification"].get("id"))
    for it in (tender.get("items") or []) + [i for a in awards for i in (a.get("items") or [])]:
        codes += [c.get("id") for c in (it.get("additionalClassifications") or []) if c.get("scheme", "CPV") == "CPV"]
    cls = cpv_class(codes)
    if not cls:
        return None
    sector, sub, strong = cls
    title = (tender.get("title") or next((a.get("title") for a in awards if a.get("title")), "") or "").strip()
    if not title or EXCLUDE.search(title) or EXCLUDE_EU.search(title):
        return None

    parties = {p.get("id"): p for p in x.get("parties") or []}
    buyer = (x.get("buyer") or {}).get("name") or next((p.get("name") for p in parties.values() if "buyer" in (p.get("roles") or [])), "")
    winners, wcs, usd, award_date = [], [], None, None
    if stage == "S5-Awarded":
        total, cur = 0.0, None
        for a in awards:
            v = a.get("value") or {}
            if v.get("amount"):
                total += float(v["amount"])
                cur = cur or v.get("currency")
            award_date = award_date or (a.get("date") or "")[:10] or None
            for s in a.get("suppliers") or []:
                if s.get("name") and s["name"] not in winners:
                    winners.append(s["name"])
                    c = ((parties.get(s.get("id")) or {}).get("address") or {}).get("countryName")
                    if c and c not in wcs:
                        wcs.append(c)
        usd = _usd(total, cur, fx)
    else:
        v = tender.get("value") or {}
        usd = _usd(v.get("amount"), v.get("currency"), fx)
    if not _keep(stage, sub, strong, usd):
        return None
    deadline = ((tender.get("tenderPeriod") or {}).get("endDate") or "")[:10] or None
    return _opp("UK", f"fts-{x['id']}", FTS_NOTICE_URL.format(id=x["id"]), title, "United Kingdom", sector, sub,
                stage, usd, buyer, winners, wcs, deadline, award_date, (x.get("date") or "")[:10])


# ── Entry points ──────────────────────────────────────────────────────────────

def _days(since, until):
    d = datetime.strptime(since, "%Y-%m-%d")
    while d.strftime("%Y-%m-%d") <= until:
        yield d.strftime("%Y-%m-%d")
        d += timedelta(days=1)


def collect(since, until, sources=("ted", "fts")):
    fx = load_fx()
    out = []
    for day in _days(since, until):
        if "ted" in sources:
            try:
                raw = fetch_ted(day)
                items = [o for o in (ted_to_opportunity(n, fx) for n in raw) if o]
                log.info(f"TED {day}: {len(raw)} CPV-matched notices -> {len(items)} items")
                out += items
            except Exception as e:
                log.error(f"TED {day} failed: {e}")
        if "fts" in sources:
            try:
                raw = fetch_fts(day)
                items = [o for o in (fts_to_opportunity(x, fx) for x in raw) if o]
                log.info(f"FTS {day}: {len(raw)} releases -> {len(items)} items")
                out += items
            except Exception as e:
                log.error(f"FTS {day} failed: {e}")
    return out


def merge_into_opportunities(date_str, data_dir, lookback_days=1):
    """Add the EU and UK items to opportunities_<date>.json (idempotent)."""
    since = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    items = collect(since, date_str)
    items = translate(items, data_dir)
    n = merge_items(date_str, data_dir, "ted-", [o for o in items if o["article_id"].startswith("ted-")])
    n += merge_items(date_str, data_dir, "fts-", [o for o in items if o["article_id"].startswith("fts-")])
    return n


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    ap = argparse.ArgumentParser(description="EU TED + UK Find a Tender -> EPC opportunities")
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--source", choices=["ted", "fts"], default=None)
    args = ap.parse_args()
    since = (datetime.strptime(args.date, "%Y-%m-%d") - timedelta(days=args.days - 1)).strftime("%Y-%m-%d")
    opps = collect(since, args.date, (args.source,) if args.source else ("ted", "fts"))
    for o in sorted(opps, key=lambda o: (o["source_name"], o["stage"], -(o["contract_value_usd"] or 0))):
        val = _money(o["contract_value_usd"]) if o["contract_value_usd"] else "-"
        print(f"{o['source_name'][:6]} {o['stage'][:2]} {o['subsector'][:20]:20} {o['country'][:14]:14} {val:>10} "
              f"{(o['winner_country'] or '')[:14]:14} {o['project_name'][:80]}")


if __name__ == "__main__":
    main()
