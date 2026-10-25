# -*- coding: utf-8 -*-
"""
Consistency audit of fields_v3='full' records (run after backfill_v3.py, before apply_v3.py).
The model's same-event check is not perfect: a record about 'RTE offshore wind MoU' once got the page of an
'ONGC pipeline contract'. A record keeps its event facts only if the new description / page summary / extracted
facts still share at least one distinctive word or number with the record's own project name or old description
(company names are ignored: the same company has many deals). Otherwise it is demoted to project_only
(project facts kept, event facts and the description neutralised).
Official API records are not touched.   Usage: python audit_v3.py
"""
import os, re, json, glob, shutil, collections

os.chdir(os.path.dirname(os.path.abspath(__file__)))
import fieldsv2

GEN = {"project", "projects", "plant", "farm", "park", "terminal", "facility", "station", "order", "orders",
       "services", "service", "contract", "contracts", "tender", "tenders", "newbuild", "newbuilds", "new",
       "power", "energy", "capacity", "supply", "agreement", "development", "expansion", "upgrade", "storage",
       "phase", "wind", "solar", "offshore", "onshore", "battery", "lng", "lpg", "gas", "oil", "carrier",
       "carriers", "vessel", "vessels", "epc", "epci", "feed", "fid", "award", "awarded", "financing", "wins",
       "secures", "signs", "signed", "with", "from", "for", "the", "and", "has", "have", "will", "been", "that",
       "this", "its", "are", "was", "first", "launches", "launched", "plans", "plan", "announces", "announced"}


def distinct(s):
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower())
            if t not in GEN and len(t) > 2 and not t.isdigit()}


def nums(s):
    return {t for t in re.findall(r"\d+(?:\.\d+)?", (s or "").replace(",", "")) if not re.fullmatch(r"(19|20)\d\d", t)}


def consistent(o, v):
    comp = (distinct(o.get("company_name")) | distinct(v.get("owner"))
            | {t for c in v.get("contractors", []) for t in distinct(c.get("name"))})
    a = (distinct(o["project_name"]) | distinct(o.get("description")) | nums(o.get("description"))
         | nums(o["project_name"])) - comp
    if not a:
        return True
    new = (distinct(v["description_v3"]) | nums(v["description_v3"]) | distinct(v.get("page_summary"))
           | nums(v.get("page_summary")) | distinct(v.get("owner"))
           | {t for c in v.get("contractors", []) for t in distinct(c.get("name"))}
           | nums(v.get("value_amount")) | distinct(v.get("capacity")) | nums(v.get("capacity")))
    return bool(a & new)


recs = {}
for f in sorted(glob.glob("data/opportunities_*.json")):
    x = json.load(open(f, encoding="utf-8"))
    for o in (x if isinstance(x, list) else x.get("opportunities", [])):
        recs.setdefault(o["source_url"], o)

d = json.load(open("data/backfill_v3.json", encoding="utf-8"))
shutil.copy2("data/backfill_v3.json", "data/backfill_v3_before_audit.json")
n = 0
demoted = []
for u, v in d.items():
    if v["fields_v3"] != "full" or v.get("source_kind") == "official_api" or u not in recs:
        continue
    o = recs[u]
    if consistent(o, v):
        continue
    for k in fieldsv2.EVENT_FIELDS:
        v.pop(k, None)
    merged = dict(o, **v)
    v.update(fields_v3="project_only", event_match="audit_demoted",
             description_v3=fieldsv2.template_description(merged, event_ok=False), description_source="template")
    n += 1
    demoted.append((o["project_name"], o.get("description", "")))
json.dump(d, open("data/backfill_v3.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("demoted", n)
print(dict(collections.Counter(v["fields_v3"] for v in d.values())))
for name, desc in demoted[:5]:
    print(" -", name[:40], "|", desc[:70])
