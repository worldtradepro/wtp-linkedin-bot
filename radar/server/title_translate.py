#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — English titles for official-procurement items
==========================================================
TED notices keep the buyer's language ("Power distribution cables – Dostawa
przewodów i kabli ..."), World Bank notices are often French/Spanish/Portuguese.
This rewrites project_name (and the title inside description) as a short English
title via the analyzer's OpenRouter call, batch by batch.

  * cached per article_id in data/title_cache.json, so re-runs cost nothing
  * non-fatal: on any API/parse error the original title is kept
  * the original stays available as "title_original"
  * TRANSLATE_TITLES=0 (env/.env): no API calls, non-English items are dropped
    instead (English-only feed; loses most EU items)
"""

import json
import logging
import os
import re

log = logging.getLogger("title_translate")

BATCH = 40
# Titles already in English: TED ones from the UK/Ireland/Malta, most World Bank ones
ENGLISH_HINT = re.compile(r"\b(the|of|and|for|with|supply|construction|installation|works?|procurement|design)\b", re.I)

PROMPT = """Translate each procurement notice title into a concise English title (max 110 characters).
Keep proper names, place names, voltages, capacities and lot numbers. Drop reference codes and
boilerplate such as "tender for", "procurement of", "framework agreement for". Do not add facts.

Return ONLY a JSON array of objects {{"id": "...", "title": "..."}}, one per input, same ids.

Input:
{items}
"""


def _needs(item):
    title = item.get("project_name") or ""
    aid = str(item.get("article_id", ""))
    if aid.startswith("ted-"):
        # "CPV label – original": the part after the first dash decides
        original = title.split(" – ", 1)[-1]
        return not ENGLISH_HINT.search(original)
    return bool(title) and not ENGLISH_HINT.search(title)


def _load_env():
    """Standalone runs: read .env like run_pipeline does (never overrides real env)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            k, sep, v = line.strip().partition("=")
            if sep and k and not k.startswith("#"):
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _apply(item, english):
    orig = item["project_name"]
    item["title_original"] = orig
    item["project_name"] = english[:255]
    desc = item.get("description") or ""
    i = desc.find(orig[:30])
    if i >= 0:
        item["description"] = (desc[:i] + english)[:255]


def translate(items, data_dir):
    """Return the items with English titles (translated in place, or non-English
    ones dropped when TRANSLATE_TITLES=0)."""
    _load_env()
    if os.environ.get("TRANSLATE_TITLES", "1").strip() == "0":
        kept = [it for it in items if not _needs(it)]
        log.info(f"Translation off: kept {len(kept)}/{len(items)} English-titled items")
        return kept
    cache_path = os.path.join(data_dir, "title_cache.json")
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}

    todo = []
    for it in items:
        if not _needs(it):
            continue
        if it["article_id"] in cache:
            _apply(it, cache[it["article_id"]])
        else:
            todo.append(it)
    if not todo:
        return items

    try:
        from openrouter_analyzer import call_openrouter
    except Exception as e:
        log.warning(f"Translation skipped (analyzer unavailable: {e})")
        return items

    done = 0
    for k in range(0, len(todo), BATCH):
        batch = todo[k:k + BATCH]
        payload = json.dumps([{"id": it["article_id"], "title": it["project_name"]} for it in batch], ensure_ascii=False)
        try:
            raw = call_openrouter(PROMPT.format(items=payload))
            m = re.search(r"\[.*\]", raw, re.S)
            out = {r["id"]: r["title"].strip() for r in json.loads(m.group(0)) if r.get("id") and r.get("title")}
        except Exception as e:
            log.warning(f"Translation batch failed, keeping original titles: {e}")
            continue
        for it in batch:
            en = out.get(it["article_id"])
            if en:
                cache[it["article_id"]] = en
                _apply(it, en)
                done += 1

    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except OSError as e:
        log.warning(f"Could not save title cache: {e}")
    log.info(f"Translated {done}/{len(todo)} titles to English")
    return items
