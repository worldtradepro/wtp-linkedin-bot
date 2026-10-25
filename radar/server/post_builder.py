#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Post Builder
=========================
Reads opportunities_YYYY-MM-DD.json, builds a forum HTML post.

Output: post_YYYY-MM-DD.html  (also returns HTML string)

Usage:
    python post_builder.py                        # build today's post
    python post_builder.py --date 2026-03-08      # specific date
    python post_builder.py --input opps.json      # custom input
    python post_builder.py --preview              # open in browser

Optional env vars:
    OUTPUT_DIR   (default: .)
"""

import os
import json
import argparse
import html as _html
import webbrowser
from datetime import datetime, timezone
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────
OUTPUT_DIR = os.getenv("OUTPUT_DIR", ".")

DISCLAIMER = (
    "INTERNAL USE ONLY. "
    "Information derived from publicly available sources within the stated observation window. "
    "Data may be incomplete, delayed, or subject to revision. "
    "No warranty as to accuracy or completeness. "
    "Execution and procurement decisions remain the responsibility of the relevant reader."
)

# ── Sector taxonomy — fixed order, ALL shown even if empty ──────────────────
SECTORS = [
    {
        "icon": "⚡",
        "name": "Energy",
        "subsectors": [
            "Oil & Gas",
            "LNG",
            "Refining & Petrochemicals",
            "Renewables",
            "Hydrogen & Ammonia",
            "Power & Transmission",
            "Water & Desalination",
        ],
    },
    {
        "icon": "⛏️",
        "name": "Mining & Metals",
        "subsectors": [
            "Mine Development",
            "Processing & Smelting",
            "Critical Minerals",
        ],
    },
    {
        "icon": "🌾",
        "name": "Agriculture",
        "subsectors": [
            "Fertilizer Plants",
            "Grain & Food Infrastructure",
            "Irrigation & Water",
        ],
    },
    {
        "icon": "🚢",
        "name": "Logistics & Infrastructure",
        "subsectors": [
            "Ports & Terminals",
            "Pipelines & Storage",
            "Rail & Inland Transport",
            "Shipyard & Fleet",
        ],
    },
]

# Stage badges
STAGE_BADGE = {
    "S1-Feasibility": "🔵S1",
    "S2-Development":  "🟡S2",
    "S3-Pre-FID":      "🟠S3",
    "S4-Tender":       "🟣S4",
    "S5-Awarded":      "🟢S5",
}

SCALE_LABEL = {
    "Large":   "◆◆◆",
    "Medium":  "◆◆◇",
    "Small":   "◆◇◇",
    "Unknown": "◇◇◇",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def stars(n: int) -> str:
    n = max(1, min(5, int(n or 3)))
    return "★" * n + "☆" * (5 - n)

def stage_badge(stage: str) -> str:
    return STAGE_BADGE.get(stage, stage)

def scale_label(scale: str) -> str:
    return SCALE_LABEL.get(scale, "◇◇◇")

def e(text) -> str:
    """HTML-escape a string."""
    return _html.escape(str(text or ""), quote=True)


# ── Card builder (replaces table row) ────────────────────────────────────────

def build_row(opp: dict) -> str:
    url     = e(opp.get("source_url", ""))
    name    = e(opp.get("project_name", "—"))
    country = e(opp.get("country", "—"))
    region  = e(opp.get("region", ""))
    scale   = scale_label(opp.get("scale", "Unknown"))
    stage   = stage_badge(opp.get("stage", ""))
    cred    = stars(opp.get("credibility", 3))
    desc    = e(opp.get("description", ""))
    src     = e(opp.get("source_name", ""))
    value   = e(opp.get("estimated_value", ""))

    name_link = f"<a href='{url}' target='_blank' rel='noopener noreferrer'>{name}</a>" if url else name

    meta_parts = [f"<strong>{stage}</strong>", f"{scale}", f"{country}"]
    if region:
        meta_parts.append(region)
    if value:
        meta_parts.append(f"<em>{value}</em>")
    meta_parts.append(cred)
    meta = " &nbsp;|&nbsp; ".join(meta_parts)

    return (
        f"<div style='margin:10px 0;padding:10px 12px;border-left:3px solid #888;border-bottom:1px solid #ddd;'>"
        f"<div style='font-size:1em;font-weight:bold;margin-bottom:4px;'>{name_link}</div>"
        f"<div style='font-size:0.85em;margin-bottom:6px;'>{meta}</div>"
        f"<div style='font-size:0.9em;line-height:1.5;'>{desc}</div>"
        f"<div style='font-size:0.78em;color:#999;margin-top:5px;'>Source: {src}</div>"
        f"</div>\n"
    )


# ── Section builder ────────────────────────────────────────────────────────────

def build_section(sector: dict, opps_by_subsector: dict) -> str:
    icon = sector["icon"]
    name = sector["name"]
    subsectors = sector["subsectors"]

    total = sum(len(opps_by_subsector.get(s, [])) for s in subsectors)
    count_label = f"[{total}]" if total else "[0]"

    parts = []
    parts.append(
        f"<h3 style='margin:24px 0 10px 0;border-bottom:2px solid #999;padding-bottom:6px;'>"
        f"{icon} {e(name)} <span style='font-weight:normal;font-size:0.85em;color:#888'>{count_label}</span>"
        f"</h3>"
    )

    for sub in subsectors:
        rows = opps_by_subsector.get(sub, [])

        parts.append(
            f"<h4 style='margin:16px 0 6px 0;color:#555;font-size:0.95em;font-weight:bold;'>"
            f"{e(sub)}"
            f"</h4>"
        )

        if not rows:
            parts.append(
                "<div style='color:#999;font-size:0.88em;padding:2px 0 2px 8px;'>"
                "No signals today.</div>"
            )
            continue

        for opp in rows:
            parts.append(build_row(opp))

    return "\n".join(parts)


# ── Legend ────────────────────────────────────────────────────────────────────

def build_legend() -> str:
    return """
<div style='font-size:0.82em;color:#666;margin:10px 0 20px 0;line-height:1.8;'>
<strong>Stage:</strong>
🔵S1 Feasibility &nbsp;|&nbsp;
🟡S2 Development &nbsp;|&nbsp;
🟠S3 Pre-FID &nbsp;|&nbsp;
🟣S4 Tender &nbsp;|&nbsp;
🟢S5 Awarded
&nbsp;&nbsp;&nbsp;
<strong>Scale:</strong>
◆◆◆ Large (&gt;$500M) &nbsp;|&nbsp;
◆◆◇ Medium ($50–500M) &nbsp;|&nbsp;
◆◇◇ Small (&lt;$50M) &nbsp;|&nbsp;
◇◇◇ Unknown
&nbsp;&nbsp;&nbsp;
<strong>Cred:</strong> ★★★★★ = project owner / EPC contractor &nbsp;|&nbsp;
★★★★☆ = specialist media / equipment / multilateral &nbsp;|&nbsp;
★★★☆☆ = broad industry media
</div>
""".strip()


# ── Summary bar ───────────────────────────────────────────────────────────────

def build_summary(opps: list) -> str:
    total   = len(opps)
    by_stage = defaultdict(int)
    by_sector = defaultdict(int)
    for o in opps:
        by_stage[o.get("stage", "?")] += 1
        by_sector[o.get("sector", "?")] += 1

    stage_order = ["S5-Awarded", "S4-Tender", "S3-Pre-FID", "S2-Development", "S1-Feasibility"]
    stage_str = " &nbsp;|&nbsp; ".join(
        f"{STAGE_BADGE.get(s, s)} {by_stage[s]}"
        for s in stage_order if by_stage.get(s)
    )

    sector_str = " &nbsp;|&nbsp; ".join(
        f"{k}: {v}" for k, v in sorted(by_sector.items())
    )

    return f"""
<div style='border:1px solid #ccc;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:0.88em;'>
<strong>TODAY'S SCAN</strong> &nbsp; {total} opportunities identified<br>
<span style='color:#555;'>{stage_str}</span><br>
<span style='color:#777;'>{sector_str}</span>
</div>
""".strip()


# ── Tenders & contract awards by industry ────────────────────────────────────
# Every open tender (any source) and every official award notice (World Bank, EU TED,
# UK Find a Tender) goes here instead of the key-project sections, grouped by industry
# and biggest first, so bidders and suppliers can scan one list.

OFFICIAL_PREFIXES = ("wb-", "ted-", "fts-")
EXTRA_INDUSTRIES = [{"icon": "🧪", "name": "Chemicals"}, {"icon": "🏗️", "name": "Other"}]


def is_deal(opp: dict) -> bool:
    return opp.get("stage") == "S4-Tender" or str(opp.get("article_id", "")).startswith(OFFICIAL_PREFIXES)


def unique_deals(opps: list) -> list:
    seen, out = set(), []   # TED lists some notices on two publication days
    for o in opps:
        if not is_deal(o):
            continue
        k = (o.get("source_url") or "", (o.get("project_name") or "").strip().lower())
        if k[0] in seen or k[1] in seen:
            continue
        seen.update(x for x in k if x)
        out.append(o)
    return out


def money(usd) -> str:
    try:
        usd = float(usd or 0)
    except (TypeError, ValueError):
        return ""
    if not usd:
        return ""
    if usd >= 1e9:
        return f"US${usd / 1e9:.1f}bn"
    if usd >= 1e6:
        return f"US${usd / 1e6:.0f}m"
    return f"US${usd / 1e3:.0f}k"


def build_deal_row(opp: dict) -> str:
    url = e(opp.get("source_url", ""))
    name = e(opp.get("project_name", "—"))
    name_link = f"<a href='{url}' target='_blank' rel='noopener noreferrer'>{name}</a>" if url else name
    awarded = opp.get("stage") == "S5-Awarded"
    parts = [e(opp.get("country") or "")]
    value = money(opp.get("contract_value_usd"))
    if value:
        parts.append(f"<strong>{value}</strong>")
    deadline = opp.get("deadline") or ""
    if not awarded and deadline:
        try:
            deadline = datetime.strptime(deadline[:10], "%Y-%m-%d").strftime("%d %b %Y")
        except ValueError:
            pass
        parts.append(f"<strong>Bids due {e(deadline)}</strong>")
    who = opp.get("company_name") if awarded else opp.get("buyer")
    if who and str(who).strip().lower() not in ("n/a", "unknown", "none"):
        parts.append(("Won by " if awarded else "Buyer: ") + e(who))
    parts.append(f"<span style='color:#999;'>{e(opp.get('source_name', ''))}</span>")
    meta = " &nbsp;·&nbsp; ".join(p for p in parts if p)
    return (
        f"<div style='padding:7px 10px;border-bottom:1px solid #e5e5e5;'>"
        f"<div style='font-size:0.95em;font-weight:bold;'>{name_link}</div>"
        f"<div style='font-size:0.82em;color:#555;margin-top:2px;'>{meta}</div>"
        f"</div>\n"
    )


def build_deals(deals: list) -> str:
    def value_of(o):
        try:
            return float(o.get("contract_value_usd") or 0)
        except (TypeError, ValueError):
            return 0.0

    known = {x["name"] for x in SECTORS}
    by_ind = defaultdict(list)
    for o in deals:
        sec = o.get("sector") or "Other"
        by_ind[sec if sec in known or sec == "Chemicals" else "Other"].append(o)

    n_open = sum(1 for o in deals if o.get("stage") == "S4-Tender")
    n_awd = sum(1 for o in deals if o.get("stage") == "S5-Awarded")
    parts = [
        "<h2 id='wtp-tenders' style='margin:30px 0 6px 0;'>📋 TENDERS &amp; CONTRACT AWARDS BY INDUSTRY</h2>",
        f"<div style='font-size:0.85em;color:#666;margin:0 0 10px 0;'>{n_open} open tenders and {n_awd} contract awards"
        + (f", plus {len(deals) - n_open - n_awd} planned procurement" + ("s" if len(deals) - n_open - n_awd > 1 else "") if len(deals) - n_open - n_awd else "") + ". "
        "Official notices from EU TED, UK Find a Tender and World Bank procurement, plus tenders reported in the press. "
        "Bid documents, lots and full deadlines are on the source notice (click the project name).</div>",
    ]
    if not deals:
        parts.append("<div style='color:#999;font-size:0.88em;padding:2px 0 2px 8px;'>No tenders or official awards today.</div>")
        return "\n".join(parts)
    for ind in SECTORS + EXTRA_INDUSTRIES:
        rows = by_ind.get(ind["name"], [])
        if not rows:
            continue
        tenders = sorted((o for o in rows if o.get("stage") == "S4-Tender"), key=value_of, reverse=True)
        awards = sorted((o for o in rows if o.get("stage") == "S5-Awarded"), key=value_of, reverse=True)
        planned = sorted((o for o in rows if o.get("stage") not in ("S4-Tender", "S5-Awarded")), key=value_of, reverse=True)
        parts.append(
            f"<h3 style='margin:22px 0 8px 0;border-bottom:2px solid #999;padding-bottom:6px;'>{ind['icon']} {e(ind['name'])} "
            f"<span style='font-weight:normal;font-size:0.85em;color:#888'>[{len(tenders)} open · {len(awards)} awarded"
            + (f" · {len(planned)} planned" if planned else "") + "]</span></h3>"
        )
        for label, group in (("🟣 Open tenders", tenders), ("🟢 Contract awards", awards), ("🟠 Planned procurement (tender to follow)", planned)):
            if group:
                parts.append(f"<h4 style='margin:12px 0 4px 0;color:#555;font-size:0.92em;'>{label}</h4>")
                parts.extend(build_deal_row(o) for o in group)
    return "\n".join(parts)


# ── Full post ─────────────────────────────────────────────────────────────────

def build_post(opps: list, date_str: str) -> str:
    deals = unique_deals(opps)
    # Index by sector → subsector (key projects: everything except the tender/award list)
    index = defaultdict(lambda: defaultdict(list))
    for opp in opps:
        if is_deal(opp):
            continue
        sector  = opp.get("sector", "Unknown")
        subsec  = opp.get("subsector", "Other")
        index[sector][subsec].append(opp)

    today_display = datetime.strptime(date_str, "%Y-%m-%d").strftime("%d %B %Y")

    header = f"""<div class='wtp-bbg'>

<h1 style='margin:0 0 6px 0;'>WORLDTRADEPRO // GLOBAL PROJECT PROCUREMENT RADAR</h1>

<div style='color:#555;font-size:0.88em;margin:0 0 16px 0;'>
<strong>DATE (UTC):</strong> {today_display} &nbsp;|&nbsp;
<strong>OBSERVATION WINDOW:</strong> Past 36 hours &nbsp;|&nbsp;
<strong>OPPORTUNITIES:</strong> {len(opps)}
</div>

<hr style='margin:14px 0;border-color:#ddd;'>

<div style='font-size:0.85em;color:#666;margin:0 0 14px 0;'>
<strong>About this report</strong><br>
Daily scan of project procurement signals across Energy, Mining &amp; Metals, Agriculture, and Logistics &amp; Infrastructure.
Sources include project owners, EPC contractors, specialist media, and multilateral agencies.
Each row represents one identified project opportunity with stage classification and source credibility rating.<br><br>
<strong>Who this is for:</strong>
EPC contractors, equipment suppliers, project finance teams, and business development professionals
tracking large capital project opportunities in commodities and infrastructure sectors.
</div>

<hr style='margin:14px 0;border-color:#ddd;'>
"""

    map_cta = f"""
<div style='background:#0a2148;border-radius:8px;padding:14px 18px;margin:16px 0;color:#cdd8ea;'>
<strong style='color:#fff;'>📍 See these signals on the map</strong><br>
<span style='font-size:0.88em;'>Explore all {len(opps)} opportunities plotted by location, filtered by sector or stage —</span>
<a href='https://{WP_DOMAIN}/intelligence-map/' target='_blank' rel='noopener noreferrer' style='color:#c8a94a;font-weight:bold;'>Open Intelligence Map →</a>
</div>
""".strip()

    summary = build_summary(opps)
    n_open = sum(1 for o in deals if o.get("stage") == "S4-Tender")
    if deals:
        summary += (f"\n<div style='font-size:0.88em;margin:-8px 0 16px 0;'>📋 <strong>{n_open} open tenders · {sum(1 for o in deals if o.get('stage') == 'S5-Awarded')} contract awards</strong>"
                    f" by industry — <a href='#wtp-tenders'>jump to the list ↓</a></div>")
    legend  = build_legend()

    sections = []
    for sector in SECTORS:
        sub_index = index.get(sector["name"], {})
        sections.append(build_section(sector, sub_index))

    footer = f"""
<hr style='margin:20px 0;border-color:#ddd;'>
<div style='font-size:0.78em;color:#999;'>
<strong>DISCLAIMER</strong><br>
{e(DISCLAIMER)}
</div>

</div>"""

    # ── Schema JSON-LD for SEO ────────────────────────────────────────────────
    kw_set = set()
    kw_set.update(["EPC", "EPCI", "FEED", "FID", "tender", "procurement",
                   "project opportunity", "capital project", "infrastructure",
                   "commodity", "supply chain", "EPC contractor", "equipment supplier"])
    kw_set.update(["feasibility", "development", "pre-FID", "awarded",
                   "contract award", "newbuild", "construction"])
    for opp in opps:
        if opp.get("country"):
            kw_set.add(opp["country"])
        if opp.get("region"):
            kw_set.add(opp["region"])
        if opp.get("sector"):
            kw_set.add(opp["sector"])
        if opp.get("subsector"):
            kw_set.add(opp["subsector"])
        # 所有项目名都提取专有名词
        if opp.get("project_name"):
            for w in opp["project_name"].split():
                clean = w.strip(".,;:()'\"")
                if len(clean) > 3 and clean[0].isupper() and not clean.isupper():
                    kw_set.add(clean)
        # description里的专有名词也提取
        if opp.get("description"):
            for w in opp["description"].split():
                clean = w.strip(".,;:()'\"")
                if len(clean) > 4 and clean[0].isupper() and not clean.isupper():
                    kw_set.add(clean)
        # source_name也加进去
        if opp.get("source_name"):
            kw_set.add(opp["source_name"])
        stage = opp.get("stage", "")
        if stage == "S4-Tender":
            kw_set.add("EPC tender")
        elif stage == "S5-Awarded":
            kw_set.add("contract awarded")
        elif stage == "S3-Pre-FID":
            kw_set.add("FID decision")

    keywords_str = ", ".join(sorted(kw for kw in kw_set if kw and len(kw.strip()) > 2))

    import json as _json
    schema_data = {
        "@context": "https://schema.org",
        "@type": "DiscussionForumPosting",
        "headline": f"Global Project Procurement Radar — {today_display}",
        "datePublished": date_str,
        "author": {"@type": "Person", "name": "chief_editor"},
        "keywords": keywords_str,
        "url": f"https://{WP_DOMAIN}/forum/forum/industry-newsletter/"
    }
    # Schema存储到wp_options（不写入帖子正文）
    _schema_json = _json.dumps(schema_data, ensure_ascii=False)

    return (
        header
        + map_cta
        + summary
        + legend
        + "<h2 style='margin:26px 0 4px 0;'>🎯 KEY PROJECTS</h2>\n"
        + "\n".join(sections)
        + "\n" + build_deals(deals)
        + footer
    ), _schema_json


# ── Main ─────────────────────────────────────────────────────────────────

def run(input_file: str = None, date_str: str = None,
        preview: bool = False) -> str:

    if not date_str:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not input_file:
        input_file = os.path.join(OUTPUT_DIR, f"opportunities_{date_str}.json")

    if not os.path.exists(input_file):
        print(f"ERROR: Input file not found: {input_file}")
        return ""

    with open(input_file, encoding="utf-8") as f:
        opps = json.load(f)

    print(f"Loaded {len(opps)} opportunities from {input_file}")

    result = build_post(opps, date_str)
    post_html, schema_json = result if isinstance(result, tuple) else (result, None)

    out_path = os.path.join(OUTPUT_DIR, f"post_{date_str}.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(post_html)
    print(f"Saved → {out_path}")

    if preview:
        webbrowser.open(f"file:///{os.path.abspath(out_path)}")
        print("Opened in browser.")

    return post_html, schema_json





# ── Schema存储 ───────────────────────────────────────────────────────────────
def api_store_schema(topic_id, schema_json):
    import json as _j
    from urllib.request import urlopen, Request as _Req
    url = f"https://{WP_DOMAIN}/wp-json/wtp/v1/asgaros/schema?secret={os.environ.get('WTP_BOT_SECRET', '')}"
    payload = _j.dumps({"topic_id": topic_id, "schema": schema_json}).encode("utf-8")
    req = _Req(url, data=payload,
               headers={"Content-Type": "application/json"},
               method="POST")
    try:
        with urlopen(req, timeout=20) as resp:
            return _j.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ⚠️  Schema存储失败: {e}")
        return None

# ── Forum posting ────────────────────────────────────────────────────────────

import requests
from requests.auth import HTTPBasicAuth

WP_DOMAIN  = os.getenv("WP_DOMAIN",  "worldtradepro.com")
WP_USER    = os.getenv("WP_USER",    "chief_editor")
WP_APP_PASS = os.getenv("WP_APP_PASS")
FORUM_ID   = int(os.getenv("FORUM_ID_EPC", "28"))


def post_to_forum(html_body: str, date_str: str) -> dict:
    if not WP_APP_PASS:
        raise RuntimeError("Missing WP_APP_PASS environment variable")

    title   = f"Global Project Procurement Radar — {date_str} (UTC)"
    api_url = f"https://{WP_DOMAIN}/wp-json/wtp/v1/asgaros/topic"
    payload = {"forum_id": FORUM_ID, "title": title, "text": html_body}

    r = requests.post(
        api_url, json=payload,
        auth=HTTPBasicAuth(WP_USER, WP_APP_PASS),
        timeout=20
    )
    if r.status_code != 201:
        raise RuntimeError(f"Post failed: {r.status_code} {r.text[:300]}")

    data = r.json()
    print(f"✅ Posted → topic_id={data.get('topic_id')}  url={data.get('url','')}")
    return data


# ── CLI update (add --post flag) ──────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="EPC Radar Post Builder")
    parser.add_argument("--date",    type=str, default=None,
                        help="Date (YYYY-MM-DD), defaults to today")
    parser.add_argument("--input",   type=str, default=None,
                        help="Custom input opportunities JSON file")
    parser.add_argument("--preview", action="store_true",
                        help="Open rendered post in browser after building")
    parser.add_argument("--post",    action="store_true",
                        help="Post to worldtradepro.com forum after building")
    args = parser.parse_args()

    if not args.date:
        args.date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    result = run(
        input_file=args.input,
        date_str=args.date,
        preview=args.preview,
    )
    html_body, schema_json = result if isinstance(result, tuple) else (result, None)

    if args.post and html_body:
        print("Posting to forum...")
        data = post_to_forum(html_body, args.date)
        # 发帖成功后存储Schema到wp_options
        if data and schema_json:
            topic_id = data.get("topic_id")
            if topic_id:
                api_store_schema(topic_id, schema_json)
                print(f"✅ Schema已存储 topic_id={topic_id}")
