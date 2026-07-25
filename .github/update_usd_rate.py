#!/usr/bin/env python3
"""
update_usd_rate.py
-------------------
Meant to run ONCE A DAY via GitHub Actions (see update_usd.yml).

Fetches today's real black-market USD/MMK rate by scraping egcurrency.com's
"Black Market" page server-side (no CORS restriction here -- this is a
server, not a browser), and appends/updates today's row in usd_history.csv.

Why scrape instead of calling a JSON API: no maintained, free, CORS-open
black-market USD/MMK API currently exists (myanmar-currency-api.github.io
died 2024-06-21; official sources like CBM/Frankfurter only give the
very different ~2,100 MMK official rate, not the street rate). This page
is chosen because it is visibly live-updating and explicitly labeled
"Black Market". Running this once a day, server-side, from a script
identifying itself with a descriptive User-Agent, is a light footprint.

*** IMPORTANT CAVEAT ***
I (Claude) could not test this scraper against egcurrency.com's actual
live HTML -- that domain isn't reachable from my sandbox, so the regexes
below are based on the page's rendered TEXT structure only. Please run
this once manually (`python update_usd_rate.py --dry-run`) and confirm
the printed rate looks right (it should be in the ~3,000-6,000 MMK
range, clearly different from the ~2,100 official rate) before turning
on the daily GitHub Action. If egcurrency.com changes its page layout
this will need a small regex update -- it fails loudly (non-zero exit,
no CSV write) rather than silently writing a wrong number.

Usage:
    python update_usd_rate.py [--csv usd_history.csv] [--dry-run]
"""
import argparse
import csv
import datetime
import os
import re
import sys
import urllib.request

URL = "https://egcurrency.com/en/currency/USD-to-MMK/blackMarket"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; GoldCurrencyTrackerBot/1.0; "
        "+https://github.com/Whitey999/tracker) usd-rate-daily-update"
    )
}

# Sanity bounds: the black market rate should be well above the ~2,100
# official rate. Anything outside this range is treated as a bad parse,
# not written -- never a fabricated fallback.
RATE_MIN, RATE_MAX = 2500, 8000


def fetch_html():
    req = urllib.request.Request(URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def html_to_text(html):
    # Lightweight tag stripper -- avoids requiring beautifulsoup4 as a
    # dependency for such a simple extraction. Collapses tags to newlines
    # so numbers stay separated the same way they appear on the page.
    text = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text


def parse_rates(text):
    """Returns (buy, sell) or None."""
    sell_m = re.search(r"Sell Price:\s*\n?\s*([\d,]+\.?\d*)", text)
    if not sell_m:
        return None
    sell = float(sell_m.group(1).replace(",", ""))

    # The buy/market rate is the number immediately preceding "Sell Price:".
    pre_text = text[: sell_m.start()]
    buy_m = re.findall(r"([\d,]+\.\d+)\s*$", pre_text.strip())
    if not buy_m:
        # fallback: any plausible number in the 500 chars before "Sell Price:"
        buy_m = re.findall(r"([\d,]+\.\d+)", pre_text[-500:])
    if not buy_m:
        return None
    buy = float(buy_m[-1].replace(",", ""))

    if not (RATE_MIN <= buy <= RATE_MAX and RATE_MIN <= sell <= RATE_MAX):
        return None
    return buy, sell


def load_existing(path):
    rows = {}
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                rows[r["date"]] = r
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="usd_history.csv")
    ap.add_argument("--dry-run", action="store_true",
                     help="Print the parsed rate but don't write the CSV")
    args = ap.parse_args()

    try:
        html = fetch_html()
    except Exception as e:
        print(f"FAILED to fetch {URL}: {e}", file=sys.stderr)
        sys.exit(1)

    text = html_to_text(html)
    result = parse_rates(text)
    if not result:
        print("FAILED to parse a plausible rate from the page.", file=sys.stderr)
        print("The page layout may have changed -- inspect the HTML and", file=sys.stderr)
        print("update parse_rates() accordingly. No fallback number was used.", file=sys.stderr)
        sys.exit(1)

    buy, sell = result
    today = datetime.date.today().isoformat()
    print(f"Parsed real rate for {today}: buy={buy} sell={sell}")

    if args.dry_run:
        print("(--dry-run: not writing to CSV)")
        return

    rows = load_existing(args.csv)
    rows[today] = {"date": today, "usd_mmk_buy": buy, "usd_mmk_sell": sell,
                    "source": "egcurrency.com-blackmarket"}

    with open(args.csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "usd_mmk_buy", "usd_mmk_sell", "source"])
        for date_str in sorted(rows):
            r = rows[date_str]
            w.writerow([r["date"], r["usd_mmk_buy"], r["usd_mmk_sell"], r["source"]])

    print(f"Wrote {len(rows)} total rows to {args.csv}")


if __name__ == "__main__":
    main()
