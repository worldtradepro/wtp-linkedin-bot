#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Source Probe Script
Reads source.txt, tests every URL, outputs source_config.json

Run:
    pip install feedparser requests beautifulsoup4 lxml
    python probe_sources.py

Output: source_config.json  (strategy per source)
        probe_report.txt    (human-readable summary)
"""

import json
import time
import socket
import re
from urllib.parse import urlparse, urljoin

import requests
import feedparser
from bs4 import BeautifulSoup

socket.setdefaulttimeout(12)

# ── Config ────────────────────────────────────────────────────────────────────
SOURCE_FILE   = "source.txt"
CONFIG_OUT    = "source_config.json"
REPORT_OUT    = "probe_report.txt"
DELAY         = 1.2      # seconds between requests to same domain
MAX_WORKERS   = 1        # sequential to avoid hammering servers

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en,fr;q=0.9,ar;q=0.8,pt;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# RSS paths to probe in order
RSS_PROBE_PATHS = [
    "",                          # the URL itself might be an RSS feed
    "/feed",
    "/feed/",
    "/rss",
    "/rss.xml",
    "/rss/news.xml",
    "/feed.xml",
    "/atom.xml",
    "/news/rss",
    "/news/feed",
    "/media/rss",
    "/press-releases/rss",
    "/newsroom/rss",
    "/en/rss",
    "/en/feed",
    "/en/news/rss",
    "/actualites/feed",
    "/wp-json/wp/v2/posts",      # WordPress REST API (JSON, not RSS but parseable)
]

# ── Parse source.txt ──────────────────────────────────────────────────────────

def parse_source_file(path: str) -> list[dict]:
    """
    Parse lines like:
      Category|Subcategory|Name|URL
      Category|Subcategory|URL   (name missing)
    Also handles section headers: ### 1. Energy
    """
    sources = []
    current_section = ""

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            # Section header
            if line.startswith("###"):
                current_section = line.lstrip("#").strip()
                continue

            parts = line.split("|")
            if len(parts) < 3:
                continue

            # Detect if URL is in position 2 or 3
            url = ""
            name = ""
            if len(parts) >= 4 and parts[3].startswith("http"):
                category    = parts[0].strip()
                subcategory = parts[1].strip()
                name        = parts[2].strip()
                url         = parts[3].strip()
            elif len(parts) >= 3 and parts[2].startswith("http"):
                category    = parts[0].strip()
                subcategory = parts[1].strip()
                name        = ""
                url         = parts[2].strip()
            else:
                continue

            if not url.startswith("http"):
                continue

            sources.append({
                "section":    current_section,
                "category":   category,
                "subcategory": subcategory,
                "name":       name or url,
                "url":        url,
            })

    return sources


# ── RSS Probe ─────────────────────────────────────────────────────────────────

def probe_rss(base_url: str) -> tuple[str | None, int]:
    """
    Try to find a working RSS feed.
    Returns (rss_url, entry_count) or (None, 0).
    """
    origin = "{uri.scheme}://{uri.netloc}".format(uri=urlparse(base_url))

    for path in RSS_PROBE_PATHS:
        if path == "":
            candidate = base_url
        else:
            candidate = origin + path

        try:
            r = requests.get(candidate, headers=HEADERS, timeout=10, allow_redirects=True)
            if r.status_code != 200:
                continue

            ct = r.headers.get("Content-Type", "")

            # Check if it looks like a feed
            is_feed_ct = any(x in ct for x in ("rss", "xml", "atom", "feed"))
            is_wp_json = "json" in ct and "/wp-json/" in candidate

            if is_feed_ct or is_wp_json:
                if is_wp_json:
                    # WordPress REST API
                    try:
                        data = r.json()
                        if isinstance(data, list) and len(data) > 0:
                            return candidate, len(data)
                    except Exception:
                        pass
                else:
                    feed = feedparser.parse(r.content)
                    if feed.entries:
                        return candidate, len(feed.entries)

        except Exception:
            pass

    return None, 0


# ── URL Validity Check ────────────────────────────────────────────────────────

# Phrases that indicate a soft-404 / wrong page
SOFT_404_SIGNALS = [
    "page not found", "404", "not found", "no longer exists",
    "has been moved", "has been removed", "this page doesn't exist",
    "pagina no encontrada", "page introuvable", "seite nicht gefunden",
    "страница не найдена", "الصفحة غير موجودة",
    "error 404", "we can't find", "nothing here",
]

# Phrases that indicate a redirect to homepage / generic landing
HOMEPAGE_SIGNALS = [
    "welcome to", "our website uses cookies", "cookie policy",
    "subscribe to our newsletter", "sign in to continue",
    "access denied", "403 forbidden", "you don't have permission",
]

def check_url_validity(url: str, response_text: str, final_url: str) -> tuple[bool, str]:
    """
    Detect soft-404s and wrong-page redirects.
    Returns (is_valid, reason).
    """
    text_lower = response_text[:3000].lower()

    # Check if we were silently redirected to homepage
    original_path = urlparse(url).path.rstrip("/")
    final_path    = urlparse(final_url).path.rstrip("/")
    if original_path and original_path != final_path and final_path in ("", "/"):
        return False, f"Redirected to homepage (original path: {original_path})"

    # Soft-404 signal in page text
    for signal in SOFT_404_SIGNALS:
        if signal in text_lower:
            # Only flag if it's prominent (in first 1000 chars or in title)
            if signal in text_lower[:1000]:
                return False, f"Soft-404 detected: '{signal}'"

    # Blocked / access-denied page
    for signal in HOMEPAGE_SIGNALS:
        if signal in text_lower[:500]:
            return False, f"Wrong page: '{signal}'"

    return True, ""


# ── HTML Probe ────────────────────────────────────────────────────────────────

def probe_html(url: str) -> dict:
    """
    Try to fetch the page as plain HTML.
    Returns info about what we found.
    """
    result = {
        "reachable": False,
        "status_code": None,
        "has_articles": False,
        "article_count": 0,
        "needs_js": False,
        "url_valid": True,
        "note": "",
    }

    try:
        r = requests.get(url, headers=HEADERS, timeout=12, allow_redirects=True)
        result["status_code"] = r.status_code
        final_url = r.url  # after redirects

        if r.status_code == 404:
            result["url_valid"] = False
            result["note"] = "HTTP 404 — URL does not exist"
            return result

        if r.status_code == 403:
            result["url_valid"] = False
            result["note"] = "HTTP 403 — Access denied (bot blocking)"
            return result

        if r.status_code not in (200, 301, 302):
            result["note"] = f"HTTP {r.status_code}"
            return result

        # Validity check: soft-404, redirected to homepage, etc.
        is_valid, validity_reason = check_url_validity(url, r.text, final_url)
        if not is_valid:
            result["url_valid"] = False
            result["note"] = validity_reason
            return result

        result["reachable"] = True
        result["url_valid"] = True
        soup = BeautifulSoup(r.text, "lxml")

        # Check for JS-heavy page signals
        body_text = soup.get_text(separator=" ", strip=True)
        if len(body_text) < 200:
            result["needs_js"] = True
            result["note"] = "Very little text — likely JS-rendered"
            return result

        # Look for JSON-LD structured data (articles)
        jsonld_scripts = soup.find_all("script", {"type": "application/ld+json"})
        for s in jsonld_scripts:
            try:
                data = json.loads(s.string or "")
                if isinstance(data, list):
                    data = data[0]
                if data.get("@type") in ("NewsArticle", "Article", "BlogPosting"):
                    result["has_articles"] = True
                    result["article_count"] = len(jsonld_scripts)
                    result["note"] = "JSON-LD articles found"
                    return result
            except Exception:
                pass

        # Count article-like links
        article_links = 0
        for a in soup.find_all("a", href=True):
            href = a["href"].lower()
            text = a.get_text(strip=True)
            if len(text) > 20 and any(kw in href for kw in [
                "/news", "/press", "/media", "/release", "/article",
                "/insight", "/announcement", "/story", "/post",
                "/actualite", "/comunicado", "/nachricht", "/noticias",
            ]):
                article_links += 1

        result["has_articles"] = article_links > 2
        result["article_count"] = article_links

        if article_links == 0:
            # Check if it's a JS app shell
            noscript = soup.find("noscript")
            if noscript or len(body_text) < 500:
                result["needs_js"] = True
                result["note"] = "Possible JS app — no article links found"
            else:
                result["note"] = "Page loaded but no article links detected"
        else:
            result["note"] = f"{article_links} article-like links found"

    except requests.exceptions.SSLError:
        result["note"] = "SSL error"
    except requests.exceptions.ConnectionError:
        result["note"] = "Connection refused / DNS failure"
    except requests.exceptions.Timeout:
        result["note"] = "Timeout"
    except Exception as e:
        result["note"] = f"Error: {str(e)[:80]}"

    return result


# ── Determine Strategy ────────────────────────────────────────────────────────

def determine_strategy(source: dict) -> dict:
    """
    Probe one source and return its strategy config.
    Strategy values:
      rss        — working RSS/Atom feed found
      wp_json    — WordPress REST API
      html       — plain HTML scrape
      skip_js    — JS-rendered, no RSS, mark for manual review
      unreachable — dead URL
    """
    url = source["url"]
    print(f"  Probing: {source['name'][:40]:40s} {url[:60]}")

    result = {
        **source,
        "strategy":   "unreachable",
        "rss_url":    None,
        "rss_count":  0,
        "html_note":  "",
        "status_code": None,
    }

    # Step 1: try RSS
    rss_url, rss_count = probe_rss(url)
    if rss_url:
        strategy = "wp_json" if "/wp-json/" in rss_url else "rss"
        result.update({
            "strategy":  strategy,
            "rss_url":   rss_url,
            "rss_count": rss_count,
        })
        print(f"    ✓ {strategy.upper()}: {rss_url[:70]}  [{rss_count} entries]")
        return result

    # Step 2: probe HTML
    html_info = probe_html(url)
    result["status_code"] = html_info["status_code"]
    result["html_note"]   = html_info["note"]

    if not html_info["reachable"] and not html_info["url_valid"]:
        result["strategy"] = "invalid_url"
        print(f"    ✗ INVALID URL: {html_info['note']}")
    elif not html_info["reachable"]:
        result["strategy"] = "unreachable"
        print(f"    ✗ UNREACHABLE: {html_info['note']}")
    elif html_info["needs_js"]:
        result["strategy"] = "skip_js"
        print(f"    ⚠ JS-RENDERED: {html_info['note']}")
    elif html_info["has_articles"]:
        result["strategy"] = "html"
        print(f"    ~ HTML: {html_info['note']}")
    else:
        result["strategy"] = "html_weak"   # reachable but few links
        print(f"    ~ HTML-WEAK: {html_info['note']}")

    return result


# ── Main ──────────────────────────────────────────────────────────────────────


def update_source_txt_google_news(results: list[dict], source_file: str) -> None:
    """
    After probing, automatically add google_news flag to source.txt
    for any source that is invalid_url, unreachable, or skip_js.
    Only adds — never removes existing google_news flags (plan B).
    """
    DEAD_STRATEGIES = {"invalid_url", "unreachable", "skip_js"}

    # Build set of names that need google_news
    needs_gn = {r["name"] for r in results if r.get("strategy") in DEAD_STRATEGIES}

    if not needs_gn:
        print("\nNo sources need google_news update.")
        return

    with open(source_file, "r", encoding="utf-8") as f:
        lines = f.readlines()

    new_lines = []
    added = []
    for line in lines:
        stripped = line.rstrip("\n").rstrip("\r")
        if "|" in stripped and not stripped.startswith("#") and not stripped.startswith("=") and not stripped.startswith("【"):
            parts = [p.strip() for p in stripped.split("|")]
            if len(parts) >= 3:
                name = parts[2]
                if name in needs_gn and "google_news" not in stripped.lower():
                    stripped = stripped.rstrip() + " | google_news"
                    added.append(name)
        new_lines.append(stripped + "\n")

    with open(source_file, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    if added:
        print(f"\nAuto-updated source.txt — added google_news to {len(added)} source(s):")
        for n in sorted(added):
            print(f"  + {n}")
    else:
        print("\nNo new google_news flags needed (all already set).")


def main():
    print(f"Reading {SOURCE_FILE}...")
    sources = parse_source_file(SOURCE_FILE)
    print(f"Found {len(sources)} sources\n")

    results = []
    last_domain = ""

    for i, source in enumerate(sources, 1):
        domain = urlparse(source["url"]).netloc
        print(f"[{i:03d}/{len(sources)}]", end=" ")

        # Polite delay between requests to same domain
        if domain == last_domain:
            time.sleep(DELAY)
        last_domain = domain

        result = determine_strategy(source)
        results.append(result)

    # ── Write JSON config ──────────────────────────────────────────────────────
    with open(CONFIG_OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nConfig written → {CONFIG_OUT}")

    # ── Write human-readable report ────────────────────────────────────────────
    strategy_groups = {
        "rss":         [],
        "wp_json":     [],
        "html":        [],
        "html_weak":   [],
        "skip_js":     [],
        "invalid_url": [],
        "unreachable": [],
    }
    for r in results:
        strategy_groups.get(r["strategy"], strategy_groups["unreachable"]).append(r)

    lines = []
    lines.append("=" * 80)
    lines.append("EPC RADAR — SOURCE PROBE REPORT")
    lines.append("=" * 80)
    lines.append(f"Total sources: {len(results)}")
    for strat, items in strategy_groups.items():
        lines.append(f"  {strat:12s}: {len(items)}")
    lines.append("")

    labels = {
        "rss":         "✓ RSS / ATOM FEEDS",
        "wp_json":     "✓ WORDPRESS REST API",
        "html":        "~ HTML SCRAPE (articles detected)",
        "html_weak":   "~ HTML SCRAPE (weak — few links)",
        "skip_js":     "⚠ JS-RENDERED (needs Playwright or alternative)",
        "invalid_url": "✗ INVALID URL (soft-404 / wrong page / redirected)",
        "unreachable": "✗ UNREACHABLE (timeout / DNS / connection error)",
    }

    for strat, items in strategy_groups.items():
        lines.append("-" * 80)
        lines.append(f"{labels[strat]}  [{len(items)}]")
        lines.append("-" * 80)
        for r in items:
            name = f"{r['category']}/{r['subcategory']}/{r['name']}"
            rss  = f"  → {r['rss_url']}" if r.get("rss_url") else ""
            note = f"  [{r['html_note']}]" if r.get("html_note") else ""
            lines.append(f"  {name[:55]:55s}  {r['url'][:60]}{rss}{note}")
        lines.append("")

    report = "\n".join(lines)
    with open(REPORT_OUT, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"Report written  → {REPORT_OUT}")
    print("\n" + report)

    # ── Auto-update source.txt with google_news flags ──────────────────────────
    update_source_txt_google_news(results, SOURCE_FILE)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="EPC Radar Source Prober")
    parser.add_argument("--sources", type=str, default=None,
                        help="Comma-separated list of source names to probe (default: all)")
    args = parser.parse_args()

    if args.sources:
        filter_names = {s.strip() for s in args.sources.split(",")}
        import sys
        # Monkey-patch main to filter sources
        _orig_main = main
        def main():
            print(f"Reading {SOURCE_FILE}...")
            sources = parse_source_file(SOURCE_FILE)
            filtered = [s for s in sources if s["name"] in filter_names]
            not_found = filter_names - {s["name"] for s in filtered}
            if not_found:
                print(f"WARNING: Sources not found: {not_found}")
            print(f"Probing {len(filtered)} of {len(sources)} sources\n")

            results = []
            last_domain = ""
            for i, source in enumerate(filtered, 1):
                domain = urlparse(source["url"]).netloc
                print(f"[{i:03d}/{len(filtered)}]", end=" ")
                if domain == last_domain:
                    time.sleep(DELAY)
                last_domain = domain
                result = determine_strategy(source)
                results.append(result)

            # Print results directly to console
            for r in results:
                name = r["name"]
                strat = r["strategy"]
                note = r.get("html_note", "")
                rss = f" → {r['rss_url']}" if r.get("rss_url") else ""
                print(f"\n  {name}: [{strat}]{rss} {note}")

    main()
