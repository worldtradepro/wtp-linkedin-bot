#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EPC Radar — Backfill historical opportunities into the dashboard API
=======================================================================
One-time (re-runnable) script: scans data/opportunities_*.json and pushes
every date found to the /wp-json/wtp/v1/opportunities endpoint via
run_pipeline.step_publish_data(), so the map dashboard has full history
instead of starting empty.

Safe to re-run: the endpoint replaces existing rows for a given
(report_type, report_date) before inserting, so running this twice does
not create duplicates.

Usage:
    python backfill_opportunities.py                # backfill everything found
    python backfill_opportunities.py --dry-run       # list dates, don't push
"""

import os
import re
import sys
import glob
import argparse
import logging

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(PROJECT_DIR)

import run_pipeline  # reuses step_publish_data + .env loading + DATA_DIR setup

log = logging.getLogger("backfill")
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
    log.info(f"Found {len(dates)} opportunities files: {dates[0]} .. {dates[-1]}" if dates else "No opportunities files found")

    if args.dry_run:
        for d in dates:
            print(d)
        return

    ok_count = 0
    fail_count = 0
    for d in dates:
        try:
            success = run_pipeline.step_publish_data(d)
            if success:
                ok_count += 1
            else:
                fail_count += 1
                log.warning(f"  {d}: publish returned False")
        except Exception as e:
            fail_count += 1
            log.error(f"  {d}: exception {e}")

    log.info(f"Backfill complete: {ok_count} succeeded, {fail_count} failed, {len(dates)} total")


if __name__ == "__main__":
    main()
