#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — IFC project disclosures (World Bank Finances One, no key)
=====================================================================
IFC's own website terms allow only personal, non-commercial use, but the same
project list is published by the World Bank on Finances One as dataset DS00499
"IFC Investment Services Projects" under CC BY 3.0 IGO (commercial use allowed
with attribution), refreshed daily.

A project is published on the day IFC first discloses it (date_disclosed): at
that point it is usually "Pending Approval", i.e. before board approval, so it
maps to S3-Pre-FID. Only commodity-related projects are kept (power, oil & gas,
mining, ports/rail/pipelines, fertilizer, agro-processing, metals).

Usage:
    python ifc_projects.py --days 30      # print what the last 30 days would add
"""

import argparse
import logging
import re
from datetime import datetime, timedelta, timezone

import requests

from europe_procurement import EUROPE
from wb_procurement import REGION_BY_COUNTRY, _money, _scale, merge_items

log = logging.getLogger("ifc_projects")

API = ("https://datacatalogapi.worldbank.org/dexapps/fone/api/apiservice"
       "?datasetId=DS00499&resourceId=RS00448&type=json&top=10000")
SOURCE = "IFC (World Bank Finances One, CC BY 3.0 IGO)"

E, M, A, L = "Energy", "Mining & Metals", "Agriculture", "Logistics & Infrastructure"
# (industry, title pattern, sector, subsector) — first match wins
RULES = [
    (None, r"solar|wind|hydro|geotherm|renewable|\bdares\b|photovolt|battery|storage", E, "Renewables"),
    (None, r"\blng\b|regas", E, "LNG"),
    (None, r"refiner|petrochem", E, "Refining & Petrochemicals"),
    (None, r"hydrogen|ammonia", E, "Hydrogen & Ammonia"),
    (None, r"fertili|urea|phosphat|potash", A, "Fertilizer Plants"),
    (None, r"pipeline|terminal|tank farm", L, "Pipelines & Storage"),
    (None, r"\bport\b|harbou?r|container|shipyard", L, "Ports & Terminals"),
    (None, r"rail", L, "Rail & Inland Transport"),
    ("Infrastructure", r"\bipp\b|ccgt|power|energy|electric|transmission|grid|gas|thermal", E, "Power & Transmission"),
    ("Metals and Mining", r"smelt|refin|steel|alumin|copper|nickel", M, "Processing & Smelting"),
    ("Metals and Mining", r".", M, "Mine Development"),
    ("Manufacturing", r"steel|alumin|smelt|cement|glass", M, "Processing & Smelting"),
    ("Agribusiness and Forestry", r"process|mill|storage|silo|warehouse|irrigat|sugar|oil ?seed|crush", A,
     "Grain & Food Infrastructure"),
]
# Industries whose projects can be commodity EPC at all (banks, funds, telecom never)
INDUSTRIES = {"Infrastructure", "Metals and Mining", "Manufacturing", "Agribusiness and Forestry", "other"}
PENDING = {"Pending Approval", "Pending Signing", "Pending Disbursement"}


def _date(s):
    try:
        return datetime.strptime(s, "%d-%b-%Y")
    except (TypeError, ValueError):
        return None


def classify(row):
    if row.get("industry") not in INDUSTRIES:
        return None
    title = row.get("project_name") or ""
    for industry, pat, sector, sub in RULES:
        if (industry is None or industry == row["industry"]) and re.search(pat, title, re.I):
            return sector, sub
    return None


def _region(country):
    low = country.lower()
    if low in REGION_BY_COUNTRY:
        return REGION_BY_COUNTRY[low]
    if country in EUROPE or "europe" in low:
        return "Europe"
    for region, pat in (("Africa", "africa"), ("Middle East", "middle east"), ("Asia Pacific", "asia|pacific"),
                        ("Americas", "america|caribbean")):
        if re.search(pat, low):
            return region
    return "Global"


def to_opportunity(row):
    cls = classify(row)
    if not cls or row.get("status") not in PENDING:
        return None
    usd = row.get("total_ifc_investment_as_approved_by_boardmillion__usd")
    usd = usd * 1e6 if isinstance(usd, (int, float)) and usd else None
    country = (row.get("country") or "").split(",")[0].strip()  # "Egypt, Arab Rep." -> "Egypt"
    is_country = not re.search(r"region|world", country, re.I)
    name = row.get("project_name") or ""
    company = row.get("company_name") or ""
    desc = f"IFC investment disclosed ({row['status'].lower()}" + (f", {_money(usd)}" if usd else "") + \
           f"): {name}" + (f" — {company}" if company and company.lower() != name.lower() else "")
    return {
        "article_id": f"ifc-{row['project_number']}",
        "project_name": name[:255],
        "country": country if is_country else "",
        "region": _region(country),
        "city": "", "lat": None, "lng": None,
        "location_source": "project" if is_country else "unknown",
        "company_name": company[:150],
        "sector": cls[0],
        "subsector": cls[1],
        "stage": "S3-Pre-FID",
        "scale": _scale(usd),
        "description": desc[:255],
        "source_url": row.get("project_url") or "",
        "source_name": SOURCE,
        "credibility": 5,
        "confidence": "High",
        "contract_value_usd": round(usd) if usd else None,
        "notice_date": (_date(row.get("date_disclosed")) or datetime.min).strftime("%Y-%m-%d"),
    }


def collect(since, until):
    r = requests.get(API, timeout=180)
    r.raise_for_status()
    rows = r.json().get("data") or []
    lo, hi = datetime.strptime(since, "%Y-%m-%d"), datetime.strptime(until, "%Y-%m-%d")
    fresh = [x for x in rows if (_date(x.get("date_disclosed")) or datetime.min) >= lo
             and (_date(x.get("date_disclosed")) or datetime.max) <= hi]
    out = [o for o in map(to_opportunity, fresh) if o]
    log.info(f"IFC: {len(rows)} projects, {len(fresh)} disclosed {since}..{until} -> {len(out)} commodity items")
    return out


def merge_into_opportunities(date_str, data_dir, lookback_days=1):
    """Add IFC projects disclosed in the window to opportunities_<date>.json (idempotent)."""
    since = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    return merge_items(date_str, data_dir, "ifc-", collect(since, date_str))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    ap = argparse.ArgumentParser(description="IFC project disclosures -> EPC opportunities (prints only)")
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--days", type=int, default=1)
    args = ap.parse_args()
    since = (datetime.strptime(args.date, "%Y-%m-%d") - timedelta(days=args.days - 1)).strftime("%Y-%m-%d")
    for o in collect(since, args.date):
        val = _money(o["contract_value_usd"]) if o["contract_value_usd"] else "-"
        print(f"{o['notice_date']} {o['subsector'][:22]:22} {o['country'][:14]:14} {val:>9}  {o['project_name'][:45]}"
              f" | {o['company_name'][:40]}")


if __name__ == "__main__":
    main()
