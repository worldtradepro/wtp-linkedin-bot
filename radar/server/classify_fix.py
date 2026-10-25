#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar - sector / sub-sector check before publishing
========================================================
The analyzer's sub-sector label comes from a language model and is sometimes wrong or too coarse:
hospitals filed under "Rail & Inland Transport", battery parks under "Power & Transmission", a
hydrogen plant under "Oil & Gas", LNG carrier orders under "LNG". This module reads the project
name and description and corrects the label with fixed rules (no model call):

  strong evidence in the text -> that industry, whatever the label says;
  a label without evidence    -> kept only if the text does not name another industry or a subject
                                 outside this dataset (hospital, airport, road, water works ...);
                                 otherwise the sub-sector is emptied (shown as "not stated").

The same rules classify the projects on the site's /projects/ pages (wtp_seo_row_industries() in the
"WTP SEO Pages" snippet); both were checked on 12 months of data on 2026-10-10. Keep them in step.

fix(opp)       -> (sector, subsector) to store for one opportunity
apply(opps)    -> corrects a list in place, returns how many rows changed (run_pipeline.py calls it before publishing)
off_topic(opp) -> True for a subject the site does not cover (airport, hospital, road, bridge, sewage works ...);
split(opps)    -> (kept, dropped): run_pipeline.py publishes only the kept ones (owner's decision, 2026-10-10).
Data centres are an industry of their own (Logistics & Infrastructure / Data Centers), not off-topic.
Rows already on the site were corrected once on 2026-10-10 through PATCH /wtp/v1/opportunities (347 of 3,135).
"""
import re

# label = what the pipeline's sub-sector says (the only rule used by snippet v15)
SUB = {'wind': r'wind', 'solar': r'solar', 'battery-storage': r'battery|energy storage',
       'lng': r'\blng\b', 'oil-gas': r'^oil (&|&amp;|and) gas$|upstream', 'refining-petrochemicals': r'refin|petrochem', 'hydrogen-ammonia': r'hydrogen|ammonia',
       'power-transmission': r'^power|transmission|nuclear|\bgrid\b', 'mining': r'\bmine|mining|mineral|smelt', 'ports': r'\bports?\b', 'rail': r'\brail',
       'shipbuilding': r'shipyard|fleet|shipbuild', 'pipelines': r'pipeline', 'fertilizer': r'fertili', 'data-centers': r'data cent'}
SUB_RENEW = r'wind|solar|renewable|battery|energy storage|geothermal|hydropower|\bhydro\b'

METAL = r'lithium|nickel|\bgold\b|rare earths?|alumina|\bzinc\b|copper|cobalt|sugar|\bmetals?\b|eudialyte|vanadium|graphite|silver|\btin\b'
# STRONG: the text alone is enough to put the project in the industry
STRONG = {
    'wind': r'\bwind\b|windfarm|windpark',
    'solar': r'\bsolar\b|photovolta|\bcsp\b',
    'battery-storage': r'\bbess\b|batter(y|ies) (energy )?(storage|project|system|park|platform)|flow battery|energy storage|battery storage',
    'lng': r'\blng\b|liquefied natural gas|\bfsru\b|\bflng\b|regasif',
    'hydrogen-ammonia': r'hydrogen|ammonia|electroly[sz]er|vätgas|wasserstoff|e-methanol|e-fuels?\b',
    'refining-petrochemicals': r'petrochem|\bcracker\b|polyethylene|polypropylene|olefin|aromatics|methanol plant',   # + refinery, see below
    'oil-gas': r'oil ?field|gas ?field|\bfpso\b|\bfso\b|drilling rig|\brigs?\b|upstream|offshore (field|platform|structures?)|oil (and|&) gas (project|field|contract|development)|\bgas (processing|plant|compress)|deepwater|field (development|redevelopment)|compressor (plant|station)|\boil project|\bgas project',
    'power-grid': r'substation|transmission (line|project|network|system|assets)|interconnector|\bhvdc\b|\d ?kv\b|\bnuclear\b|\breactor\b|\bccgt\b|combined[- ]cycle|gas-fired|coal-fired|\biwpp\b|transformers?\b|switchgear|lng-to-power|thermal power|electricity (distribution|transmission)|power (line\b|lines\b(?! up)|link|barges?)|distribution network',
    'power-generic': r'power (plant|station|project)|\bgrid\b|\bipp\b',
    'mining': r'\bmines?\b|\bmining\b|smelter|concentrator|tailings|(lithium|copper|nickel|gold|iron ore|bauxite|alumina|rare earths?|graphite|uranium|coal|zinc|cobalt|manganese|polymetallic|vanadium|phosphate|potash|tin) (mine|mining|project|deposit|refinery|refining|operation|concentrate)|critical minerals?|longwall|haul (truck|er)s?',
    'ports': r'\b(port|harbou?r)s? (expansion|development|upgrade|project|authority|infrastructure|rehabilitation|transformation|modernis|moderniz)|container terminal|\bberths?\b|\bquay\b|dredging (works|project|contract)|deep[- ]?water port|\bseaport\b|harbou?r works|export terminal expansion|wind port',
    'rail': r'\brail(way|ways|s)?\b|\bmetro\b|\bmrt\b|\btram|locomotive|rolling stock|high[- ]speed (rail|line|train)|s-bahn|subway|monorail|\betcs\b|\bcbtc\b|\bemus?\b|catenary|light rail|\blrt\b',
    'shipbuilding': r'newbuild|shipyard|\bvessels?\b|tankers?\b|bulkers?\b|containerships?|container ships?|\bvlccs?\b|\bvlgcs?\b|\bpctcs?\b|ferr(y|ies)\b|\bdwt\b|\bteu\b|suezmax|aframax|ultramax|kamsarmax|newcastlemax|\b(lng|lpg|gas|bulk|car|ammonia|ethane|lco2|co2|vehicle|ore) carriers?\b|\btugs?\b|dredger|\bbarges?\b',
    'pipelines': r'pipeline(?!s? of)(?<!order pipeline)(?<!project pipeline)',
    'fertilizer': r'fertili[sz]er|\burea\b|\bnpk\b',
    'data-centers': r'data ?cent(er|re)s?\b|\bhyperscale\b',
}
RENEW = r'renewable|hydro(power|electric)|pumped (hydro|storage)|geotherm|biomass|biogas|tidal|wave energy|green energy|\bhydro\b'
# WEAK: not enough on its own, but it confirms the label
WEAK = {
    'wind': r'renewable|turbine', 'solar': r'renewable', 'battery-storage': r'batter|storage',
    'lng': r'\bgas\b|liquef|\btrains?\b|terminal',
    'hydrogen-ammonia': r'\bh2\b|fuel cell|\bsaf\b|e-saf|green fuel',
    'refining-petrochemicals': r'refin|chemical|polymer|plant|complex',
    'oil-gas': r'\boil\b|\bgas\b|offshore|petro|field|aramco|adnoc|sonatrach|decommission|subsea|drilling|\bccs\b|carbon capture|ethane|sbm offshore|aker|saipem',
    'power-transmission': r'power|electric|\bppa\b|hydro|\bdam\b|cable|energy|pumped',
    'mining': r'mineral|refiner|alcoa|rio tinto|\bvale\b|anode|processing|\bmill\b|\bsalt\b|hatch|autonomous|electric haul|steel|alumin|coal|phosphate|potash|metals?',
    'ports': r'\bports?\b|harbou?r|terminal|jetty|shore power',
    'rail': r'station|\bline\b|fleet|signalling|freight|transit|electrification|fare|corridor|\btrains?\b|\bwagons?\b|transnet|chsra',
    'shipbuilding': r'order|yard|heavy industries|fleet|charter|floater|\bhull\b|shipbuilding|\bflng\b|\bfsru\b|\bfpso\b',
    'pipelines': r'pipe', 'fertilizer': r'nitrate|phosph|ammonia|potash', 'data-centers': r'\bai\b|compute|server|colocation',
}
# subjects that are not what these pages are about: a label without strong evidence is dropped
NEG = (r'hospital|klinikum|school|housing|stadium|\bhotel|airport|aviation village|\btower\b|residential|museum|universit|campus|wastewater|waste water|sewage|sewer|'
       r'drinking water|water supply|water treatment|groundwater|wodoci|ujęci|pumping station|highway|motorway|\broads?\b|\bbridges?\b|military|missile|warship|frigate|'
       r'detention|immigration|prison|cement plant|health (complex|cent)')
# Subjects this dataset is not about (owner 2026-10-10): such a row is not published at all - unless the text names one of
# our industries, the row is an agriculture one (a slaughterhouse "on the X road"), or it is about desalination / irrigation.
# Data centres are NOT here: they are an industry of their own.
DROP = (r'hospital|klinikum|\bclinic|\bschools?\b|\bhousing\b|residential|stadium|\bhotels?\b|airport|aviation village|museum|universit|wastewater|waste water|sewage|'
        r'sewer|drinking water|water supply|water treatment|groundwater|wodoci|ujęci|pumping station|highway|motorway|\broads?\b|\bbridges?\b|military|missile|warship|'
        r'frigate|detention (expansion|cent|facilit)|immigration detention|\bprisons?\b')
DROP_KEEP = r'desalinat|irrigat'
LNG_SHIP = r'lng[- ](carriers?|vessels?|newbuilds?|newbuildings?|bunkering|bunker|tankers?|powered|fuell?ed|dual[- ]fuel|ready|shipping|capable)|(newbuild|new) lng (carriers?|vessels?)|lng and flng orders'
ADDITIVE_ONLY = {'pipelines', 'ports'}   # naming a pipeline / a port does not contradict another label



def label(x):
    s = (x.get('subsector') or '').lower().strip()
    out = {k for k, rx in SUB.items() if s and re.search(rx, s)}
    if 'mining' in (x.get('sector') or '').lower():
        out.add('mining')
    return out


# 2026-10-15 (owner): news about an existing plant that is not a project - a fire, a leak, an outage, a halt, a court
# order, flow or export volumes, shares and earnings. Kept when the text also names project work (repair, rebuild,
# contract, tender, expansion ...): "reconstruction after missile strikes" is a project, "brief fire at refinery" is not.
# Restarts and turnarounds stay: they buy equipment and services.
NOT_PROJECT = (r"\b(fires?|blaze|explosions?|blast)\b|\bhalt(s|ed|ing)?\b|\bshut(s|ting)? (down )?(by|after|over|due)\b|\bsanctions shut\b|"
               r"\boutages?\b|\bsuspend(s|ed)? (operations?|production|output)\b|\bthroughput\b|\b(exports?|imports?|output|flows?) (rose|fell|jumped|dropped|surged|slumped|hit)\b|"
               r"\bshares\b|\bshare (sale|price)\b|\bearnings\b|\bquarterly (results|profit)\b|\bleaks?\b|\bspills?\b|\bderail\w*|\bcourt (order|ruling)\b|\bdebt halt\b")
PROJECT_WORK = (r"\b(reconstruct\w*|repairs?|rebuild\w*|build\w*|construct\w*|epc|contracts?|award\w*|tenders?|expan\w*|develop\w*|fid|"
                r"upgrade\w*|install\w*|orders?|supply|feed|approv\w*|refurbish\w*|new)\b")


def not_project(x):
    t = (x.get('project_name', '') + ' . ' + (x.get('description') or '')).lower()
    return bool(re.search(NOT_PROJECT, t)) and not re.search(PROJECT_WORK, t)


def off_topic(x):
    """True for a row that should not be published at all (see DROP, and not_project above)."""
    if not_project(x):
        return True
    t = (x.get('project_name', '') + ' . ' + (x.get('description') or '')).lower()
    if not re.search(DROP, t) or re.search(DROP_KEEP, t):
        return False
    if 'agricultur' in (x.get('sector') or '').lower():
        return False
    return not industries(x)


def industries(x):
    t = (x.get('project_name', '') + ' . ' + (x.get('description') or '')).lower()
    is_mining = 'mining' in (x.get('sector') or '').lower()
    ev = set()
    for k, rx in STRONG.items():
        tt = re.sub(LNG_SHIP, ' ', t) if k == 'lng' else t
        if k == 'rail' and re.search(r'\blng\b|liquef', t):
            continue                                   # LNG "trains"
        if re.search(rx, tt):
            ev.add(k)
    ship = 'shipbuilding' in ev
    # a fuel or a cargo is not the project: LNG / ammonia ships are shipbuilding only, unless a terminal or plant is named
    if ship and 'lng' in ev and not re.search(r'fsru|flng|regasif|liquefaction|terminal|\bplant\b|export|import|\btrains?\b|lng project', t):
        ev.discard('lng')
    if ship and 'hydrogen-ammonia' in ev and not re.search(r'\bplant\b|electroly|production|terminal|pipeline|\bhub\b|factory|hydrogen project|ammonia project', t):
        ev.discard('hydrogen-ammonia')
    if ship and 'wind' in ev and not re.search(r'wind ?(farm|park|project|power|turbine)|offshore wind|floating wind', t):
        ev.discard('wind')                              # wind-assisted propulsion
    if re.search(r'\bepcic?\b', t) and not ev & {'wind', 'solar'}:
        ev.add('oil-gas')
    # a mine or a refinery named only as the place or the customer of something else
    if 'mining' in ev and not is_mining and ev & {'shipbuilding', 'solar', 'wind', 'battery-storage', 'ports'}:
        ev.discard('mining')
    if re.search(r'\brefiner(y|ies)\b', t) and not re.search(METAL, t) and not is_mining and not ev & {'hydrogen-ammonia', 'power-grid', 'power-generic', 'shipbuilding', 'ports', 'mining'}:
        ev.add('refining-petrochemicals')
    gen = bool(ev & {'wind', 'solar', 'battery-storage'}) or bool(re.search(RENEW, t)) or 'hydrogen-ammonia' in ev
    power = 'power-grid' in ev or ('power-generic' in ev and not gen)
    ev -= {'power-grid', 'power-generic'}
    if power:
        ev.add('power-transmission')
    if 'mining' in ev and re.search(r'drilling', t):
        ev.discard('oil-gas') if not re.search(r'\boil\b|\bgas\b|offshore', t) else None
    neg = bool(re.search(NEG, t))
    lab = label(x)
    out = set(ev)
    for k in lab - ev:
        if neg:
            continue
        if re.search(WEAK[k], t) or not (ev - ADDITIVE_ONLY):
            out.add(k)
    if out & {'wind', 'solar', 'battery-storage'} or re.search(RENEW, t) or (_label_renew(x) and not ev and not neg):
        out.add('renewable-energy')
    return out


def _label_renew(x):
    s = (x.get('subsector') or '').lower().strip()
    return bool(s and re.search(SUB_RENEW, s))


# industry -> (sector, sub-sector label used on the map and in the Weekly)
TARGET = {
    'shipbuilding': ('Logistics & Infrastructure', 'Shipyard & Fleet'),
    'lng': ('Energy', 'LNG'),
    'hydrogen-ammonia': ('Energy', 'Hydrogen & Ammonia'),
    'refining-petrochemicals': ('Energy', 'Refining & Petrochemicals'),
    'oil-gas': ('Energy', 'Oil & Gas'),
    'battery-storage': ('Energy', 'Battery Storage'),
    'wind': ('Energy', 'Wind'),
    'solar': ('Energy', 'Solar'),
    'power-transmission': ('Energy', 'Power & Transmission'),
    'mining': ('Mining & Metals', 'Mine Development'),
    'fertilizer': ('Agriculture', 'Fertilizer Plants'),
    'rail': ('Logistics & Infrastructure', 'Rail & Inland Transport'),
    'ports': ('Logistics & Infrastructure', 'Ports & Terminals'),
    'pipelines': ('Logistics & Infrastructure', 'Pipelines & Storage'),
    'data-centers': ('Logistics & Infrastructure', 'Data Centers'),
    'renewable-energy': ('Energy', 'Renewables'),
}
PRIORITY = list(TARGET)                      # when a project is in several industries, the first one names it
MINING_SUBS = ('Mine Development', 'Processing & Smelting', 'Critical Minerals')
VAGUE = {'', 'unknown', 'epc', 'infrastructure development', 'energy generation', 'infrastructure', 'construction', 'n/a', 'other'}


# the same thing worded differently -> one label
FOLD = {
    'refinery development': 'Refining & Petrochemicals', 'refinery upgrade': 'Refining & Petrochemicals', 'refining': 'Refining & Petrochemicals',
    'petrochemicals': 'Refining & Petrochemicals', 'lng infrastructure': 'LNG', 'regasification': 'LNG', 'liquefaction': 'LNG', 'fsru': 'LNG',
    'offshore wind': 'Wind', 'onshore wind': 'Wind', 'energy storage': 'Battery Storage', 'hydrogen': 'Hydrogen & Ammonia', 'ammonia': 'Hydrogen & Ammonia',
    'power': 'Power & Transmission', 'power transmission': 'Power & Transmission', 'transmission': 'Power & Transmission', 'nuclear': 'Power & Transmission',
    'grid': 'Power & Transmission', 'substation': 'Power & Transmission', 'drilling': 'Oil & Gas', 'subsea': 'Oil & Gas', 'upstream': 'Oil & Gas',
    'gas processing': 'Oil & Gas', 'fpso': 'Oil & Gas', 'desalination': 'Water & Desalination', 'shipping': 'Shipyard & Fleet',
}


def fix(x):
    """(sector, subsector) for one opportunity."""
    sector, sub = _fix(x)
    sub = FOLD.get(sub.lower(), sub)
    return sector, ('' if sub.lower() in VAGUE else sub)


def _fix(x):
    sector, sub = (x.get('sector') or '').strip(), (x.get('subsector') or '').strip()
    inds = industries(x)
    if not inds:
        text = (x.get('project_name', '') + ' . ' + (x.get('description') or '')).lower()
        if label(x) and re.search(NEG, text):
            return sector, ''                # the label was about something this text is not
        return sector, ('' if sub.lower() in VAGUE else sub)
    current = label(x)
    if _label_renew(x):
        current.add('renewable-energy')
    keep = [k for k in PRIORITY if k in inds and k in current]
    if _label_renew(x) and not keep and not inds & {'wind', 'solar', 'battery-storage', 'shipbuilding'}:
        return sector, sub                   # "Renewables" is only ever refined (wind / solar / storage), never turned into "power"
    if keep and not (keep == ['renewable-energy'] and inds & {'wind', 'solar', 'battery-storage', 'shipbuilding'}):
        # the label already names one of the project's industries: leave it (only tidy the sector)
        k = keep[0]
        new_sector = TARGET[k][0]
        return new_sector, sub
    k = next(k for k in PRIORITY if k in inds)
    new_sector, new_sub = TARGET[k]
    if k == 'mining' and sub in MINING_SUBS:
        new_sub = sub
    return new_sector, new_sub


def split(opps):
    """(kept, dropped): dropped = rows about a subject the site does not cover."""
    kept, dropped = [], []
    for o in opps:
        (dropped if off_topic(o) else kept).append(o)
    return kept, dropped


def apply(opps):
    """Correct sector / subsector of each opportunity in place; return the number of rows changed."""
    changed = 0
    for o in opps:
        sector, sub = fix(o)
        if sector != (o.get('sector') or '').strip() or sub != (o.get('subsector') or '').strip():
            o['sector'], o['subsector'] = sector, sub
            changed += 1
    return changed
