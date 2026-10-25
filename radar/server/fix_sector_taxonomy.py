#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
One-time fix: fold leaked subsector values (LNG, Oil & Gas, Renewables,
Hydrogen & Ammonia, Logistics, etc.) back under their correct top-level
sector (Energy / Mining & Metals / Agriculture / Logistics & Infrastructure)
in every historical opportunities_*.json file, then republish to the
dashboard API. Pure local remap — no OpenRouter calls needed.

Usage:
    python fix_sector_taxonomy.py            # fix + republish everything
    python fix_sector_taxonomy.py --dry-run  # just report counts, no writes
"""

import os
import re
import glob
import json
import argparse
import logging

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(PROJECT_DIR)

import run_pipeline
from openrouter_analyzer import normalize_sector

log = logging.getLogger("fix_sectors")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")


def find_dates():
    pattern = os.path.join(run_pipeline.DATA_DIR, "opportunities_*.json")
    dates = []
    for path in sorted(glob.glob(pattern)):
        m = re.search(r"opportunities_(\d{4}-\d{2}-\d{2})\.json$", path)
        if m:
            dates.append(m.group(1))
    return dates


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dates = find_dates()
    log.info(f"Found {len(dates)} opportunities files")

    total_changed = 0
    changed_dates = []

    for d in dates:
        path = os.path.join(run_pipeline.DATA_DIR, f"opportunities_{d}.json")
        with open(path, encoding="utf-8") as f:
            items = json.load(f)

        file_changed = 0
        for item in items:
            before = item.get("sector")
            normalize_sector(item)
            if item.get("sector") != before:
                file_changed += 1

        if file_changed:
            total_changed += file_changed
            changed_dates.append(d)
            log.info(f"  {d}: {file_changed} record(s) remapped")
            if not args.dry_run:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(items, f, indent=2, ensure_ascii=False)

    log.info(f"Total records remapped: {total_changed} across {len(changed_dates)} date(s)")

    if args.dry_run:
        log.info("Dry run — no files written, nothing republished")
        return

    ok, fail = 0, 0
    for d in changed_dates:
        try:
            if run_pipeline.step_publish_data(d):
                ok += 1
            else:
                fail += 1
        except Exception as e:
            fail += 1
            log.error(f"  {d}: publish exception {e}")

    log.info(f"Republish complete: {ok} succeeded, {fail} failed, {len(changed_dates)} total")


if __name__ == "__main__":
    main()
