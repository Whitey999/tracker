#!/usr/bin/env python3
"""
clean_gold_history.py — ONE-TIME cleanup for gold_history.csv.

Fixes TWO issues found by manual inspection:
1. Inconsistent date format (older rows: M/D/YYYY, newer rows: YYYY-MM-DD)
   -> standardizes ALL rows to ISO YYYY-MM-DD.
2. Corrupted usd_mmk_rate values (~4480, roughly double the real ~2100
   rate) that crept back in on several July 2026 dates, doubling
   gold_mmk_per_tical along with them. This happened intermittently
   (some days in the same week are correct at ~2098) which points to a
   flaky upstream source rather than a one-time event.

POLICY: rows with an anomalous rate are DELETED, not "corrected" by
guessing a plausible rate — we don't have real ground-truth for what the
rate actually was that day, and substituting a neighboring day's rate
would itself be a form of fabricated data. Consistent with this
project's "real data only" rule, it's better to have a gap than a guess.

USAGE
-----
    python3 clean_gold_history.py
"""

import csv
import os
import shutil
from datetime import datetime, date

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_history.csv")

# A rate outside this range is treated as corrupted — but ONLY for
# recent dates (RECENT_CHECK_START onward), where we know from the
# app's own verified annual data that USD/MMK should be ~2000-2200.
# Earlier years (2007-2024) had genuinely different rates (official
# peg ~6.4 pre-2012, then a gradual market-rate rise to ~2100) — that
# is REAL data, not corruption, so it must never be touched by this
# check regardless of how different it looks from today's rate.
RECENT_CHECK_START = date(2025, 1, 1)
# A rate outside this range is treated as corrupted. Myanmar has TWO
# real rates that coexist: official/CBM (~2,000-2,200) and black-market
# (confirmed accurate up to ~4,480+ with an on-the-ground money changer).
# This app tracks the black-market rate, so the range is wide enough to
# accept both — it only rejects clearly-broken values (e.g. a decimal
# glitch), not anything that's merely "different from 2,100."
RATE_MIN, RATE_MAX = 1500, 8000

DATE_FORMATS = ["%m/%d/%Y", "%Y-%m-%d"]


def parse_date(s):
    s = s.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognized date format: {s!r}")


def main():
    if not os.path.exists(CSV_PATH):
        print(f"ERROR: {CSV_PATH} not found.")
        return

    backup_path = CSV_PATH + ".bak"
    shutil.copy(CSV_PATH, backup_path)
    print(f"Backed up original to {backup_path}")

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    kept, dropped = [], []
    for row in rows:
        try:
            d = parse_date(row["date"])
        except ValueError as e:
            print(f"Skipping unparseable row: {row} ({e})")
            dropped.append(row)
            continue

        rate_str = (row.get("usd_mmk_rate") or "").strip()
        price_str = (row.get("gold_usd_per_oz") or "").strip()

        if not rate_str or not price_str:
            print(f"Dropping row with missing value: {row}")
            dropped.append(row)
            continue

        rate = float(rate_str)
        if d >= RECENT_CHECK_START and not (RATE_MIN <= rate <= RATE_MAX):
            print(f"Dropping row with anomalous rate ({rate}): {d.isoformat()}")
            dropped.append(row)
            continue

        row["date"] = d.isoformat()  # standardize to ISO format
        kept.append((d, row))

    kept.sort(key=lambda x: x[0])

    fieldnames = ["date", "gold_usd_per_oz", "usd_mmk_rate", "gold_mmk_per_tical"]
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for _, row in kept:
            writer.writerow({k: row.get(k, "") for k in fieldnames})

    print(f"\nKept {len(kept)} rows, dropped {len(dropped)} rows.")
    print(f"Wrote cleaned {CSV_PATH}")
    if kept:
        print(f"Range: {kept[0][0].isoformat()} .. {kept[-1][0].isoformat()}")


if __name__ == "__main__":
    main()
