# -*- coding: utf-8 -*-
"""
Crawl compliance helpers shared by fetcher.py and source_register.py.

- Honest User-Agent (identifies us, gives a contact).
- robots.txt gate (cached per origin). Fails open only on network errors /
  missing robots.txt (404), fails closed when robots.txt says Disallow.
- TDM reservation check (/.well-known/tdmrep.json, tdm-reservation header).
"""
import json
import os
import urllib.robotparser
from urllib.parse import urlparse

import requests

BOT_NAME = "WorldTradeProBot"
CONTACT  = os.getenv("BOT_CONTACT", "contact@worldtradepro.com")
USER_AGENT = f"{BOT_NAME}/1.0 (+https://worldtradepro.com/sources/; {CONTACT})"

# Set ROBOTS_ENFORCE=0 only for debugging.
ROBOTS_ENFORCE = os.getenv("ROBOTS_ENFORCE", "1") != "0"

AI_AGENTS = ["GPTBot", "ClaudeBot", "anthropic-ai", "CCBot", "Google-Extended",
             "PerplexityBot", "Bytespider", "Applebot-Extended"]

_robots_cache = {}   # origin -> (RobotFileParser | None, status)


def origin(url):
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def _load_robots(url):
    o = origin(url)
    if o in _robots_cache:
        return _robots_cache[o]
    rp, status = None, "error"
    try:
        r = requests.get(o + "/robots.txt", timeout=10,
                         headers={"User-Agent": USER_AGENT})
        if r.status_code == 200 and "html" not in r.headers.get("content-type", "").lower():
            rp = urllib.robotparser.RobotFileParser()
            rp.parse(r.text.splitlines())
            status = "ok"
        elif r.status_code in (401, 403):
            status = "forbidden"      # treat as a refusal
        elif r.status_code == 200:
            status = "html"           # soft-404, no robots policy
        else:
            status = "none"           # 404 etc: no policy published
    except Exception:
        status = "error"
    _robots_cache[o] = (rp, status)
    return _robots_cache[o]


def robots_allows(url):
    """True if we may fetch `url`. Honours our own bot name, then '*'."""
    if not ROBOTS_ENFORCE:
        return True
    rp, status = _load_robots(url)
    if status == "forbidden":
        return False
    if rp is None:
        return True
    return rp.can_fetch(BOT_NAME, url)


def robots_status(url):
    return _load_robots(url)[1]


def robots_ai_blocked(url):
    """Which known AI/TDM crawlers are fully disallowed at the site root."""
    rp, _ = _load_robots(url)
    if rp is None:
        return []
    root = origin(url) + "/"
    return [a for a in AI_AGENTS if not rp.can_fetch(a, root)]


def tdm_reserved(url):
    """True if the site publishes a TDMRep reservation (tdm-reservation = 1)."""
    o = origin(url)
    try:
        r = requests.get(o + "/.well-known/tdmrep.json", timeout=8,
                         headers={"User-Agent": USER_AGENT})
        if r.status_code == 200:
            data = json.loads(r.text)
            rules = data if isinstance(data, list) else [data]
            return any(str(x.get("tdm-reservation")) == "1" for x in rules)
    except Exception:
        pass
    return False
