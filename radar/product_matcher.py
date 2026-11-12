"""Product matcher (2026-11-12): for each Project Alerts member, decide which projects will buy the member's product.

Owner: layer 2 of the product - "my market" = every project the AI judges will buy the product; the member does nothing, alerts
come automatically when a project's buying window opens. The site gives, per member, the profile and the candidate projects
(same project types or the member's words) not yet judged for this profile (/wtp/v1/pm-queue); the AI first sorts the product
into a class (main equipment / package / small equipment / bulk / EPC / services - it decides WHEN the window is open: main
equipment is specified at FEED, valves and bulk are bought after the EPC award), then judges the projects in batches: will it
buy this product, which package, who places the order. Results go to /wtp/v1/pm-apply. Claude Code CLI on the owner's
subscription, like project_builder.py.

Usage: python radar/product_matcher.py [--order 9] [--limit 600] [--batch 15]
Env: WTP_BOT_SECRET, CLAUDE_CODE_OAUTH_TOKEN (Actions), PM_MODEL (default claude-sonnet-5-5)
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('PB_MODEL', os.environ.get('PM_MODEL', 'claude-sonnet-5-5'))
import project_builder as pb   # site() and claude() helpers

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = []

CLASS_PROMPT = """Sort this supplier's product into ONE class. Reply with JSON only: {"class": "<key>", "reason": "<one sentence>"}
Classes:
{classes}
The class decides when a capital project buys it: main equipment and packaged units are specified during FEED and bought by the
EPC winner; small equipment, valves, instruments and bulk materials are bought after the EPC award during detailed design.

Supplier says: {summary}
Products: {products}
"""

MATCH_PROMPT = """You help an equipment supplier find the capital projects that will buy its product.
Supplier: {summary}
Products: {products}
Region preference: {region}

For EACH project below decide whether it will need to buy this product:
- "yes": the project's scope clearly requires it (e.g. a gas turbine supplier and a combined-cycle plant, an LNG train with gas
  turbine compressor drivers, a gas-fired data-centre power plant).
- "maybe": it could need it depending on the design (e.g. a gas processing plant that may use turbine-driven compressors or
  on-site power), or the description is too thin to be sure.
- "no": the scope does not use it (e.g. electrolysers for green ammonia, a transmission line, a solar farm, a share deal).
Judge the physical scope, not the words. Ignore projects already in operation.
For yes/maybe also give: package = what exactly they would buy (e.g. "2 x heavy-duty gas turbines for the 1.2 GW CCGT",
"turbine drivers for the LNG refrigerant compressors"), buyer = who places the order (the EPC contractor if named or
"the EPC winner", the owner, or the packager), why = one short sentence.

Reply with JSON only: {"results": [{"project_id": 0, "fit": "yes|maybe|no", "package": "", "buyer": "", "why": ""}]}

PROJECTS:
{projects}
"""


def fmt(p):
    return json.dumps({'project_id': int(p['id']), 'name': p['name'], 'operator': p.get('operator'), 'country': p.get('country'),
                       'facility': p.get('facility'), 'unit': p.get('unit_no'), 'capacity': p.get('capacity'), 'sector': p.get('sector'),
                       'milestone': p.get('milestone'), 'procurement': p.get('proc'), 'contractors': p.get('contractors'),
                       'summary': (p.get('summary') or '')[:400]}, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--order', type=int, default=0)
    ap.add_argument('--limit', type=int, default=1500)
    ap.add_argument('--batch', type=int, default=15)
    args = ap.parse_args()
    q = {'limit': args.limit}
    if args.order:
        q['order'] = args.order
    j = pb.site('GET', 'pm-queue', q)
    classes = j.get('classes') or {}
    stats = []
    for o in j.get('orders') or []:
        prof = o['profile']
        if not prof.get('summary') or prof['summary'].upper().startswith('TEST ORDER'):
            stats.append(f"#{o['order']}: no real product, skipped")
            continue
        cls = o.get('class') or ''
        if not cls:
            a = pb.claude(CLASS_PROMPT.replace('{classes}', '\n'.join(f'- {k}: {v}' for k, v in classes.items()))
                          .replace('{summary}', prof['summary']).replace('{products}', ', '.join(prof.get('products') or [])))
            cls = (a or {}).get('class') if (a or {}).get('class') in classes else 'main_equipment'
            print(f"#{o['order']} class: {cls} - {(a or {}).get('reason', '')}")
            pb.site('POST', 'pm-apply', body={'order': o['order'], 'phash': o['phash'], 'class': cls, 'results': []})
        todo = o.get('todo') or []
        yes = maybe = 0
        for i in range(0, len(todo), args.batch):
            chunk = todo[i:i + args.batch]
            ans = pb.claude(MATCH_PROMPT.replace('{summary}', prof['summary']).replace('{products}', ', '.join(prof.get('products') or []))
                            .replace('{region}', prof.get('region') or 'all regions').replace('{projects}', '\n'.join(fmt(p) for p in chunk)))
            if not ans:
                FAILS.append(f"#{o['order']} batch {i // args.batch}: no answer")
                continue
            ids = {int(p['id']) for p in chunk}
            res = [r for r in ans.get('results') or [] if str(r.get('project_id', '')).isdigit() and int(r['project_id']) in ids and r.get('fit') in ('yes', 'maybe', 'no')]
            yes += sum(r['fit'] == 'yes' for r in res); maybe += sum(r['fit'] == 'maybe' for r in res)
            pb.site('POST', 'pm-apply', body={'order': o['order'], 'phash': o['phash'], 'results': res})
            for r in res:
                if r['fit'] != 'no':
                    name = next(p['name'] for p in chunk if int(p['id']) == int(r['project_id']))
                    print(f"  {r['fit']:5} #{r['project_id']} {name[:50]:50} | {r.get('package', '')[:60]}")
        stats.append(f"#{o['order']} ({cls}): {len(todo)} judged, {yes} yes, {maybe} maybe")
    print('\n'.join(stats))
    os.makedirs(os.path.join(HERE, '..', 'state'), exist_ok=True)
    nl = chr(10)
    with open(os.path.join(HERE, '..', 'state', 'product_matcher_last_run.md'), 'w', encoding='utf-8') as f:
        f.write('# product matcher ' + time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()) + nl + nl + nl.join('- ' + s for s in stats) + nl + nl)
        f.write(nl.join('- ' + x for x in FAILS + pb.FAILS) or 'no failures')
        f.write(nl)


if __name__ == '__main__':
    main()
