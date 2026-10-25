#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — development-bank project pipelines (IATI files, no API key)
========================================================================
Development banks publish their project lists as IATI XML files on their own
sites and register them on the IATI Registry. We read those files directly
(not the IATI API gateway, whose terms forbid running a commercial service on
it), and only from publishers whose registered licence allows commercial use
with attribution:

    afdb      African Development Bank                 CC BY
    ebrd      EBRD                                     ODC-BY
    isdb      Islamic Development Bank                 CC BY

Checked and left out (2026-09-26): ADB (CC BY, but files behind a Cloudflare
browser check), IDB Invest (HTTP 403), US DFC (only completed deals, no
sectors), BII (empty file); IFC / IDB / EIB are "other-attribution", not
reviewed.

These files are refreshed in bulk every few weeks, so "last updated" says
nothing about news. Instead data/iati_seen.json remembers every relevant
project and its status; a project is published when it first appears
(pipeline -> S2-Development, approved/implementation -> S3-Pre-FID) or when it
moves from pipeline to implementation. The very first run only records what
exists, so the map is not flooded with hundreds of old projects.

Unchanged files are skipped with HTTP conditional requests (ETag/Last-Modified).

Usage:
    python iati_projects.py --probe          # print what each publisher offers, write nothing
"""

import argparse
import json
import logging
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

from wb_procurement import REGION_BY_COUNTRY, _money, _scale, load_fx, merge_items

log = logging.getLogger("iati_projects")

REGISTRY = "https://iatiregistry.org/api/3/action/package_search"
COUNTRY_CODELIST = "https://cdn.iatistandard.org/prod-iati-website/reference_downloads/203/codelists/downloads/clv3/json/en/Country.json"
DPORTAL_URL = "https://d-portal.org/ctrack.html#view=act&aid={id}"

PUBLISHERS = {
    "afdb": "African Development Bank",
    "ebrd": "EBRD",
    "isdb": "Islamic Development Bank",
}

STATUS_STAGE = {"1": "S2-Development", "2": "S3-Pre-FID"}  # 1 = pipeline/identification, 2 = implementation

# OECD DAC 5-digit purpose codes -> (sector, subsector). Prefix match, longest wins.
DAC = {
    "231": ("Energy", "Power & Transmission"),      # energy policy (AfDB files its power projects here)
    "232": ("Energy", "Renewables"),                 # renewable generation
    "233": ("Energy", "Power & Transmission"),       # fossil generation
    "23340": ("Energy", "Oil & Gas"),                # gas-fired
    "234": ("Energy", "Power & Transmission"),       # hybrid
    "235": ("Energy", "Power & Transmission"),       # nuclear
    "236": ("Energy", "Power & Transmission"),       # transmission, distribution, heat
    "23640": ("Logistics & Infrastructure", "Pipelines & Storage"),  # gas distribution
    "32261": ("Mining & Metals", "Mine Development"),     # coal
    "32262": ("Energy", "Oil & Gas"),                      # oil & gas upstream
    "32263": ("Mining & Metals", "Mine Development"),     # ferrous metals
    "32264": ("Mining & Metals", "Mine Development"),     # non-ferrous
    "32265": ("Mining & Metals", "Mine Development"),     # precious metals
    "32266": ("Mining & Metals", "Mine Development"),     # industrial minerals
    "32267": ("Agriculture", "Fertilizer Plants"),        # fertilizer minerals
    "32268": ("Mining & Metals", "Mine Development"),     # offshore minerals
    "32220": ("Mining & Metals", "Mine Development"),     # mineral prospection
    "32161": ("Agriculture", "Grain & Food Infrastructure"),  # agro-industries
    "32165": ("Agriculture", "Fertilizer Plants"),
    "32169": ("Mining & Metals", "Processing & Smelting"),    # basic metal industries
    "32170": ("Mining & Metals", "Processing & Smelting"),    # non-ferrous metal industries
    "31140": ("Agriculture", "Irrigation & Water"),       # agricultural water resources
    "21030": ("Logistics & Infrastructure", "Rail & Inland Transport"),
    "21040": ("Logistics & Infrastructure", "Ports & Terminals"),
    "21061": ("Logistics & Infrastructure", "Pipelines & Storage"),  # storage
}
# Agricultural policy (31110) holds both agro-industrial zones and emergency food
# aid; only the former is EPC.
AGRI_POLICY_OK = re.compile(r"agro-?industr|agropole|processing|irrigat|storage|silo|fertili|abattoir|cold chain", re.I)
# 2026-10-25 (owner): city water supply, sewage and sanitation are not covered. EBRD files many of them under DAC 32266
# (industrial minerals), which read as mining. Desalination and irrigation stay.
WATER_EXCLUDE = re.compile(r"\bwater\b|wwtp|waste ?water|sewage|sewerage|sanitation|septic|\bdrain|vodokanal|\bvk\b|flood protection|"
                           r"river rehabilitation|depollution|hydraulic infrastructure|\bswift\b|\br2cf\b|environmental programme", re.I)   # SWIFT / R2CF = EBRD Romanian water programmes
WATER_KEEP = re.compile(r"desalinat|irrigat|biogas|hydro ?power|hydroelectric|mine|mining", re.I)
TITLE_EXCLUDE = re.compile(r"humanitarian|emergency|technical assistance|capacity building|feasibility study|study|"
                           r"lessons learned|policy|reform|budget support|governance|covid|credit line|line of credit|"
                           r"\bsme\b|trade finance|guarantee facility|equity fund", re.I)


def _t(el):
    """English narrative if there is one, else the first."""
    if el is None:
        return ""
    ns = el.findall("narrative")
    en = [n for n in ns if (n.get("{http://www.w3.org/XML/1998/namespace}lang") or "").lower().startswith("en")]
    n = (en or ns or [None])[0]
    return " ".join((n.text or "").split()) if n is not None else " ".join((el.text or "").split())


# Publishers using the 3-digit DAC categories (vocabulary 2, e.g. IsDB) cannot tell
# rail from roads or a fertilizer plant from SME credit, so the title decides.
CAT3_TITLE = [
    (("231", "232", "233", "234", "235", "236"), [
        (r"hydro|solar|wind|geotherm|photovolt|renewable", ("Energy", "Renewables")),
        (r"gas|lng|pipeline", ("Energy", "Oil & Gas")),
        (r"power|electric|transmission|substation|grid|energy", ("Energy", "Power & Transmission"))]),
    (("322",), [(r".", ("Mining & Metals", "Mine Development"))]),
    (("210",), [
        (r"rail", ("Logistics & Infrastructure", "Rail & Inland Transport")),
        (r"port|harbou?r|terminal|jetty", ("Logistics & Infrastructure", "Ports & Terminals"))]),
    (("311",), [
        (r"irrigat|dam\b|canal", ("Agriculture", "Irrigation & Water")),
        (r"silo|storage|agro-?industr|processing|abattoir", ("Agriculture", "Grain & Food Infrastructure"))]),
    (("321",), [
        (r"fertili|urea|ammonia", ("Agriculture", "Fertilizer Plants")),
        (r"refiner|petrochem", ("Energy", "Refining & Petrochemicals")),
        (r"steel|smelter|alumin|copper", ("Mining & Metals", "Processing & Smelting"))]),
]


def classify(a):
    title = _t(a.find("title"))
    if not title or TITLE_EXCLUDE.search(title):
        return None
    if WATER_EXCLUDE.search(title) and not WATER_KEEP.search(title):
        return None
    sectors = a.findall("sector")
    codes = [s.get("code", "") for s in sectors if s.get("vocabulary", "1") == "1"]
    for code in codes:
        best = max((p for p in DAC if code.startswith(p)), key=len, default=None)
        if best:
            return DAC[best]
    if any(c.startswith("31110") for c in codes) and AGRI_POLICY_OK.search(title):
        return ("Agriculture", "Grain & Food Infrastructure")
    cats = [s.get("code", "") for s in sectors if s.get("vocabulary") == "2"]
    for prefixes, rules in CAT3_TITLE:
        if any(c.startswith(prefixes) for c in cats):
            for pat, cls in rules:
                if re.search(pat, title, re.I):
                    return cls
    return None


def _value_usd(a, fx):
    """Committed amount: commitment transactions, else budgets. USD."""
    default_cur = a.get("default-currency")

    def total(values):
        s = 0.0
        for v in values:
            cur = (v.get("currency") if v is not None else None) or default_cur
            try:
                s += float(v.text) / fx[cur]
            except (AttributeError, TypeError, ValueError, KeyError):
                pass
        return s

    commitments = [t.find("value") for t in a.findall("transaction")
                   if (t.find("transaction-type") is not None and t.find("transaction-type").get("code") == "2")]
    return total(commitments) or total(a.findall("budget/value")) or None


def _countries():
    try:
        data = requests.get(COUNTRY_CODELIST, timeout=60).json()["data"]
        return {d["code"]: d["name"] for d in data}
    except Exception as e:
        log.warning(f"Country codelist unavailable: {e}")
        return {}


def _place(code, names):
    full = names.get(code, code or "")
    short = re.split(r"[,(]", full)[0].strip()
    short = short.title() if short.isupper() else short
    if code == "CD":
        short = "DR Congo"
    low = short.lower()
    region = REGION_BY_COUNTRY.get(low) or next((r for k, r in REGION_BY_COUNTRY.items() if k.startswith(low)), None)
    return short, region or "Global"


def _files(publisher):
    r = requests.get(REGISTRY, params={"fq": f"organization:{publisher}", "rows": 500}, timeout=120)
    r.raise_for_status()
    out = []
    for p in r.json()["result"]["results"]:
        ftype = next((e["value"] for e in p.get("extras", []) if e["key"] == "filetype"), "activity")
        if ftype == "activity":
            out += [res["url"] for res in p.get("resources", []) if res.get("url")]
    return out


def _get(url, http_cache):
    """Path of a temp file with the body, or None when the file is unchanged since last run (304) or fails.

    Streamed to disk: some bank files are hundreds of MB and the host kills the process (exit 137)
    when a whole file is held in memory. The caller deletes the temp file.
    """
    h = {"User-Agent": "WTP-EPC-Radar/1.0 (+https://worldtradepro.com)"}
    c = http_cache.get(url) or {}
    if c.get("etag"):
        h["If-None-Match"] = c["etag"]
    if c.get("modified"):
        h["If-Modified-Since"] = c["modified"]
    try:
        r = requests.get(url, headers=h, timeout=180, stream=True)
    except Exception as e:
        log.warning(f"IATI {url}: {e}")
        return None
    with r:
        if r.status_code == 304:
            return None
        if r.status_code != 200:
            log.warning(f"IATI {url}: HTTP {r.status_code}")
            return None
        fd, path = tempfile.mkstemp(prefix="iati_", suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    f.write(chunk)
        except Exception as e:
            log.warning(f"IATI {url}: download failed ({e})")
            os.remove(path)
            return None
    with open(path, "rb") as f:
        if not f.read(512).lstrip().startswith(b"<"):
            log.warning(f"IATI {url}: not XML")
            os.remove(path)
            return None
    http_cache[url] = {"etag": r.headers.get("ETag"), "modified": r.headers.get("Last-Modified")}
    return path


def _record(a, pub, fx, names):
    """(iati-id, record) for a relevant activity element, else None."""
    st = a.find("activity-status")
    status = st.get("code") if st is not None else None
    if status not in STATUS_STAGE:
        return None
    cls = classify(a)
    if not cls:
        return None
    aid = (a.findtext("iati-identifier") or "").strip()
    rc = a.find("recipient-country")
    country, region = _place(rc.get("code") if rc is not None else "", names)
    impl = next((_t(p) for p in a.findall("participating-org") if p.get("role") == "4"), "")
    dates = [d.get("iso-date") or "" for d in a.findall("activity-date") if d.get("type") in ("1", "2")]
    return aid, {"publisher": pub, "status": status, "title": _t(a.find("title")), "sector": cls[0], "start": min([x for x in dates if x] or [""]),
                 "subsector": cls[1], "country": country, "region": region, "implementer": impl,
                 "usd": _value_usd(a, fx)}


def scan(publishers, http_cache, fx, names):
    """{iati-id: record} for relevant projects in changed files."""
    found = {}
    for pub in publishers:
        try:
            urls = _files(pub)
        except Exception as e:
            log.warning(f"IATI registry {pub}: {e}")
            continue
        changed = 0
        for url in urls:
            path = _get(url, http_cache)
            if path is None:
                continue
            changed += 1
            try:
                # one activity at a time, freed after use: memory stays flat whatever the file size
                for _, a in ET.iterparse(path, events=("end",)):
                    if a.tag != "iati-activity":
                        continue
                    rec = _record(a, pub, fx, names)
                    a.clear()
                    if rec:
                        found[rec[0]] = rec[1]
            except ET.ParseError as e:
                log.warning(f"IATI {url}: bad XML ({e})")
                http_cache.pop(url, None)
            finally:
                os.remove(path)
        log.info(f"IATI {pub}: {len(urls)} files, {changed} changed")
    return found


def to_opportunity(aid, r, date_str, moved):
    stage = STATUS_STAGE[r["status"]]
    bank = PUBLISHERS[r["publisher"]]
    what = "approved for financing" if moved else ("pipeline project" if r["status"] == "1" else "newly approved project")
    val = f", {_money(r['usd'])}" if r["usd"] else ""
    return {
        "article_id": f"iati-{aid}"[:64],
        "project_name": r["title"][:255],
        "country": r["country"],
        "region": r["region"],
        "city": "", "lat": None, "lng": None,
        "location_source": "project" if r["country"] else "unknown",
        "company_name": r["implementer"][:150],
        "sector": r["sector"],
        "subsector": r["subsector"],
        "stage": stage,
        "scale": _scale(r["usd"]),
        "description": f"{bank} {what}{val}: {r['title']}"[:255],
        "source_url": DPORTAL_URL.format(id=aid),
        "source_name": f"{bank} (IATI)",
        "credibility": 5,
        "confidence": "High",
        "contract_value_usd": round(r["usd"]) if r["usd"] else None,
        "notice_date": date_str,
    }


def merge_into_opportunities(date_str, data_dir, lookback_days=1):
    """Publish new/advanced development-bank projects into opportunities_<date>.json."""
    day_file = os.path.join(data_dir, f"iati_{date_str}.json")
    if os.path.exists(day_file):  # re-run of the same date
        with open(day_file, encoding="utf-8") as f:
            items = json.load(f)
        return merge_items(date_str, data_dir, "iati-", items)

    state_file = os.path.join(data_dir, "iati_seen.json")
    try:
        with open(state_file, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    first_run = not state.get("seen")
    seen, http_cache = state.get("seen", {}), state.get("http", {})

    found = scan(PUBLISHERS, http_cache, load_fx(), _countries())
    items = []
    old = 0
    for aid, r in found.items():
        before = seen.get(aid)
        moved = before == "1" and r["status"] == "2"
        # 2026-10-25: an activity seen for the first time is "new" only if it started or was approved in the last
        # 180 days. Older ones appear when a bank recodes its sectors (EBRD, 10-22: 70 old city-water projects) -
        # recorded in seen, not published.
        recent = (r.get("start") or "9999") >= (datetime.now(timezone.utc) - timedelta(days=180)).strftime("%Y-%m-%d")
        if not first_run and (moved or (before is None and recent)):
            items.append(to_opportunity(aid, r, date_str, moved))
        elif not first_run and before is None:
            old += 1
        seen[aid] = r["status"]
    if first_run:
        log.info(f"IATI first run: recorded {len(seen)} existing projects, nothing published")
    if old:
        log.info(f"IATI: {old} newly matching but older projects (started over 180 days ago) recorded, not published")

    from title_translate import translate
    items = translate(items, data_dir)
    with open(day_file, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump({"seen": seen, "http": http_cache,
                   "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, f)
    return merge_items(date_str, data_dir, "iati-", items)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    ap = argparse.ArgumentParser(description="Development-bank IATI project pipelines")
    ap.add_argument("--probe", action="store_true", help="print relevant projects per publisher, write nothing")
    args = ap.parse_args()
    if not args.probe:
        ap.print_help()
        return
    found = scan(PUBLISHERS, {}, load_fx(), _countries())
    by_pub = {}
    for aid, r in found.items():
        by_pub.setdefault(r["publisher"], []).append((aid, r))
    for pub, rows in by_pub.items():
        pipe = sum(r["status"] == "1" for _, r in rows)
        print(f"\n== {PUBLISHERS[pub]}: {len(rows)} relevant projects ({pipe} pipeline)")
        for aid, r in sorted(rows, key=lambda x: (x[1]["status"], -(x[1]["usd"] or 0)))[:8]:
            val = _money(r["usd"]) if r["usd"] else "-"
            print(f"  {r['status']} {r['subsector'][:20]:20} {r['country'][:14]:14} {val:>10}  {r['title'][:80]}")


if __name__ == "__main__":
    main()
