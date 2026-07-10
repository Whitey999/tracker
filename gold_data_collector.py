#!/usr/bin/env python3
"""
gold_data_collector.py — Daily Gold + USD/MMK data collector.

Purpose
-------
Builds up a real, first-party historical dataset (one row per day) so that
a forecasting model (ARIMA/SARIMA or ML/DL with scikit-learn) has enough
real data to train on later. Solves the earlier problem of relying on
third-party feeds (freegoldapi.com, etc.) that can silently go stale.

Data sources (all free, no API key required)
---------------------------------------------
- Gold spot price (USD per troy ounce): https://api.gold-api.com/price/XAU
- USD/MMK rate, primary:  Myanmar Currency API (community, parallel market)
- USD/MMK rate, fallback: Central Bank of Myanmar official rate

Output
------
Appends one row per day to gold_history.csv (created on first run) in the
same directory as this script:

    date, gold_usd_per_oz, usd_mmk_rate, gold_mmk_per_tical

Usage
-----
    python3 gold_data_collector.py

Run this once a day (see scheduling notes at the bottom of this file for
cron / Task Scheduler / GitHub Actions examples). Running it more than
once on the same day is safe — it detects today's row already exists and
skips instead of writing a duplicate.
"""

import csv
import json
import os
import sys
from datetime import date
from urllib.request import urlopen, Request
from urllib.error import URLError

GOLD_API = "https://api.gold-api.com/price/XAU"
MYANMAR_FX_API = "https://myanmar-currency-api.github.io/api/latest.json"
CBM_API = "https://forex.cbm.gov.mm/api/latest"

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_history.csv")

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


MAX_DAILY_CHANGE_PCT = 15  # reject a rate that jumps more than this vs yesterday


def get_usd_mmk_rate(previous_rate=None):
    """Tries sources in order. If a candidate rate deviates from
    previous_rate by more than MAX_DAILY_CHANGE_PCT, it's treated as
    suspicious (likely an API glitch/format change) and the NEXT source
    is tried instead of blindly accepting it — this is what silently let
    a ~113% rate spike into the dataset before."""
    suspicious = []

    def is_ok(rate):
        if previous_rate is None:
            return True
        change_pct = abs(rate - previous_rate) / previous_rate * 100
        if change_pct > MAX_DAILY_CHANGE_PCT:
            suspicious.append((rate, change_pct))
            print(f"  Rejected rate {rate} — {change_pct:.1f}% jump from "
                  f"yesterday's {previous_rate} (> {MAX_DAILY_CHANGE_PCT}% threshold)",
                  file=sys.stderr)
            return False
        return True

    # Primary: Myanmar Currency API (community-run parallel market rate)
    try:
        data = fetch_json(MYANMAR_FX_API)
        for entry in data.get("data", []):
            if entry.get("currency") == "USD":
                buy = float(entry["buy"])
                if buy > 100 and is_ok(buy):
                    return buy
    except (URLError, ValueError, KeyError, TimeoutError) as e:
        print(f"Myanmar FX API failed: {e}", file=sys.stderr)

    # Fallback: Central Bank of Myanmar official rate
    try:
        data = fetch_json(CBM_API)
        rate = float(data["rates"]["USD"])
        if rate > 100 and is_ok(rate):
            return rate
    except (URLError, ValueError, KeyError, TimeoutError) as e:
        print(f"CBM API failed: {e}", file=sys.stderr)

    if suspicious:
        raise RuntimeError(
            f"All sources returned suspicious rates vs yesterday's {previous_rate}: "
            f"{suspicious}. Refusing to write a possibly-bad value — check the "
            f"APIs manually and/or raise MAX_DAILY_CHANGE_PCT if this jump is real."
        )
    raise RuntimeError("Could not fetch USD/MMK rate from any source today")


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

    previous_rate = None
    if existing_rows:
        try:
            previous_rate = float(existing_rows[-1]["usd_mmk_rate"])
        except (KeyError, ValueError):
            previous_rate = None

    try:
        gold_usd = get_gold_usd_price()
        usd_mmk = get_usd_mmk_rate(previous_rate)
    except Exception as e:
        print(f"[{today}] FAILED to fetch data: {e}", file=sys.stderr)
        sys.exit(1)

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
# SCHEDULING NOTES (pick whichever matches where you'll run this)
# ======================================================================
#
# --- Option A: Your own computer (Linux/Mac) — cron ---
#   crontab -e
#   Add a line to run it every day at 9:00 AM:
#     0 9 * * * /usr/bin/python3 /full/path/to/gold_data_collector.py
#
# --- Option B: Windows — Task Scheduler ---
#   Create a Basic Task that runs daily, Action = "Start a program":
#     Program:  python
#     Arguments: gold_data_collector.py
#     Start in: (folder containing this script)
#
# --- Option C: GitHub Actions (no server needed, like freegoldapi.com does) ---
#   Create .github/workflows/collect.yml in your repo:
#
#     name: Daily Gold Data Collection
#     on:
#       schedule:
#         - cron: "30 2 * * *"   # 09:00 Myanmar time (UTC+6:30) daily
#       workflow_dispatch: {}     # lets you also trigger it manually
#     jobs:
#       collect:
#         runs-on: ubuntu-latest
#         steps:
#           - uses: actions/checkout@v4
#           - uses: actions/setup-python@v5
#             with:
#               python-version: "3.x"
#           - run: python gold_data_collector.py
#           - run: |
#               git config user.name "gold-bot"
#               git config user.email "bot@users.noreply.github.com"
#               git add gold_history.csv
#               git commit -m "Daily gold data update" || echo "No changes"
#               git push
#
#   This commits gold_history.csv back into your repo every day — over
#   time it becomes your own real, first-party historical dataset that
#   your forecasting model (and even the website itself) can read from,
#   with no dependency on any third-party API's uptime.
# ======================================================================
