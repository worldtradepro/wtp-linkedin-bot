#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Chinese EPC contractors' stock-exchange filings (cninfo)
====================================================================
China's listed EPC contractors (China Chemical, China Energy Engineering, PowerChina,
MCC, China Petroleum Engineering, CCCC ...) must publish their major new contracts:
monthly / quarterly "new contracts" bulletins with a list of the largest contracts,
plus one-off "major contract" / "bid won" notices. They are public, official and name
the contractor, the project, the owner and the value - often for projects abroad
(Saudi Arabia, Iraq, Central Asia, Africa) that the trade press reports late or never.

Source: cninfo.com.cn, the CSRC-designated disclosure site (public, no login).
  1. hisAnnouncement/query per company -> announcement titles in the window
  2. titles that can carry contract lists (KEEP and not DROP)
  3. the PDF -> text (pypdf, vendored in ./vendor when the server venv lacks it)
  4. the analyzer's OpenRouter model turns the text into contract rows (English),
     keeping only commodity-related capital projects (no roads, housing, metro ...)
  5. -> opportunity rows (stage S5-Awarded, winner = the contractor, winner_country China)

Each announcement is processed once: data/cn_seen.json remembers the date it was first
seen and data/cn_cache.json the rows it produced, so a re-run on the same day rebuilds
the same rows without new API calls, and an announcement never lands on two days.

Usage:
    python cn_contractors.py --days 30 --dry-run     # backtest, print rows, write nothing
    python cn_contractors.py --date 2026-10-15        # what the pipeline would merge today

Pipeline use (run_pipeline.py, heavy official sources):
    import cn_contractors; cn_contractors.merge_into_opportunities(date_str, DATA_DIR)
"""

import argparse
import io
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))   # pypdf (+ typing_extensions) when not installed

log = logging.getLogger("cn_contractors")

QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
PDF_BASE = "http://static.cninfo.com.cn/"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept": "application/json, text/plain, */*"}

# (stock code, cninfo orgId, English name used as the winner)
COMPANIES = [
    ("601117", "9900009949", "China National Chemical Engineering (CNCEC)"),
    ("601868", "9900031628", "China Energy Engineering (CEEC)"),
    ("601669", "9900019726", "PowerChina"),
    ("601800", "gshk0001800", "China Communications Construction (CCCC)"),
    ("601618", "9900008087", "Metallurgical Corporation of China (MCC)"),
    ("601390", "9900003904", "China Railway Group (CREC)"),
    ("601186", "9900004347", "China Railway Construction (CRCC)"),
    ("002051", "gssz0002051", "China CAMC Engineering"),
    ("600970", "gssh0600970", "Sinoma International Engineering"),
    ("000928", "gssz0000928", "Sinosteel Engineering & Technology"),
    ("000065", "gssz0000065", "NORINCO International"),
    ("600583", "gssh0600583", "Offshore Oil Engineering (COOEC)"),
    ("600339", "gssh0600339", "China Petroleum Engineering (CPECC)"),
    ("601611", "9900028774", "China Nuclear Engineering & Construction (CNEC)"),
    ("601727", "9900005766", "Shanghai Electric"),
    ("600089", "gssh0600089", "TBEA"),
    ("002140", "9900003261", "East China Engineering Science & Technology"),
    ("603698", "9900023661", "Changzheng Engineering (CALT)"),
]

KEEP = re.compile(r"经营情况|经营数据|重大合同|重大项目|中标|签订|签署|总承包|EPC|新签")
DROP = re.compile(r"担保|回购|董事会|监事会|利润分配|业绩说明|激励|权益分派|股东|债券|票据|募集|关联交易|会计|审计|内部控制|章程|"
                  r"独立董事|法律意见|评估报告|ESG|社会责任|摘要|框架协议|战略合作")
MAX_TEXT = 14000
# second guard after the model's keep flag (the model sometimes keeps a metro line as "rail")
OFF_SCOPE = re.compile(r"\b(metro|subway|light rail|tram(way)?|monorail|highway|expressway|motorway|road|bridge|tunnel|housing|residential|"
                       r"hospital|school|university|stadium|airport|sewage|wastewater|municipal|urban renewal|landscap\w*|"
                       r"station|intercity|inter-city|high-speed|suburban|passenger|ring line|urban rail)\b", re.I)
MAX_USD = 15e9          # no single contract in these filings comes near this; bigger = a misread unit

SECTORS = {
    "Energy": ["Oil & Gas", "LNG", "Refining & Petrochemicals", "Renewables", "Hydrogen & Ammonia",
               "Power & Transmission", "Water & Desalination"],
    "Mining & Metals": ["Mine Development", "Processing & Smelting", "Critical Minerals"],
    "Agriculture": ["Fertilizer Plants", "Grain & Food Infrastructure", "Irrigation & Water"],
    "Logistics & Infrastructure": ["Ports & Terminals", "Pipelines & Storage", "Rail & Inland Transport",
                                   "Shipyard & Fleet", "Data Centers"],
}

PROMPT = """Below is the text of a stock-exchange filing by {company}, a Chinese EPC / construction contractor
(filed {date}, title "{title}"). It may list one or more newly signed or won contracts.

Return ONLY a JSON array; one object per contract that is named individually in the text:
{{"project": "short English project name with the asset and place, e.g. 'Ar Rjum gold mine construction', max 110 chars",
  "owner": "the client / project owner in English if named, else ''",
  "country": "country of the project in English ('China' for domestic projects); '' if not stated",
  "city": "province or city if stated, else ''",
  "contract": "contract type in English: EPC, PC, construction, design, equipment supply ...",
  "value_cny_100m": number in units of 100 million RMB (the filing's 亿元) or null,
  "sector": one of {sectors},
  "subsector": one of the subsectors of that sector: {subsectors},
  "keep": true or false}}

keep = true only for capital projects that produce, process, move or store commodities or energy: oil, gas, LNG,
refining, chemicals, fertilizer, hydrogen/ammonia, power plants, grids, renewables, batteries, mines, smelters,
metals, cement plants, ports, pipelines, railways, shipyards, desalination and industrial water, data centres.
Railways: keep only freight, heavy-haul, mine and port railways; passenger, high-speed, intercity and suburban
lines and stations are keep = false. keep = false also for roads, bridges, tunnels, urban metro/light rail, housing, real estate, hospitals, schools,
municipal works, city water supply/sewage, landscaping, financing, and company totals with no named project.
Fertilizer, phosphate, phosphoric acid, potash and urea plants are Agriculture / Fertilizer Plants; coal-to-chemicals,
olefins and other chemical plants are Energy / Refining & Petrochemicals. value_cny_100m is in 亿元 (100 million RMB): if the filing gives 万元 divide by 10,000, if it gives 元 divide by
100,000,000, and use the RMB equivalent when it states one. Translate names faithfully; do not invent owners, places or numbers. If no contract is named, return [].

Text:
{text}
"""


def _session():
    s = requests.Session()
    s.headers.update(UA)
    return s


def _post(s, data, tries=4):
    for i in range(tries):
        try:
            r = s.post(QUERY_URL, data=data, timeout=45)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning(f"cninfo query failed ({e}), retry {i + 1}/{tries}")
            time.sleep(5 * (i + 1))
    return {}


def fetch_announcements(since: str, until: str) -> list:
    """Contract-type announcements of all COMPANIES published since..until (inclusive)."""
    s = _session()
    out = []
    for code, org, en in COMPANIES:
        col = "szse" if code.startswith("0") else "sse"
        for page in range(1, 6):
            j = _post(s, {"pageNum": page, "pageSize": 30, "column": col, "tabName": "fulltext", "plate": "",
                          "stock": f"{code},{org}", "searchkey": "", "secid": "", "category": "", "trade": "",
                          "seDate": f"{since}~{until}", "sortName": "", "sortType": "", "isHLtitle": "true"})
            for a in j.get("announcements") or []:
                title = re.sub(r"<[^>]+>", "", a.get("announcementTitle") or "")
                if KEEP.search(title) and not DROP.search(title):
                    day = datetime.fromtimestamp(a["announcementTime"] / 1000, tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
                    out.append({"id": str(a["announcementId"]), "code": code, "company": en, "title": title,
                                "url": PDF_BASE + a["adjunctUrl"], "date": day})
            time.sleep(1)
            if not j.get("hasMore"):
                break
    return out


def pdf_text(url: str) -> str:
    from pypdf import PdfReader
    for i in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=60)
            r.raise_for_status()
            reader = PdfReader(io.BytesIO(r.content))
            text = "\n".join((p.extract_text() or "") for p in reader.pages[:12])
            return re.sub(r"[ \t]+", " ", text)[:MAX_TEXT]
        except Exception as e:
            log.warning(f"PDF {url} failed ({e}), retry {i + 1}/3")
            time.sleep(5 * (i + 1))
    return ""


def extract(ann: dict, text: str) -> list:
    from openrouter_analyzer import call_openrouter
    prompt = PROMPT.format(company=ann["company"], date=ann["date"], title=ann["title"], text=text,
                           sectors=json.dumps(list(SECTORS)), subsectors=json.dumps(SECTORS, ensure_ascii=False))
    raw = call_openrouter(prompt)
    m = re.search(r"\[.*\]", raw or "", re.S)
    rows = json.loads(m.group(0)) if m else []
    return [r for r in rows if isinstance(r, dict)]


def to_opportunity(ann: dict, i: int, c: dict, cny_per_usd: float):
    if not c.get("keep") or not (c.get("project") or "").strip() or OFF_SCOPE.search(c["project"]):
        return None
    sector = c.get("sector") if c.get("sector") in SECTORS else ""
    sub = c.get("subsector") if sector and c.get("subsector") in SECTORS[sector] else ""
    if not sector:
        return None
    from wb_procurement import canonical_country, _region, _scale, _money
    country = canonical_country(c.get("country") or "") if (c.get("country") or "").strip() else ""
    if country == "China" and sub == "Rail & Inland Transport":
        return None      # China's domestic rail contracts are passenger lines and stations for state railways, not our scope
    try:
        cny = float(c.get("value_cny_100m")) * 1e8 if c.get("value_cny_100m") not in (None, "") else None
    except (TypeError, ValueError):
        cny = None
    usd = round(cny / cny_per_usd) if (cny and cny_per_usd) else None
    if usd and usd > MAX_USD:
        usd = None
    project = re.sub(r"\s+", " ", c["project"]).strip()[:200]
    owner = (c.get("owner") or "").strip()[:150]
    kind = (c.get("contract") or "contract").strip()
    art = "an" if kind[:1].lower() in "aeiou" or kind.isupper() and kind[:1] in "AEFHILMNORSX" else "a"
    desc = f"{ann['company']} signed {art} {kind} contract" + (f" worth about {_money(usd)}" if usd else "") + \
           (f" with {owner}" if owner else "") + f": {project}"
    return {
        "article_id": f"cn-{ann['id']}-{i}",
        "project_name": project,
        "country": country,
        "region": _region(country) if country else "Global",
        "city": (c.get("city") or "").strip()[:80],
        "lat": None,
        "lng": None,
        "location_source": "project" if country else "unknown",
        "company_name": ann["company"][:150],
        "buyer": owner,
        "sector": sector,
        "subsector": sub,
        "stage": "S5-Awarded",
        "scale": _scale(usd),
        "description": desc[:255],
        "source_url": ann["url"],
        "source_name": "Company filing",
        "credibility": 5,
        "confidence": "High",
        "contract_value_usd": usd,
        "winner_country": "China",
        "notice_date": ann["date"],
        "award_date": ann["date"],
    }


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _cny_rate() -> float:
    try:
        from wb_procurement import load_fx
        return float(load_fx().get("CNY") or 0) or 7.1
    except Exception:
        return 7.1


def collect(date_str: str, data_dir: str, lookback_days: int = 4, dry_run: bool = False) -> list:
    """Rows for announcements first seen on date_str (re-runs on the same day give the same rows)."""
    seen_path, cache_path = os.path.join(data_dir, "cn_seen.json"), os.path.join(data_dir, "cn_cache.json")
    seen, cache = ({} if dry_run else _load(seen_path, {})), _load(cache_path, {})
    since = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    anns = sorted(fetch_announcements(since, date_str), key=lambda a: (a["date"], a["id"]))   # oldest first: _repeat looks back
    rate = _cny_rate()
    rows, new = [], 0
    for ann in anns:
        first = seen.get(ann["id"])
        if first and first != date_str:
            continue                         # already published on an earlier day
        if ann["id"] not in cache:
            text = pdf_text(ann["url"])
            try:
                cache[ann["id"]] = {"ann": ann, "contracts": extract(ann, text) if text else []}
            except Exception as e:
                log.warning(f"extraction failed for {ann['title']} ({e}); will retry next run")
                continue
            new += 1
        seen[ann["id"]] = date_str
        for i, c in enumerate(cache[ann["id"]]["contracts"]):
            o = to_opportunity(cache[ann["id"]]["ann"], i, c, rate)
            if o and not _repeat(o, ann, cache):
                rows.append(o)
    for path, obj in (((cache_path, cache),) if dry_run else ((seen_path, seen), (cache_path, cache))):
        if True:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=1)
    log.info(f"cninfo: {len(anns)} contract-type filings {since}..{date_str}, {new} newly read -> {len(rows)} commodity project rows")
    return rows


WORD = re.compile(r"[a-z0-9]+")
STOP = {"project", "projects", "construction", "contract", "epc", "phase", "the", "and", "of", "in", "for", "plant", "power",
        "station", "engineering", "general", "contracting", "co", "ltd", "company", "mw", "ii", "i", "section"}


def _key(project: str) -> set:
    return {w for w in WORD.findall(project.lower()) if w not in STOP and len(w) > 2}


def _repeat(o: dict, ann: dict, cache: dict) -> bool:
    """True when an EARLIER filing of the same company already listed this contract (same country, most name words
    shared). Quarterly reports of some contractors (e.g. NORINCO International) repeat their running list."""
    k = _key(o["project_name"])
    if not k:
        return False
    for aid, e in cache.items():
        a = e["ann"]
        if a["code"] != ann["code"] or (a["date"], aid) >= (ann["date"], ann["id"]):
            continue
        for c in e["contracts"]:
            from wb_procurement import canonical_country
            if not c.get("keep") or canonical_country(c.get("country") or "").lower() != (o.get("country") or "").lower():
                continue
            k2 = _key(c.get("project") or "")
            if k2 and len(k & k2) / min(len(k), len(k2)) >= 0.6:
                return True
    return False


def merge_into_opportunities(date_str: str, data_dir: str) -> int:
    from wb_procurement import merge_items
    return merge_items(date_str, data_dir, "cn-", collect(date_str, data_dir))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s", datefmt="%H:%M:%S")
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    ap.add_argument("--days", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", help="dry run: write the rows to this JSON file")
    a = ap.parse_args()
    from title_translate import _load_env
    _load_env()
    data_dir = os.path.join(HERE, "data")
    rows = collect(a.date, data_dir, a.days, dry_run=a.dry_run)
    if a.dry_run:
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=1)
        for o in rows:
            print(f"{o['award_date']}  {o['country'][:14]:14s} {o['subsector'][:22]:22s} {o['company_name'][:28]:28s} {o['project_name'][:70]}")
    else:
        from wb_procurement import merge_items
        print(merge_items(a.date, data_dir, "cn-", rows), "rows merged")


if __name__ == "__main__":
    main()
