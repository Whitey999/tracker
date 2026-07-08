#!/usr/bin/env python3
"""
backfill_gold_history.py — One-time historical data backfill.

Combines THREE real (no fabricated values) sources into a single
gold_history.csv:

  1. freegoldapi.com's real gold price history (annual/monthly/daily,
     whatever granularity is real for each period — no key needed)
  2. GoldAPI.io per-day historical endpoint, to fill the gap between
     freegoldapi.com's last real update and today (requires a key —
     see SECURITY note below)
  3. Frankfurter v2 for real daily USD/MMK exchange rates

Run this ONCE to backfill history. After that, gold_data_collector.py
(run daily via GitHub Actions) keeps extending the same CSV going forward.

--------------------------------------------------------------------
SECURITY — DO NOT hardcode your GoldAPI.io key in this file. This repo
is public; anyone could read a hardcoded key from the file history.
Instead, set it as an environment variable before running:

    macOS/Linux:      export GOLDAPI_IO_KEY="your-key-here"
    Windows (PowerShell): $env:GOLDAPI_IO_KEY="your-key-here"

Then run:  python3 backfill_gold_history.py
--------------------------------------------------------------------

QUOTA NOTE: GoldAPI.io's free tier is limited (~100 requests/month).
This script caps itself at MAX_GOLDAPI_CALLS_PER_RUN calls per run so
one run can't accidentally burn the whole month's quota. If the gap is
bigger than that, just re-run the script again next month to continue
filling in the rest — it always resumes from the oldest still-missing
date first.
"""

import csv
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

FREE_GOLD_HISTORY_API = "https://freegoldapi.com/data/latest.json"
GOLDAPI_IO_BASE = "https://www.goldapi.io/api/XAU/USD"
FRANKFURTER_BASE = "https://api.frankfurter.dev/v2/rates"

GOLDAPI_IO_KEY = os.environ.get("GOLDAPI_IO_KEY", "")
MAX_GOLDAPI_CALLS_PER_RUN = 85  # safety cap so one run can't exhaust the monthly quota

TICAL_TO_OZ = 16.3293 / 31.1035
CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_history.csv")


def fetch_json(url, headers=None, timeout=15):
    req = Request(url, headers=headers or {"User-Agent": "gold-backfill/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_freegoldapi_history():
    print("Fetching freegoldapi.com full history...")
    raw = fetch_json(FREE_GOLD_HISTORY_API)
    records = []
    for rec in raw:
        try:
            d = datetime.strptime(rec["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError, TypeError):
            continue
        if d.year < 2007:
            continue
        price = rec.get("price")
        if not price:
            continue
        records.append((d, float(price)))
    records.sort()
    print(f"  -> {len(records)} usable real records from freegoldapi.com")
    return records  # list of (date, usd_per_oz), sorted ascending


def fetch_usd_mmk_history(start_date, end_date):
    print(f"Fetching real USD/MMK rates {start_date} .. {end_date} from Frankfurter...")
    url = (f"{FRANKFURTER_BASE}?base=USD&quotes=MMK"
           f"&from={start_date.isoformat()}&to={end_date.isoformat()}")
    data = fetch_json(url)
    rates = {}
    if isinstance(data, list):
        for rec in data:
            try:
                d = datetime.strptime(rec["date"], "%Y-%m-%d").date()
                rates[d] = float(rec["rate"])
            except (KeyError, ValueError, TypeError):
                continue
    print(f"  -> {len(rates)} real USD/MMK rates")
    return rates


def fetch_goldapi_io_day(d):
    """One day's real gold USD/oz price from GoldAPI.io, or None on failure."""
    ymd = d.strftime("%Y%m%d")
    url = f"{GOLDAPI_IO_BASE}/{ymd}"
    try:
        data = fetch_json(url, headers={"x-access-token": GOLDAPI_IO_KEY})
        price = data.get("price")
        return float(price) if price else None
    except (URLError, HTTPError, ValueError, KeyError) as e:
        print(f"  GoldAPI.io failed for {d}: {e}", file=sys.stderr)
        return None


def backfill_gap_via_goldapi(existing_dates, gap_start, gap_end):
    """Fill missing weekday dates in [gap_start, gap_end] using GoldAPI.io,
    capped at MAX_GOLDAPI_CALLS_PER_RUN calls so one run can't exhaust quota."""
    if not GOLDAPI_IO_KEY:
        print(f"No GOLDAPI_IO_KEY set — skipping gap backfill for "
              f"{gap_start} .. {gap_end}. Set the env var to fill this with "
              f"real data instead of leaving it empty.")
        return {}

    missing = [gap_start + timedelta(days=i)
               for i in range((gap_end - gap_start).days + 1)]
    missing = [d for d in missing if d.weekday() < 5 and d not in existing_dates]

    todo = missing[:MAX_GOLDAPI_CALLS_PER_RUN]
    remaining = len(missing) - len(todo)
    print(f"Backfilling gap via GoldAPI.io: {len(missing)} weekdays missing, "
          f"filling {len(todo)} this run" + (f" ({remaining} left for next run)" if remaining else "") + "...")

    filled = {}
    for d in todo:
        price = fetch_goldapi_io_day(d)
        if price:
            filled[d] = price
            print(f"  {d}: {price} USD/oz")
        time.sleep(0.5)  # be polite to the free-tier API
    print(f"  -> filled {len(filled)} days from GoldAPI.io")
    return filled


def load_existing_csv(path):
    """Preserve whatever the daily collector has already written."""
    rows = {}
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    d = datetime.strptime(row["date"], "%Y-%m-%d").date()
                    rows[d] = row
                except (KeyError, ValueError):
                    continue
    return rows


def main():
    today = date.today()
    ten_years_ago = today.replace(year=today.year - 10)

    # 1) Real gold USD price history from freegoldapi.com
    gold_records = fetch_freegoldapi_history()
    gold_by_date = {d: price for d, price in gold_records}

    # 2) Fill the gap between freegoldapi's last real date and today, via GoldAPI.io
    last_real_date = gold_records[-1][0] if gold_records else ten_years_ago
    if last_real_date < today:
        gap_filled = backfill_gap_via_goldapi(
            set(gold_by_date), last_real_date + timedelta(days=1), today
        )
        gold_by_date.update(gap_filled)

    # 3) Real USD/MMK rates for the same 10-year window
    usd_mmk = fetch_usd_mmk_history(ten_years_ago, today)

    # 4) Don't lose whatever the daily collector already saved
    existing = load_existing_csv(CSV_PATH)

    # 5) Merge: only write a row where BOTH a real gold price AND a real
    #    USD/MMK rate exist for that date. No fabricated/estimated values.
    merged = dict(existing)
    for d, gold_usd in gold_by_date.items():
        if d < ten_years_ago:
            continue
        rate = usd_mmk.get(d)
        if rate is None:
            continue
        gold_mmk = round(gold_usd * TICAL_TO_OZ * rate / 1000) * 1000
        merged[d] = {
            "date": d.isoformat(),
            "gold_usd_per_oz": round(gold_usd, 2),
            "usd_mmk_rate": round(rate, 2),
            "gold_mmk_per_tical": gold_mmk,
        }

    # 6) Write out, sorted chronologically
    fieldnames = ["date", "gold_usd_per_oz", "usd_mmk_rate", "gold_mmk_per_tical"]
    sorted_dates = sorted(merged.keys())
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for d in sorted_dates:
            writer.writerow(merged[d])

    print(f"\nDone. {len(sorted_dates)} total rows written to {CSV_PATH}")
    if sorted_dates:
        print(f"Range: {sorted_dates[0]} .. {sorted_dates[-1]}")
    if not GOLDAPI_IO_KEY:
        print("\nNOTE: GOLDAPI_IO_KEY was not set, so the recent gap (if any) "
              "was left unfilled rather than faked. Set the env var and "
              "re-run to fill it with real data.")


if __name__ == "__main__":
    main()
