# USD/MMK real-data pipeline

Replaces the dead `myanmar-currency-api.github.io` live API and the
fabricated client-side daily history with real, server-side sourced data
-- following the same pattern as `gold_history.csv` + `forecast.json`.

## One-time setup

1. **Backfill real historical data** (2024-04-08 to 2024-06-21, the
   only period the old community API was actually maintained):

   ```bash
   pip install --user requests   # only stdlib used, but harmless if you have it
   python pipeline/backfill_usd_history.py --out usd_history.csv --token YOUR_GITHUB_TOKEN
   ```

   The `--token` is optional but avoids GitHub's 60-req/hour unauthenticated
   limit (a plain read-only PAT is enough). Without it the script will
   pause and retry when rate-limited, just slower.

   This writes `usd_history.csv` at the repo root with columns:
   `date,usd_mmk_buy,usd_mmk_sell,source`

2. **Verify the daily scraper before automating it:**

   ```bash
   python pipeline/update_usd_rate.py --dry-run
   ```

   It should print a rate in the ~3,000-6,000 MMK range (clearly
   different from the ~2,100 official CBM rate). If it fails to parse,
   see the caveat comment at the top of `update_usd_rate.py` -- the
   scraper was written from a text-rendered snapshot of the page, not
   tested against live HTML, so it may need a small regex tweak.

3. **Commit `usd_history.csv`** and add `pipeline/update_usd_rate.py` to
   your repo.

4. **Add the workflow:** copy `update_usd.yml` into
   `.github/workflows/update_usd.yml` in your repo. It will run daily
   and append that day's real rate.

## What the frontend does now

`script.js` fetches `usd_history.csv` directly from
`raw.githubusercontent.com/Whitey999/tracker/main/usd_history.csv` --
same pattern as `forecast.json`. The last row is used as "today's live
rate," and the full set of rows is the real (not fabricated) daily/weekly
history for charts and the annual aggregate. No more client-side API
calls, no CORS risk, no stale/dead API.

There will be a gap between 2024-06-21 (when the old API died) and
whenever you run the backfill + turn on the daily workflow -- that gap
is simply absent from the chart rather than filled with an invented
number, consistent with how the rest of the app already treats missing
real data.
