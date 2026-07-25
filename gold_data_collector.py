#!/usr/bin/env python3
"""
gold_data_collector.py — Daily Gold data collector.

Purpose
-------
Builds up a real, first-party historical dataset (one row per day) so that
a forecasting model (ARIMA/SARIMA or ML/DL with scikit-learn) has enough
real data to train on later.

CHANGED: this script used to also fetch USD/MMK itself (Myanmar FX API,
falling back to the official CBM rate). That caused two problems:
  1. The Myanmar FX API died on 2024-06-21 and has returned the same
     frozen "4480" value ever since, silently, every single day.
  2. On days that primary fetch failed for other reasons, it silently
     fell back to the CBM OFFICIAL rate (~2,100) -- a completely
     different, much lower number -- corrupting gold_mmk_per_tical for
     that day (see 2026-07-13 and 2026-07-15 in the existing CSV: rate
     drops to 2098 and gold_mmk_per_tical is roughly HALF the neighboring
     days).
USD/MMK now has its own dedicated real-data pipeline (usd_history.csv,
built by backfill_usd_history.py + update_usd_rate.py). This script just
reads the latest REAL rate from that file instead of fetching its own.

Data sources (all free, no API key required)
---------------------------------------------
- Gold spot price (USD per troy ounce): https://api.gold-api.com/price/XAU
- USD/MMK rate: read from usd_history.csv (this repo's own real pipeline)

Output
------
Appends one row per day to gold_history.csv (created on first run) in the
same directory as this script:

    date, gold_usd_per_oz, usd_mmk_rate, gold_mmk_per_tical

If usd_history.csv has no real rate available yet for today (e.g. the
USD workflow hasn't run yet, or usd_history.csv doesn't exist), this
script uses the most recent real rate it DOES have on file rather than
fabricating one, and clearly labels the row as using a carried-over
rate. If there is no real USD rate at all yet, it leaves usd_mmk_rate
and gold_mmk_per_tical blank rather than guessing.

IMPORTANT — run order: this script should run AFTER update_usd_rate.py
each day (see the workflow schedule) so it can pick up that day's fresh
rate instead of yesterday's.

Usage
-----
    python3 gold_data_collector.py

Running it more than once on the same day is safe — it detects today's
row already exists and skips instead of writing a duplicate.
"""

import csv
import json
import os
import sys
from datetime import date, datetime
from urllib.request import urlopen, Request
from urllib.error import URLError

GOLD_API = "https://api.gold-api.com/price/XAU"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(SCRIPT_DIR, "gold_history.csv")
USD_CSV_PATH = os.path.join(SCRIPT_DIR, "usd_history.csv")

# 1 tical = 16.3293 grams; 1 troy ounce = 31.1035 grams
TICAL_TO_OZ = 16.3293 / 31.1035


def fetch_json(url, timeout=10):
    req = Request(url, headers={"User-Agent": "gold-data-collector/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_gold_usd_price():
    data = fetch_json(GOLD_API)
    price = data.get("price")
    if not price:
        raise ValueError(f"No price in gold-api.com response: {data}")
    return float(price)


def get_latest_real_usd_rate(today_str):
    """Reads usd_history.csv (this repo's real USD/MMK pipeline) and
    returns (rate, is_todays_rate). Never fetches anything itself --
    if the file is missing or empty, returns (None, False) rather than
    guessing a number."""
    if not os.path.exists(USD_CSV_PATH):
        print(f"  usd_history.csv not found at {USD_CSV_PATH}", file=sys.stderr)
        return None, False
    with open(USD_CSV_PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return None, False
    rows.sort(key=lambda r: r["date"])
    last = rows[-1]
    rate = float(last["usd_mmk_buy"])
    return rate, (last["date"] == today_str)


def load_existing_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def append_row(path, row, fieldnames):
    file_exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)


def main():
    today = date.today().isoformat()
    fieldnames = ["date", "gold_usd_per_oz", "usd_mmk_rate", "gold_mmk_per_tical"]

    existing_rows = load_existing_rows(CSV_PATH)
    existing_dates = {row["date"] for row in existing_rows}
    if today in existing_dates:
        print(f"[{today}] Already have today's data — skipping.")
        return

    try:
        gold_usd = get_gold_usd_price()
    except Exception as e:
        print(f"[{today}] FAILED to fetch gold price: {e}", file=sys.stderr)
        sys.exit(1)

    usd_mmk, is_fresh = get_latest_real_usd_rate(today)

    if usd_mmk is None:
        print(f"[{today}] No real USD/MMK rate available yet in usd_history.csv "
              f"-- writing gold_usd_per_oz only, leaving MMK fields blank.")
        row = {
            "date": today,
            "gold_usd_per_oz": round(gold_usd, 2),
            "usd_mmk_rate": "",
            "gold_mmk_per_tical": "",
        }
    else:
        if not is_fresh:
            print(f"[{today}] usd_history.csv doesn't have today's rate yet -- "
                  f"using its most recent real rate ({usd_mmk}) instead of guessing.")
        gold_mmk_per_tical = round(gold_usd * TICAL_TO_OZ * usd_mmk / 1000) * 1000
        row = {
            "date": today,
            "gold_usd_per_oz": round(gold_usd, 2),
            "usd_mmk_rate": round(usd_mmk, 2),
            "gold_mmk_per_tical": gold_mmk_per_tical,
        }

    append_row(CSV_PATH, row, fieldnames)
    print(f"[{today}] Saved: {row}")


if __name__ == "__main__":
    main()


# ======================================================================
# SCHEDULING NOTES
# ======================================================================
# This script must run AFTER update_usd_rate.py in the same daily cycle
# so it picks up that day's fresh real USD/MMK rate. See update_usd.yml
# (cron "0 2 * * *") and collect.yml (cron "30 2 * * *") -- USD update
# runs 30 minutes before gold collection.
#
# --- GitHub Actions (current setup) ---
#   .github/workflows/update_usd.yml  -> runs update_usd_rate.py first
#   .github/workflows/collect.yml     -> runs this script + forecast models
#
#   Both commit back to the repo, so as long as update_usd.yml's run
#   finishes and pushes before collect.yml starts, gold_data_collector.py
#   will see the fresh rate via actions/checkout@v4 at the start of its
#   own job.
# ======================================================================
