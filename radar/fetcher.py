#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Article Fetcher
============================
Reads source.txt + probe_report.txt, fetches articles via:
  - RSS / Atom feeds
  - WordPress REST API
  - HTML scraping (list page -> article page)
  - Google News RSS (for blocked/inaccessible sources)
  - html_weak: tries HTML, falls back to Google News

Applies keyword filtering, deduplicates against yesterday,
outputs articles_YYYY-MM-DD.json, maintains source_health.json.

Usage:
    python fetcher.py                        # full run
    python fetcher.py --dry-run              # fetch but don't save
    python fetcher.py --source "Saipem"      # single source test
    python fetcher.py --strategy google_news # test one strategy
"""

import os, re, sys, json, time, hashlib, socket, calendar, argparse, logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urljoin, quote_plus

import requests
import feedparser
import compliance
import threading
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
import warnings
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fetcher")

# ── Config ────────────────────────────────────────────────────────────────────
socket.setdefaulttimeout(14)

SOURCE_FILE     = os.getenv("SOURCE_FILE",    "source.txt")
PROBE_FILE      = os.getenv("PROBE_FILE",     "probe_report.txt")
HEALTH_FILE     = os.getenv("HEALTH_FILE",    "source_health.json")
OUTPUT_DIR      = os.getenv("OUTPUT_DIR",     ".")
KEYWORDS_FILE   = os.getenv("KEYWORDS_FILE",  "keywords.txt")
LOOKBACK_HOURS  = int(os.getenv("LOOKBACK_HOURS",   "36"))
MAX_LIST_LINKS  = int(os.getenv("MAX_LIST_LINKS",    "25"))
BODY_CHARS      = int(os.getenv("BODY_CHARS",        "1200"))
REQUEST_DELAY   = float(os.getenv("REQUEST_DELAY",   "1.5"))
ZERO_DAYS_WARN  = int(os.getenv("ZERO_DAYS_WARN",    "5"))
GLOBAL_WARN_PCT = float(os.getenv("GLOBAL_WARN_PCT", "0.30"))

HEADERS = {
    "User-Agent": compliance.USER_AGENT,   # honest bot identity (see compliance.py)
    "Accept-Language": "en,fr;q=0.9,ar;q=0.8,pt;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
feedparser.USER_AGENT = compliance.USER_AGENT

ARTICLE_PATH_SIGNALS = [
    "/news/", "/press/", "/media/", "/article/", "/release/",
    "/insight/", "/announcement/", "/story/", "/post/", "/update/",
    "/actualite/", "/comunicado/", "/noticias/", "/presse/",
    "/actualites/", "/investors/", "/newsroom/", "/press-release/",
    "/en/news/", "/media-centre/", "/press-releases/",
]


# ── Keywords ──────────────────────────────────────────────────────────────────

def load_keywords(path="keywords.txt"):
    positive, negative, current = [], [], None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line == "[positive]":   current = "positive"
            elif line == "[negative]": current = "negative"
            elif current == "positive":
                # Store (lowercase, original) tuple
                positive.append((line.lower(), line))
            elif current == "negative":
                negative.append((line.lower(), line))
    log.info(f"Keywords: {len(positive)} positive, {len(negative)} negative")
    return {"positive": positive, "negative": negative}


def passes_filter(title, body, keywords):
    """Returns (passes: bool, matched_kw: str).

    Short keywords (<=4 chars) and ALL-CAPS abbreviations use word-boundary
    matching to avoid substring false positives:
      'ree' in 'agree', 'sru' in 'infrastructure', 'mou' in 'amount',
      'epc' in 'expected', 'fid' in 'modified', etc.
    """
    title_l = title.lower()
    full_l  = f"{title} {body}".lower()

    def match(kw_lower, kw_orig, text):
        # Word boundary if: original is ALL-CAPS, or short (<= 4 chars)
        if len(kw_orig) <= 4 or kw_orig == kw_orig.upper():
            return bool(re.search(r'\b' + re.escape(kw_lower) + r'\b', text))
        return kw_lower in text

    for kw_lower, kw_orig in keywords["negative"]:
        if match(kw_lower, kw_orig, title_l):
            return False, f"neg:{kw_lower}"

    for kw_lower, kw_orig in keywords["positive"]:
        if match(kw_lower, kw_orig, full_l):
            return True, kw_lower

    return False, ""


# ── Source loader ─────────────────────────────────────────────────────────────

def load_sources(path):
    sources = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            sources.append({
                "category":    parts[0].strip(),
                "subcategory": parts[1].strip(),
                "name":        parts[2].strip(),
                "url":         parts[3].strip(),
                "credibility": int(parts[4].strip()) if len(parts) >= 5 else 3,
                "google_news": len(parts) >= 6 and parts[5].strip() == "google_news",
            })
    log.info(f"Sources loaded: {len(sources)}")
    return sources


# ── Probe report parser ───────────────────────────────────────────────────────

def load_probe_config(path):
    """
    Parse probe_report.txt -> {name: {strategy, fetch_url}}
    Strategies: rss | wp_json | html | html_weak | google_news
    """
    if not os.path.exists(path):
        log.warning(f"Probe file not found: {path} — all sources default to html")
        return {}

    with open(path, encoding="utf-8") as f:
        content = f.read()

    config = {}

    # RSS/WP entries:  "  Cat/Sub/Name   src_url  →  fetch_url"
    # Arrow may be Unicode → (U+2192) or ASCII ->
    for m in re.finditer(
        r'^\s{2}(\S+/\S+/\S[^\n]*?)\s+(https?://\S+)\s+(?:→|->)\s+(https?://\S+)',
        content, re.MULTILINE
    ):
        name      = m.group(1).split("/")[-1].strip()
        fetch_url = m.group(3).rstrip().rstrip('\r')
        strategy  = "wp_json" if "wp-json" in fetch_url else "rss"
        config[name] = {"strategy": strategy, "fetch_url": fetch_url}

    # HTML entries:  "  Cat/Sub/Name   url  [N article-like links found]"
    for m in re.finditer(
        r'^\s{2}(\S+/\S+/\S[^\n]*?)\s+(https?://\S+)\s+\[(\d+) article-like',
        content, re.MULTILINE
    ):
        name  = m.group(1).split("/")[-1].strip()
        count = int(m.group(3))
        if name not in config:
            config[name] = {
                "strategy":  "html" if count >= 2 else "html_weak",
                "fetch_url": m.group(2).rstrip().rstrip('\r'),
            }

    # HTML weak: "Page loaded but no article links detected"
    for m in re.finditer(
        r'^\s{2}(\S+/\S+/\S[^\n]*?)\s+(https?://\S+)\s+\[Page loaded but no',
        content, re.MULTILINE
    ):
        name = m.group(1).split("/")[-1].strip()
        if name not in config:
            config[name] = {"strategy": "html_weak", "fetch_url": m.group(2).rstrip().rstrip('\r')}

    # Google News entries
    for m in re.finditer(
        r'^\s{2}(\S+/\S+/\S[^\n]*?)\s+(https?://\S+)\s+\[Google News RSS\]',
        content, re.MULTILINE
    ):
        name = m.group(1).split("/")[-1].strip()
        config[name] = {"strategy": "google_news", "fetch_url": m.group(2).rstrip().rstrip('\r')}

    # Summary
    by_strat = {}
    for v in config.values():
        s = v["strategy"]
        by_strat[s] = by_strat.get(s, 0) + 1
    log.info(f"Probe config: {len(config)} entries — {by_strat}")
    return config


# ── Helpers ───────────────────────────────────────────────────────────────────

def url_hash(url):
    return hashlib.sha256(url.strip().encode()).hexdigest()[:12]

def now_utc():
    return datetime.now(timezone.utc)

def cutoff_dt():
    return now_utc() - timedelta(hours=LOOKBACK_HOURS)

def clean_text(raw):
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", text).strip()

def parse_feed_date(entry):
    if entry.get("published_parsed"):
        try:
            return datetime.fromtimestamp(
                calendar.timegm(entry.published_parsed), tz=timezone.utc
            )
        except Exception:
            pass
    return now_utc()

def make_article(source, uid, title, body, url, pub_dt, strategy, kw):
    return {
        "id":              uid,
        "title":           title,
        "summary":         body[:BODY_CHARS],
        "url":             url,
        "published":       pub_dt.strftime("%Y-%m-%d %H:%M"),
        "source_name":     source["name"],
        "source_category": source["category"],
        "source_sub":      source["subcategory"],
        "credibility":     source["credibility"],
        "fetch_strategy":  strategy,
        "matched_keyword": kw,
    }


def load_seen_urls(output_dir):
    """Load article IDs from the past 7 days for deduplication."""
    seen = set()
    for days_ago in range(1, 8):
        date_str = (now_utc() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        path = os.path.join(output_dir, f"articles_{date_str}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            seen.update(a["id"] for a in data)
        except Exception as e:
            log.warning(f"Could not load {path}: {e}")
    if seen:
        log.info(f"Dedup: {len(seen)} URLs from past 7 days")
    return seen


# URL date patterns: /2026/03/08/, -2026-03-08, /20260308-, /260308-
# Patterns ordered from most to least specific
# Each pattern yields (year, month, day) or (year, month) groups
_URL_DATE_RE = [
    # /2026/03/08/  or  /2026/03/08-
    (re.compile(r'/(\d{4})/(\d{2})/(\d{2})[/-]'), 3),
    # /2026/03/08  at end of string or before non-digit
    (re.compile(r'/(\d{4})/(\d{2})/(\d{2})(?:\D|$)'), 3),
    # -2026-03-08  or  _2026-03-08
    (re.compile(r'[/_-](\d{4})-(\d{2})-(\d{2})'), 3),
    # /20260308-
    (re.compile(r'/(\d{4})(\d{2})(\d{2})-'), 3),
    # /260308-  (yymmdd)
    (re.compile(r'[/_](\d{2})(\d{2})(\d{2})-'), 3),
    # /2026/03/  (year+month only, day defaults to 1)
    (re.compile(r'/(\d{4})/(\d{2})(?:/|$|\D)'), 2),
    # /2026/  (year only, month+day default to 1)
    (re.compile(r'/(\d{4})(?:/|$|\D)'), 1),
]

def extract_date_from_url(url):
    """Extract publish date from URL patterns. Returns datetime or None."""
    for pat, groups in _URL_DATE_RE:
        m = pat.search(url)
        if not m:
            continue
        g = m.groups()
        try:
            if groups == 3:
                if len(g[0]) == 2:  # yymmdd shortform
                    year, month, day = 2000 + int(g[0]), int(g[1]), int(g[2])
                else:
                    year, month, day = int(g[0]), int(g[1]), int(g[2])
            elif groups == 2:
                year, month, day = int(g[0]), int(g[1]), 1
            else:  # groups == 1
                year, month, day = int(g[0]), 1, 1

            if 2020 <= year <= 2030 and 1 <= month <= 12 and 1 <= day <= 31:
                return datetime(year, month, day, 12, 0, tzinfo=timezone.utc)
        except Exception:
            continue
    return None


# ── Fetchers ──────────────────────────────────────────────────────────────────

def fetch_rss(source, rss_url, keywords, seen):
    articles = []
    cutoff   = cutoff_dt()
    try:
        feed = feedparser.parse(rss_url)
    except Exception as e:
        log.debug(f"feedparser {source['name']}: {e}")
        return []

    for entry in feed.entries:
        title   = clean_text(entry.get("title", ""))
        url     = (entry.get("link") or "").strip()
        summary = clean_text(
            entry.get("summary") or entry.get("description") or ""
        )[:600]

        if not title or not url:
            continue
        if parse_feed_date(entry) < cutoff:
            continue
        uid = url_hash(url)
        if uid in seen:
            continue
        passes, kw = passes_filter(title, summary, keywords)
        if not passes:
            continue

        art = make_article(source, uid, title, summary, url, parse_feed_date(entry), "rss", kw)
        # 2026-10-15: a Google News search result names its real publisher (<source>Reuters</source>); keep that, not
        # the name of the company we searched for - "Dangote Refinery" was shown as the source of a Saudi power plant.
        pub = entry.get("source") or {}
        if "news.google." in url and pub.get("title"):
            art["source_name"] = clean_text(pub["title"])[:80]
            art["title"] = re.sub(r"\s+-\s+" + re.escape(art["source_name"]) + r"$", "", art["title"])
        articles.append(art)
    return articles


def fetch_wp_json(source, api_url, keywords, seen):
    articles = []
    cutoff   = cutoff_dt()
    try:
        r = requests.get(api_url, headers=HEADERS, timeout=12,
                         params={"per_page": 20, "orderby": "date", "order": "desc"})
        if r.status_code != 200:
            return []
        posts = r.json()
    except Exception as e:
        log.debug(f"wp_json {source['name']}: {e}")
        return []

    for post in posts:
        title   = clean_text(post.get("title", {}).get("rendered", ""))
        url     = post.get("link", "").strip()
        excerpt = clean_text(post.get("excerpt", {}).get("rendered", ""))[:600]
        try:
            pub_dt = datetime.fromisoformat(
                post.get("date_gmt", "")
            ).replace(tzinfo=timezone.utc)
        except Exception:
            pub_dt = now_utc()

        if not title or not url or pub_dt < cutoff:
            continue
        uid = url_hash(url)
        if uid in seen:
            continue
        passes, kw = passes_filter(title, excerpt, keywords)
        if not passes:
            continue
        articles.append(make_article(source, uid, title, excerpt, url, pub_dt, "wp_json", kw))
    return articles


def extract_article_links(html, base_url):
    soup   = BeautifulSoup(html, "lxml")
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    seen_h = set()
    results = []

    def is_article(href, text):
        if not href or len(text.strip()) < 20:
            return False
        if href.startswith("http") and origin not in href:
            return False
        return any(s in href.lower() for s in ARTICLE_PATH_SIGNALS)

    def add(href, text):
        if not href:
            return
        if href.startswith("/"):   href = origin + href
        elif not href.startswith("http"): href = urljoin(base_url, href)
        href = href.split("#")[0].rstrip("/")
        if href in seen_h or not is_article(href, text):
            return
        seen_h.add(href)
        results.append({"title": text.strip(), "url": href})

    # Semantic containers first
    for c in soup.find_all(
        ["article", "li", "div"],
        class_=re.compile(r"(news|press|article|post|item|entry|release|story|teaser)", re.I)
    ):
        a = c.find("a", href=True)
        if a:
            add(a["href"], a.get_text(separator=" ", strip=True))

    # Fallback: all <a> tags
    if len(results) < 3:
        for a in soup.find_all("a", href=True):
            add(a["href"], a.get_text(separator=" ", strip=True))

    return results[:MAX_LIST_LINKS]


def parse_date_from_page(soup, url):
    """Extract publish date from article page. Priority:
    1. <meta property="article:published_time">
    2. <time datetime="...">
    3. <meta name="date" / "pubdate" / "publish_date">
    4. JSON-LD datePublished
    5. URL pattern fallback
    Returns datetime (UTC) or None.
    """
    # 1. Open Graph / article meta
    for attr, name in [
        ("property", "article:published_time"),
        ("property", "og:article:published_time"),
        ("name",     "date"),
        ("name",     "pubdate"),
        ("name",     "publish_date"),
        ("name",     "publication_date"),
        ("itemprop", "datePublished"),
    ]:
        tag = soup.find("meta", {attr: name})
        if tag and tag.get("content"):
            try:
                raw = tag["content"].strip()
                # Handle ISO 8601 with or without timezone
                raw = re.sub(r"(\+\d{2}:\d{2}|Z)$", "", raw)
                dt = datetime.fromisoformat(raw)
                return dt.replace(tzinfo=timezone.utc)
            except Exception:
                continue

    # 2. <time datetime="...">
    for time_tag in soup.find_all("time", datetime=True):
        try:
            raw = time_tag["datetime"].strip()
            raw = re.sub(r"(\+\d{2}:\d{2}|Z)$", "", raw)
            dt = datetime.fromisoformat(raw[:19])
            return dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue

    # 3. JSON-LD
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            # May be a list or dict
            if isinstance(data, list):
                data = data[0] if data else {}
            raw = data.get("datePublished") or data.get("dateCreated") or ""
            if raw:
                raw = re.sub(r"(\+\d{2}:\d{2}|Z)$", "", raw)
                dt = datetime.fromisoformat(raw[:19])
                return dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue

    # 4. Plain text date patterns in page body
    # Covers formats like: 01.10.2025, October 1 2025, 1 Oct 2025, 2025-10-01
    _MONTHS = {
        'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,
        'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12,
        'january':1,'february':2,'march':3,'april':4,'june':6,
        'july':7,'august':8,'september':9,'october':10,'november':11,'december':12,
    }
    _TEXT_DATE_RE = [
        re.compile(r'(\d{1,2})[./](\d{1,2})[./](20\d{2})'),    # DD.MM.YYYY or DD/MM/YYYY
        re.compile(r'(20\d{2})-(\d{2})-(\d{2})'),               # YYYY-MM-DD
        re.compile(r'(20\d{2})/(\d{2})/(\d{2})'),               # YYYY/MM/DD
        re.compile(r'([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})'),  # Month DD, YYYY
        re.compile(r'(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})'),    # DD Month YYYY
        re.compile(r'([A-Za-z]{3})\s+(\d{1,2})\s+(20\d{2})'),      # MMM DD YYYY
    ]
    page_text = soup.get_text(separator=" ", strip=True)[:8000]
    for pat in _TEXT_DATE_RE:
        m = pat.search(page_text)
        if not m:
            continue
        g = m.groups()
        try:
            p = pat.pattern
            if '[./]' in p:                            # DD.MM.YYYY or DD/MM/YYYY
                day, month, year = int(g[0]), int(g[1]), int(g[2])
            elif p.startswith('(20') and '-' in p:    # YYYY-MM-DD
                year, month, day = int(g[0]), int(g[1]), int(g[2])
            elif p.startswith('(20') and '/' in p:    # YYYY/MM/DD
                year, month, day = int(g[0]), int(g[1]), int(g[2])
            elif p.startswith('([A-Za-z]{3,9})'):     # Month DD, YYYY
                month = _MONTHS.get(g[0].lower())
                if not month:
                    continue
                day, year = int(g[1]), int(g[2])
            elif '{3,9}' in p:                        # DD Month YYYY
                month = _MONTHS.get(g[1].lower())
                if not month:
                    continue
                day, year = int(g[0]), int(g[2])
            else:                                     # MMM DD YYYY
                month = _MONTHS.get(g[0].lower())
                if not month:
                    continue
                day, year = int(g[1]), int(g[2])

            if 2020 <= year <= 2030 and 1 <= month <= 12 and 1 <= day <= 31:
                return datetime(year, month, day, 12, 0, tzinfo=timezone.utc)
        except Exception:
            continue

    # 5. URL pattern fallback
    return extract_date_from_url(url)


BOT_WALL = re.compile(
    r"security service to protect|malicious bots?|verif(?:y|ies|ying) (?:that )?you are (?:not a bot|human)|"
    r"checking your browser|just a moment|access denied|enable javascript and cookies|cloudflare ray id|"
    r"please enable js|attention required",
    re.I,
)

_tl = threading.local()


def last_head():
    """Public headline material (title, og:title, meta description, first h1) of the last fetch_article call
    in this thread. Paywalled pages often show only this."""
    return getattr(_tl, "head", "")


def _collect_head(soup):
    parts = []
    t = soup.find("title")
    if t:
        parts.append(t.get_text(" ", strip=True))
    for sel in ('meta[property="og:title"]', 'meta[name="description"]', 'meta[property="og:description"]'):
        el = soup.select_one(sel)
        if el and el.get("content"):
            parts.append(el["content"])
    h1 = soup.find("h1")
    if h1:
        parts.append(h1.get_text(" ", strip=True))
    return re.sub(r"\s+", " ", " | ".join(x for x in parts if x))[:600]


def fetch_article(url):
    """Fetch article page. Returns (body_text, pub_datetime|None)."""
    _tl.head = ""
    if not compliance.robots_allows(url):
        return "", None
    try:
        r = requests.get(url, headers=HEADERS, timeout=12, allow_redirects=True)
        if r.status_code != 200:
            return "", None
        soup = BeautifulSoup(r.text, "lxml")

        # Extract date BEFORE removing tags (meta/time/script needed)
        pub_dt = parse_date_from_page(soup, url)
        _tl.head = _collect_head(soup)

        for tag in soup(["script","style","nav","header","footer",
                         "aside","figure","form","iframe"]):
            tag.decompose()
        body = None
        for sel in ["article", "main",
                    '[class*="article-body"]', '[class*="article-content"]',
                    '[class*="post-body"]',    '[class*="entry-content"]',
                    '[class*="story-body"]',   '[class*="content-body"]']:
            body = soup.select_one(sel)
            if body and len(body.get_text(strip=True)) > 100:
                break
        if not body:
            body = soup.find("body") or soup
        text = re.sub(r"\s+", " ", body.get_text(separator=" ", strip=True))[:BODY_CHARS]
        # A bot wall (Cloudflare / Akamai / "Just a moment...") returns 200 with an interstitial instead of the article;
        # that text must not reach the analyzer (2026-10-05: it became the description of three LinkedIn posts).
        if BOT_WALL.search(text[:600]):
            return "", pub_dt
        return text, pub_dt
    except Exception:
        return "", None


def fetch_html(source, list_url, keywords, seen):
    try:
        r = requests.get(list_url, headers=HEADERS, timeout=14, allow_redirects=True)
        if r.status_code != 200:
            return []
    except Exception as e:
        log.debug(f"html fetch {source['name']}: {e}")
        return []

    # Bot detection: if page text is very short, likely a JS/captcha wall
    page_text_len = len(BeautifulSoup(r.text, "lxml").get_text(strip=True))
    if page_text_len < 200:
        log.debug(f"  {source['name']}: bot wall detected ({page_text_len} chars) → Google News fallback")
        return fetch_google_news(source, keywords, seen)

    links = extract_article_links(r.text, list_url)
    if not links:
        return []

    log.debug(f"  {source['name']}: {len(links)} links found")

    cutoff = cutoff_dt()
    candidates = []
    for link in links:
        uid = url_hash(link["url"])
        if uid in seen:
            continue
        # URL date pre-filter: skip if URL contains a date older than cutoff
        url_date = extract_date_from_url(link["url"])
        if url_date and url_date < cutoff:
            continue
        passes, kw = passes_filter(link["title"], "", keywords)
        if passes:
            candidates.append({**link, "uid": uid, "kw": kw, "url_date": url_date})

    articles = []
    for item in candidates:
        time.sleep(REQUEST_DELAY)
        body, page_dt = fetch_article(item["url"])

        # Date resolution: page_dt > url_date > now_utc()
        # If body is empty (bot wall / fetch failed), don't use now_utc() as date —
        # use a sentinel far in the past so the article gets filtered out
        if not body:
            continue
        pub_dt = page_dt or item["url_date"] or now_utc()

        # Date filter: skip articles older than lookback window
        if pub_dt < cutoff:
            log.debug(f"  Skipped (old: {pub_dt.strftime('%Y-%m-%d')}): {item['url'][-60:]}")
            continue

        passes, kw = passes_filter(item["title"], body, keywords)
        if not passes:
            continue
        articles.append(make_article(
            source, item["uid"], item["title"], body,
            item["url"], pub_dt, "html", kw
        ))
    return articles


def build_google_news_url(company_name):
    query = quote_plus(f'"{company_name}"')
    return f"https://news.google.com/rss/search?q={query}&hl=en&gl=US&ceid=US:en"


def fetch_google_news(source, keywords, seen):
    rss_url  = build_google_news_url(source["name"])
    articles = fetch_rss(source, rss_url, keywords, seen)
    for a in articles:
        a["fetch_strategy"] = "google_news"
    return articles


def fetch_html_weak(source, list_url, keywords, seen):
    """Try HTML; if nothing, fall back to Google News."""
    articles = fetch_html(source, list_url, keywords, seen)
    if articles:
        return articles
    log.debug(f"  {source['name']}: html_weak empty → Google News fallback")
    return fetch_google_news(source, keywords, seen)


# ── Health tracker ────────────────────────────────────────────────────────────

def load_health(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def update_health(health, name, count):
    today = now_utc().strftime("%Y-%m-%d")
    e = health.get(name, {"last_seen": None, "zero_days": 0, "needs_reprobe": False})
    if count > 0:
        e["last_seen"]     = today
        e["zero_days"]     = 0
        e["needs_reprobe"] = False
    else:
        e["zero_days"] = e.get("zero_days", 0) + 1
        if e["zero_days"] >= ZERO_DAYS_WARN:
            e["needs_reprobe"] = True
    health[name] = e
    return health


def save_health(health, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(health, f, indent=2, ensure_ascii=False)


def print_health_report(health, total_sources):
    needs = [n for n, v in health.items() if v.get("needs_reprobe")]
    zero3 = sum(1 for v in health.values() if v.get("zero_days", 0) >= 3)

    if needs:
        log.warning(f"[HEALTH] {len(needs)} source(s) need re-probe:")
        for n in sorted(needs):
            log.warning(f"  • {n}  (zero_days={health[n]['zero_days']})")
        names_arg = ",".join(f'"{n}"' for n in sorted(needs))
        log.warning(f"[HEALTH] Run: python probe_sources.py --sources {names_arg}")

    pct = zero3 / max(total_sources, 1)
    if pct >= GLOBAL_WARN_PCT:
        log.warning(
            f"[HEALTH] {zero3}/{total_sources} sources ({pct:.0%}) have 3+ zero days "
            f"→ consider full re-probe: python probe_sources.py"
        )


# ── Main ──────────────────────────────────────────────────────────────────────

def run(dry_run=False, filter_source=None, filter_strategy=None):
    log.info(f"EPC Radar Fetcher — {now_utc().strftime('%Y-%m-%d %H:%M UTC')}")
    log.info(f"Lookback: {LOOKBACK_HOURS}h | dry_run={dry_run}")

    keywords = load_keywords(KEYWORDS_FILE)
    sources  = load_sources(SOURCE_FILE)
    config   = load_probe_config(PROBE_FILE)
    seen     = load_seen_urls(OUTPUT_DIR)
    health   = load_health(HEALTH_FILE)

    if filter_source:
        sources = [s for s in sources if filter_source.lower() in s["name"].lower()]
        log.info(f"Filtered to {len(sources)} source(s) matching '{filter_source}'")

    if filter_strategy:
        sources = [s for s in sources
                   if (config.get(s["name"], {}).get("strategy") == filter_strategy
                       or (filter_strategy == "google_news" and s["google_news"]))]
        log.info(f"Filtered to {len(sources)} source(s) with strategy='{filter_strategy}'")

    all_articles = []
    last_domain  = ""

    for i, source in enumerate(sources, 1):
        name = source["name"]
        cfg  = config.get(name, {})

        # source.txt google_news flag always wins
        if source["google_news"]:
            strategy  = "google_news"
            fetch_url = source["url"]
        else:
            strategy  = cfg.get("strategy", "html")
            fetch_url = cfg.get("fetch_url", source["url"])

        # Polite delay for same domain
        domain = urlparse(fetch_url).netloc
        if domain and domain == last_domain:
            time.sleep(REQUEST_DELAY)
        last_domain = domain

        log.info(f"[{i:03d}/{len(sources)}] {name[:38]:38s} [{strategy.upper()}]")

        articles = []
        if strategy != "google_news" and not compliance.robots_allows(fetch_url):
            log.warning(f"  robots.txt disallows {name} -> skipped")
            health = update_health(health, name, 0)
            continue
        try:
            if strategy == "rss":
                articles = fetch_rss(source, fetch_url, keywords, seen)
            elif strategy == "wp_json":
                articles = fetch_wp_json(source, fetch_url, keywords, seen)
            elif strategy == "html":
                articles = fetch_html(source, fetch_url, keywords, seen)
            elif strategy == "html_weak":
                articles = fetch_html_weak(source, fetch_url, keywords, seen)
            elif strategy == "google_news":
                articles = fetch_google_news(source, keywords, seen)
            else:
                # Unknown — try RSS then HTML
                feed = feedparser.parse(fetch_url.rstrip("/") + "/feed")
                if feed.entries:
                    articles = fetch_rss(source, fetch_url.rstrip("/") + "/feed", keywords, seen)
                else:
                    articles = fetch_html(source, fetch_url, keywords, seen)
        except Exception as e:
            log.error(f"  Error {name}: {e}")

        log.info(f"  → {len(articles)} article(s)")
        for a in articles:
            seen.add(a["id"])
        all_articles.extend(articles)
        health = update_health(health, name, len(articles))

    # ── Output ────────────────────────────────────────────────────────────────
    today    = now_utc().strftime("%Y-%m-%d")
    out_path = os.path.join(OUTPUT_DIR, f"articles_{today}.json")

    log.info("=" * 60)
    log.info(f"Total articles: {len(all_articles)}")

    by_strat = {}
    for a in all_articles:
        s = a["fetch_strategy"]
        by_strat[s] = by_strat.get(s, 0) + 1
    for s, c in sorted(by_strat.items()):
        log.info(f"  {s:15s}: {c}")

    if not dry_run:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(all_articles, f, indent=2, ensure_ascii=False)
        log.info(f"Saved → {out_path}")

        save_health(health, HEALTH_FILE)

        # Clean files older than 2 days
        for fname in os.listdir(OUTPUT_DIR):
            if fname.startswith("articles_") and fname.endswith(".json"):
                try:
                    fdate = datetime.strptime(fname[9:19], "%Y-%m-%d")
                    if (now_utc().date() - fdate.date()).days > 2:
                        os.remove(os.path.join(OUTPUT_DIR, fname))
                        log.info(f"Cleaned: {fname}")
                except Exception:
                    pass
    else:
        log.info("[DRY RUN] Sample:")
        for a in all_articles[:8]:
            stars = "★" * a["credibility"] + "☆" * (5 - a["credibility"])
            log.info(f"  {stars} [{a['fetch_strategy']:12s}] {a['source_name'][:25]:25s} | {a['title'][:60]}")
            log.info(f"    kw={a['matched_keyword']} | {a['url'][:70]}")

    print_health_report(health, len(sources))
    return all_articles


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",  action="store_true")
    parser.add_argument("--source",   type=str, default=None)
    parser.add_argument("--strategy", type=str, default=None)
    args = parser.parse_args()
    run(dry_run=args.dry_run, filter_source=args.source, filter_strategy=args.strategy)
