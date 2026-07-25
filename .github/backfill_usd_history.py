#!/usr/bin/env python3
"""
backfill_usd_history.py
------------------------
ONE-TIME backfill of real historical black-market USD/MMK rates.

Source: the commit history of api/latest.json in the (now-dead)
myanmar-currency-api.github.io repo. That project stopped updating on
2024-06-21, so this only covers 2024-04-08 -> 2024-06-21 (~2.5 months)
-- but every value comes from a real commit made at the time, not an
invented number.

Run this ONCE to seed usd_history.csv. After that, update_usd_rate.py
(run daily via GitHub Actions) appends new real rows going forward.

Usage:
    python backfill_usd_history.py [--out usd_history.csv] [--token GITHUB_TOKEN]

A GitHub token is optional but strongly recommended: unauthenticated
requests are capped at 60/hour, which isn't enough to walk ~3800
commits. Pass a token via --token or the GITHUB_TOKEN env var
(a plain "public_repo" read-only PAT is enough) to get 5000/hour.
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error

REPO = "myanmar-currency-api/myanmar-currency-api.github.io"
FILE_PATH = "api/latest.json"
API_BASE = f"https://api.github.com/repos/{REPO}/commits"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}"

# Sanity bounds -- reject anything outside this as a bad parse, not a real rate.
RATE_MIN, RATE_MAX = 500, 10000


def gh_request(url, token=None):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "usd-history-backfill")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 403 and attempt < 2:
                print("  rate-limited, waiting 60s...", file=sys.stderr)
                time.sleep(60)
                continue
            raise


def list_all_commits(token=None):
    commits = []
    page = 1
    while True:
        url = f"{API_BASE}?path={FILE_PATH}&per_page=100&page={page}"
        batch = gh_request(url, token)
        if not batch:
            break
        commits.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return commits


def fetch_rate_at_commit(sha, token=None):
    url = f"{RAW_BASE}/{sha}/{FILE_PATH}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "usd-history-backfill")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  skip {sha[:8]}: {e}", file=sys.stderr)
        return None
    for row in data.get("data", []):
        if row.get("currency") == "USD":
            try:
                buy = float(row["buy"])
                sell = float(row.get("sell", row["buy"]))
            except (KeyError, ValueError):
                return None
            if RATE_MIN <= buy <= RATE_MAX:
                return buy, sell
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="usd_history.csv")
    ap.add_argument("--token", default=os.environ.get("GITHUB_TOKEN"))
    args = ap.parse_args()

    print("Listing commits to api/latest.json (this is the real, dated history)...")
    commits = list_all_commits(args.token)
    print(f"Found {len(commits)} commits.")

    # Keep only the LAST commit of each calendar day (closest to end-of-day rate).
    by_date = {}
    for c in commits:
        date_str = c["commit"]["committer"]["date"][:10]  # YYYY-MM-DD
        # commits list comes back newest-first; first time we see a date
        # is therefore the LATEST commit of that day.
        if date_str not in by_date:
            by_date[date_str] = c["sha"]

    print(f"Deduped to {len(by_date)} unique real days.")

    rows = []
    for i, (date_str, sha) in enumerate(sorted(by_date.items()), 1):
        result = fetch_rate_at_commit(sha, args.token)
        if result:
            buy, sell = result
            rows.append((date_str, buy, sell))
            print(f"  [{i}/{len(by_date)}] {date_str}: {buy}/{sell}")
        else:
            print(f"  [{i}/{len(by_date)}] {date_str}: skipped (no usable USD rate)")

    if not rows:
        print("No real rows collected -- nothing written.", file=sys.stderr)
        sys.exit(1)

    rows.sort(key=lambda r: r[0])
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "usd_mmk_buy", "usd_mmk_sell", "source"])
        for date_str, buy, sell in rows:
            w.writerow([date_str, buy, sell, "myanmar-currency-api-archive"])

    print(f"\nWrote {len(rows)} real historical rows to {args.out}")
    print("NOTE: this source stopped updating 2024-06-21, so history ends there.")
    print("Run update_usd_rate.py daily (via GitHub Actions) to extend it forward.")


if __name__ == "__main__":
    main()
