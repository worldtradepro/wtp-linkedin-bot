# -*- coding: utf-8 -*-
"""
Schema v2 (revised after the 2026-10-20 sample review).

Two groups of facts:
  PROJECT facts - stay true even if the news changes: owner, site, capacity,
                  contractors, financiers, reference_id.
  EVENT facts   - belong to ONE news item: event_type, key_dates, deal value,
                  description. Only trusted when the page reports the same event.

Also: a guard that stops a description from being the publisher's headline
retyped, and a fact-built fallback description.
"""
import json, re
import difflib

EVENT_TYPES = ["Tender", "Award", "FID", "Financing", "Permit/Approval", "Study/FEED",
               "Construction start", "Delivery/Commissioning", "Acquisition/Sale",
               "Renewal/Extension", "Offtake/Supply agreement", "Equipment/vessel order", "Other"]

PROJECT_FIELDS = ["owner", "site", "capacity", "contractors", "financiers", "reference_id"]
EVENT_FIELDS = ["event_type", "key_dates", "value_amount", "value_unit", "value_currency", "value_basis"]
LIST_FIELDS = ("key_dates", "contractors", "financiers")

V2_FIELDS = {
    "owner":          "string - project owner / sponsor / developer; empty if not stated",
    "site":           "string - city, field, port or site inside the country; empty if not stated",
    "capacity":       "string - capacity with unit exactly as stated, e.g. '4.8 GWh', '1.5 Mtpa'; empty if not stated",
    "contractors":    "array of {'name': '...', 'role': 'EPC|FEED|licensor|supplier|shipyard|consultant|...'}; [] if none",
    "financiers":     "array of lender / investor names; [] if none",
    "reference_id":   "string - tender number or official project ID if stated; empty otherwise",
    "event_type":     "string - what THIS news item reports, one of: " + " | ".join(EVENT_TYPES)
                      + ". An MoU or agreement is not an Award; a vessel delivery is Delivery/Commissioning; a sale of a company or asset is Acquisition/Sale",
    "key_dates":      "array of {'label': 'bid deadline|FID expected|completion|award|...', 'date': 'as stated'}; [] if none",
    "value_amount":   "string - number only, TOTAL value of the deal/project as stated (e.g. '600'); empty if not stated. NEVER a unit price (per MW, per tonne ...)",
    "value_unit":     "string - one of: thousand | million | billion | unstated  (the scale of value_amount)",
    "value_currency": "string - ISO code (USD, EUR, GBP ...), empty if not stated",
    "value_basis":    "string - one of: reported | estimated | unstated",
}

DESCRIPTION_RULE = (
    "Write 'description' in your OWN words from the facts: one plain sentence, max 120 chars, "
    "naming the company, the project and what happened. Do NOT reuse the article's headline or any run of "
    "5+ consecutive words from it. No publisher name, no hype."
)


def _norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split()


def strip_publisher(title):
    """'Foo bar - Oil & Gas Journal' -> 'Foo bar'"""
    return re.split(r"\s+[-–|]\s+(?=[^-–|]{3,40}$)", title or "")[0]


def longest_run(a, b):
    wa, wb = _norm(a), _norm(b)
    sm = difflib.SequenceMatcher(None, wa, wb, autojunk=False)
    return sm.find_longest_match(0, len(wa), 0, len(wb)).size


def close_to_title(desc, title):
    t = strip_publisher(title)
    if not desc or not t:
        return False
    ratio = difflib.SequenceMatcher(None, " ".join(_norm(desc)), " ".join(_norm(t))).ratio()
    return ratio >= 0.6 or longest_run(desc, t) >= 5


EVENT_LABEL = {
    "Tender": "Tender issued", "Award": "Contract awarded", "FID": "FID update",
    "Financing": "Financing agreed", "Permit/Approval": "Approval granted",
    "Study/FEED": "Study / FEED under way", "Construction start": "Construction under way",
    "Delivery/Commissioning": "Delivered / commissioned", "Acquisition/Sale": "Acquisition / sale",
    "Renewal/Extension": "Agreement renewed", "Offtake/Supply agreement": "Supply agreement signed",
    "Equipment/vessel order": "Order placed",
}
STAGE_LABEL = {
    "S1-Feasibility": "Feasibility stage", "S2-Development": "Development stage",
    "S3-Pre-FID": "Pre-FID", "S4-Tender": "Tender stage", "S5-Awarded": "Awarded / under way",
}
UNIT_SUFFIX = {"thousand": "k", "million": "M", "billion": "bn"}


def _amount(o):
    unit = UNIT_SUFFIX.get((o.get("value_unit") or "").lower())
    amt = (o.get("value_amount") or "").strip()
    if not unit or not amt:
        return ""
    return f"{(o.get('value_currency') or '').strip()} {amt}{unit}".strip()


def _looks_like_percent(x):
    return bool(re.match(r"^\s*[\d.,]+\s*%", x or ""))


ROLE_WORDS = {"EPC": "EPC", "FEED": "FEED", "licensor": "licensor", "supplier": "supplier", "shipyard": "yard",
              "consultant": "advisor", "awardee": "winner"}


def _short(x, n=38):
    x = re.sub(r"\s+", " ", (x or "").strip())
    return x if len(x) <= n else x[: n - 1].rstrip() + "…"


def _contractor(o):
    cs = o.get("contractors") or []
    if not cs or not isinstance(cs[0], dict) or not cs[0].get("name"):
        return ""
    name = _short(cs[0]["name"])
    role = ROLE_WORDS.get((cs[0].get("role") or "").strip())
    extra = f" +{len(cs) - 1}" if len(cs) > 1 else ""
    return f"{name}{extra}" + (f" ({role})" if role and role != "winner" else "")


def _deadline(o):
    for d in o.get("key_dates") or []:
        if isinstance(d, dict) and "deadline" in (d.get("label") or "").lower() and d.get("date"):
            return str(d["date"])[:10]
    return ""


def template_description(o, event_ok=True):
    """Deterministic description built only from structured facts, always <= 120 chars.
    Facts are added in priority order and dropped from the end when the line gets too long:
    label: project (owner), place | capacity | value | contractor | bid deadline.
    event_ok=False (page did not confirm this event) or event_type 'Other' -> neutral 'Project update',
    and no event-level facts (value, contractor, deadline) are written."""
    et = (o.get("event_type") or "") if event_ok else ""
    if et in EVENT_LABEL:
        head = EVENT_LABEL[et]
    elif not event_ok or et == "Other":
        head = "Project update"
    else:
        head = STAGE_LABEL.get(o.get("stage") or "", "Project update")
    pn = (o.get("project_name") or "").strip()
    who = (o.get("owner") or o.get("company_name") or "").strip()
    site = (o.get("site") or "").strip()
    country = (o.get("country") or "").strip()
    if site and (site.lower() in pn.lower() or pn.lower() in site.lower()):
        site = ""                      # site just repeats the project name
    if site and country and country.lower() in site.lower():
        country = ""                   # site already ends with the country
    if country and country.lower() in pn.lower():
        country = ""                   # project name already carries the country
    loc = []
    for x in (site, country):
        if x and x.lower() not in ("unknown", "global") and x.lower() not in [y.lower() for y in loc]:
            loc.append(x)
    cap = (o.get("capacity") or "").strip()
    if _looks_like_percent(cap) or (cap and re.sub(r"[^a-z0-9]", "", cap.lower()) in re.sub(r"[^a-z0-9]", "", pn.lower())):
        cap = ""
    val = _amount(o) if event_ok else ""
    con = _contractor(o) if event_ok and et in ("Award", "Equipment/vessel order", "Study/FEED", "Offtake/Supply agreement",
                                                  "Construction start", "Delivery/Commissioning", "Acquisition/Sale") else ""
    due = _deadline(o) if event_ok and et == "Tender" else ""
    due = f"bids due {due}" if due else ""

    def build(use):
        out = f"{head}: {pn}" + (f" ({who})" if who else "")
        if "loc" in use and loc:
            out += ", " + ", ".join(loc)
        for key, val_ in (("cap", cap), ("val", val), ("con", con), ("due", due)):
            if key in use and val_:
                out += f" · {val_}"
        return out

    for use in (("loc", "cap", "val", "con", "due"), ("loc", "cap", "val", "con"), ("loc", "cap", "val"),
                ("loc", "cap"), ("loc",), ()):
        out = build(use)
        if len(out) <= 120:
            return out
    return out[:120]


def guard_description(o, title):
    """Daily pipeline: replace a headline-hugging description with a fact-built one."""
    if close_to_title(o.get("description", ""), title):
        o["description_original_model"] = o.get("description", "")
        o["description"] = template_description(o)
        o["description_source"] = "template"
    else:
        o.setdefault("description_source", "model")
    return o


def derive_source_type(o):
    cat = (o.get("source_category") or "")
    url = (o.get("source_url") or "")
    if "news.google." in url:
        return "aggregator"
    if cat in ("Media",):
        return "media"
    if cat in ("Official", "Multilateral") or any(
            d in url for d in ("worldbank.org", "europa.eu", "find-tender", "iatiregistry", "ifc.org")):
        return "official"
    return "company"


EVENT_PHRASE = {
    "Tender": "tender issued", "Award": "contract awarded", "FID": "FID update", "Financing": "financing agreed",
    "Permit/Approval": "approval granted", "Study/FEED": "study or FEED under way", "Construction start": "construction under way",
    "Delivery/Commissioning": "delivered or commissioned", "Acquisition/Sale": "acquisition or sale",
    "Renewal/Extension": "agreement renewed", "Offtake/Supply agreement": "supply agreement signed",
    "Equipment/vessel order": "order placed",
}
STAGE_WORD = {"S1-Feasibility": "feasibility", "S2-Development": "development", "S3-Pre-FID": "pre-FID",
              "S4-Tender": "tender", "S5-Awarded": "awarded"}


def _as_list(v):
    if isinstance(v, str) and v.strip():
        try:
            v = json.loads(v)
        except Exception:
            return []
    return v if isinstance(v, list) else []


def fact_card(o, event_ok=True, limit=250):
    """Richer deterministic description (2026-10-22): short fact sentences built ONLY from our structured fields - no
    publisher text. Parts are added in priority order and dropped from the end when the text would exceed `limit`.
    Example: 'Battery Storage in Latrobe Valley, Australia. Owner: Engie. Capacity: 150MW/150MWh. Stage: development.'"""
    pn = (o.get("project_name") or "").strip()
    country = (o.get("country") or "").strip()
    site = (o.get("site") or o.get("city") or "").strip()
    if site and (site.lower() in pn.lower() or pn.lower() in site.lower()):
        site = ""
    if site and country and country.lower() in site.lower():
        country = ""
    loc = []
    for x in (site, country):
        if x and x.lower() not in ("unknown", "global") and x.lower() not in [y.lower() for y in loc]:
            loc.append(x)
    sector = (o.get("subsector") or o.get("sector") or "").strip()
    first = (sector or "Project") + (" in " + ", ".join(loc) if loc else "")
    who = (o.get("owner") or o.get("company_name") or "").strip()
    et = (o.get("event_type") or "") if event_ok else ""
    parts = [first + "."]
    if who:
        in_cons = any(isinstance(c, dict) and (c.get("name") or "").strip().lower() == who.lower() for c in _as_list(o.get("contractors")))
        parts.append(("Owner" if o.get("owner") and not in_cons else "Company") + ": " + _short(who, 60) + ".")
    if et in EVENT_PHRASE:
        ev = "Reported: " + EVENT_PHRASE[et]
        val = _amount(o) if event_ok else ""
        if val:
            ev += ", " + val
        parts.append(ev + ".")
    cap = (o.get("capacity") or "").strip()
    if cap and not _looks_like_percent(cap) and re.sub(r"[^a-z0-9]", "", cap.lower()) not in re.sub(r"[^a-z0-9]", "", pn.lower()):
        parts.append("Capacity: " + _short(cap, 40) + ".")
    cons = [c for c in _as_list(o.get("contractors")) if isinstance(c, dict) and c.get("name")]
    if cons and event_ok:
        parts.append("Contractors: " + ", ".join(
            _short(c["name"], 32) + (" (" + ROLE_WORDS.get((c.get("role") or "").strip(), (c.get("role") or "").strip()) + ")"
                                     if (c.get("role") or "").strip() and (c.get("role") or "").strip() != "awardee" else "")
            for c in cons[:2]) + ".")
    fins = [f.get("name") if isinstance(f, dict) else f for f in _as_list(o.get("financiers"))]
    fins = [str(f) for f in fins if f]
    if fins and event_ok:
        parts.append("Financiers: " + ", ".join(_short(f, 32) for f in fins[:2]) + ".")
    due = ""
    for d in _as_list(o.get("key_dates")):
        if isinstance(d, dict) and d.get("date") and event_ok:
            lab = (d.get("label") or "date").strip().lower()
            if "deadline" in lab or "bid" in lab:
                due = "Bid deadline: " + str(d["date"])[:20] + "."
                break
    if due:
        parts.append(due)
    stage = STAGE_WORD.get(o.get("stage") or "")
    if stage and not et:
        parts.append("Stage: " + stage + ".")
    out = ""
    for p in parts:
        cand = (out + " " + p).strip()
        if len(cand) > limit and out:
            break
        out = cand
    return out[:limit]


def _nice_amount(o):
    unit = (o.get("value_unit") or "").lower()
    amt = (o.get("value_amount") or "").strip().replace(",", "")
    cur = (o.get("value_currency") or "").strip()
    try:
        x = float(amt)
    except Exception:
        return _amount(o)
    mult = {"thousand": 1e3, "million": 1e6, "billion": 1e9}.get(unit)
    if not mult:
        return ""
    x *= mult
    for div, suf in ((1e9, "bn"), (1e6, "M"), (1e3, "k")):
        if x >= div:
            return (cur + " " + ("%.2f" % (x / div)).rstrip("0").rstrip(".") + suf).strip()
    return (cur + " " + "%g" % x).strip()


def fact_text(o, event_ok=True, limit=250):
    """Sentence-style description (2026-10-22) from structured facts only. It does not repeat what the page chips already show
    (industry, stage, scale). One lead sentence about the event/company/place, then short facts, dropped from the end when long."""
    pn = (o.get("project_name") or "").strip()
    country = (o.get("country") or "").strip()
    site = (o.get("site") or o.get("city") or "").strip()
    if site and (site.lower() in pn.lower() or pn.lower() in site.lower()):
        site = ""
    if site and country and country.lower() in site.lower():
        country = ""
    loc = []
    for x in (site, country):
        if x and x.lower() not in ("unknown", "global") and x.lower() not in [y.lower() for y in loc]:
            loc.append(x)
    first_loc = loc[0].lower() if loc else ""
    where = ((" " if first_loc.startswith(("near ", "at ", "off ", "offshore ", "outside ")) else " in ") + ", ".join(loc)) if loc else ""
    who = _short((o.get("owner") or o.get("company_name") or "").strip(), 60)
    if who.lower() == country.lower() or who.lower() in [x.lower() for x in loc]:
        who = ""                       # the model gave a country/place as owner
    long_who = len(who) > 34
    cons = [c for c in _as_list(o.get("contractors")) if isinstance(c, dict) and c.get("name")]
    in_cons = bool(who) and any((c.get("name") or "").strip().lower() == who.lower() for c in cons)
    if who and o.get("owner") and not in_cons and not long_who:
        ref = who + "’s project" + where
    elif who:
        ref = "the project" + where + " involving " + who
    else:
        ref = "the project" + where
    cap_ref = ref[0].upper() + ref[1:]
    et = (o.get("event_type") or "") if event_ok else ""
    val = _nice_amount(o) if event_ok else ""
    fins = [f.get("name") if isinstance(f, dict) else f for f in _as_list(o.get("financiers"))]
    fins = [_short(str(f), 32) for f in fins if f][:2]
    clist = [_short(c["name"], 46) + (" (" + ROLE_WORDS.get((c.get("role") or "").strip(), (c.get("role") or "").strip()) + ")"
             if (c.get("role") or "").strip() and (c.get("role") or "").strip() not in ("awardee",) else "") for c in cons[:3]]
    first_c = clist[0] if clist else ""
    rest_c = clist[1:]
    due = ""
    for d in _as_list(o.get("key_dates")):
        if isinstance(d, dict) and d.get("date") and event_ok and ("deadline" in (d.get("label") or "").lower() or "bid" in (d.get("label") or "").lower()):
            due = str(d["date"])[:20]
            break
    lead = {
        "Tender": "A tender has been issued for " + ref,
        "Award": "A contract for " + ref + " has been awarded",
        "FID": "An FID update was reported for " + ref,
        "Financing": "Financing has been agreed for " + ref,
        "Permit/Approval": cap_ref + " has received an approval",
        "Study/FEED": "A study or FEED is under way for " + ref,
        "Construction start": "Construction is under way on " + ref,
        "Delivery/Commissioning": cap_ref + " has been delivered or commissioned",
        "Acquisition/Sale": "An acquisition or sale involving " + ref + " was reported",
        "Renewal/Extension": "An agreement for " + ref + " was renewed",
        "Offtake/Supply agreement": "A supply agreement was signed for " + ref,
        "Equipment/vessel order": "An equipment or vessel order was placed for " + ref,
    }.get(et) or (cap_ref + " is on our tracker" + (". Details are not yet verified" if not event_ok and o.get("verification") in (None, "", "limited") else ""))
    if et == "Award" and first_c:
        lead += " to " + first_c
        clist = rest_c
    if et in ("Award", "Financing") and val:
        lead += ", valued at " + val if et == "Award" else " (" + val + ")"
    parts = [lead + "."]
    cap = (o.get("capacity") or "").strip()
    if cap and not _looks_like_percent(cap) and re.sub(r"[^a-z0-9]", "", cap.lower()) not in re.sub(r"[^a-z0-9]", "", pn.lower()):
        parts.append("Capacity " + _short(cap, 40) + ".")
    if et not in ("Award", "Financing") and val:
        parts.append("Value " + val + ".")
    if due:
        parts.append("Bids are due " + due + ".")
    if clist and event_ok:
        parts.append(("Other contractors: " if et == "Award" else "Contractors: ") + "; ".join(clist[:2]) + ".")
    if fins and event_ok:
        parts.append("Financing from " + " and ".join(fins) + ".")
    out = ""
    for p in parts:
        cand = (out + " " + p).strip()
        if len(cand) > limit and out:
            break
        out = cand
    return out[:limit]
