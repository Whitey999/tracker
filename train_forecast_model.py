#!/usr/bin/env python3
"""
train_forecast_model.py — SARIMA-based 7-day gold price forecast.

WHAT THIS DOES
--------------
1. Loads gold_history.csv (built by gold_data_collector.py +
   backfill_gold_history.py).
2. Keeps only the DAILY-resolution era of the data (SARIMA needs a
   regular time step; the older annual/monthly rows aren't usable
   directly here — they're a different sampling frequency).
3. Fits a SARIMA model and forecasts the next 7 days of
   gold_mmk_per_tical, with confidence intervals.

IMPORTANT — ABOUT THE INTERNAL GAP
-----------------------------------
There's a real gap in the daily data (freegoldapi.com's feed stalled for
a few months, and GoldAPI.io's key doesn't have historical access on the
free tier). SARIMA cannot work with irregular/missing timestamps, so
this script linearly interpolates ONLY across that internal gap to
build a continuous daily index FOR MODEL TRAINING PURPOSES.

This is standard time-series preprocessing (missing-value imputation),
not the same thing as showing fabricated data to a user as if it were
real — it never touches gold_history.csv or the website; it only exists
in memory while fitting the model. The interpolated stretch is clearly
logged below so you always know exactly how much of the training input
was real vs. filled in.

INSTALL (one-time)
-------------------
    pip install pandas statsmodels

USAGE
-----
    python3 train_forecast_model.py
"""

import csv
import json
import os
import sys
from datetime import datetime, timedelta

try:
    import pandas as pd
    import numpy as np
    from statsmodels.tsa.statespace.sarimax import SARIMAX
except ImportError:
    print("Missing packages. Install them first with:\n"
          "    pip install pandas statsmodels\n", file=sys.stderr)
    sys.exit(1)

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_history.csv")
JSON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forecast.json")
FORECAST_DAYS = 7  # business/trading days ahead (gold doesn't trade weekends,
                    # so this spans roughly 9-10 calendar days, not a literal week)

# Only rows from this date onward are treated as "daily resolution".
# Everything before this is annual/monthly and gets excluded from SARIMA
# training (it's a different sampling frequency and would distort the
# model if mixed in directly).
DAILY_ERA_START = "2025-01-01"


def load_daily_series():
    if not os.path.exists(CSV_PATH):
        print(f"ERROR: {CSV_PATH} not found. Run gold_data_collector.py / "
              f"backfill_gold_history.py first.", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(CSV_PATH, parse_dates=["date"])
    df = df[df["date"] >= DAILY_ERA_START].sort_values("date")
    df = df.drop_duplicates(subset="date", keep="last")

    if len(df) < 30:
        print(f"WARNING: only {len(df)} daily rows since {DAILY_ERA_START} — "
              f"a SARIMA forecast will be very uncertain with this little data.")

    series = df.set_index("date")["gold_mmk_per_tical"].astype(float)

    # Reindex to a business-day calendar (Mon–Fri only — gold markets are
    # closed weekends, so weekends are NOT gaps and shouldn't be
    # interpolated). Only genuine missing weekdays get filled in.
    full_index = pd.bdate_range(series.index.min(), series.index.max())
    real_count = len(series)
    reindexed = series.reindex(full_index)
    missing_count = reindexed.isna().sum()
    filled = reindexed.interpolate(method="linear")

    print(f"Daily-era training data: {real_count} real weekdays, "
          f"{missing_count} interpolated weekday(s) to fill internal gaps "
          f"({real_count} real / {len(filled)} total = "
          f"{100*real_count/len(filled):.1f}% real).")

    meta = {
        "real_days": int(real_count),
        "interpolated_days": int(missing_count),
        "pct_real": round(100 * real_count / len(filled), 1),
    }
    return filled, meta


def fit_and_forecast(series):
    # Work in log-space: gold prices grow roughly multiplicatively (with
    # MMK depreciation compounding on top), so modeling log(price) keeps
    # growth additive and prevents the raw-price model from extrapolating
    # runaway/explosive forecasts.
    log_series = np.log(series)

    # A conservative "airline model"-style order — simpler than a full
    # (1,1,1)x(1,1,1,5) fit, which was prone to overfitting recent
    # momentum on this amount of data and producing unrealistic forecasts.
    # enforce_stationarity/invertibility are back to their safe defaults
    # (True) specifically to prevent explosive extrapolation.
    model = SARIMAX(
        log_series,
        order=(1, 1, 0),
        seasonal_order=(0, 1, 1, 5),   # weekly seasonality (5 business days)
        enforce_stationarity=True,
        enforce_invertibility=True,
    )
    print("\nFitting SARIMA(1,1,0)x(0,1,1,5) on log(price)... (this can take a minute)")
    fitted = model.fit(disp=False)

    forecast = fitted.get_forecast(steps=FORECAST_DAYS)
    mean_log = forecast.predicted_mean
    ci_log = forecast.conf_int(alpha=0.20)  # 80% confidence interval

    # Back-transform from log-space to actual MMK/tical values
    mean = np.exp(mean_log)
    ci = np.exp(ci_log)

    return fitted, mean, ci


def main():
    series, meta = load_daily_series()
    fitted, mean, ci = fit_and_forecast(series)

    last_real_date = series.index.max()
    last_real_value = series.iloc[-1]

    print(f"\nLast known price ({last_real_date.date()}): "
          f"{last_real_value:,.0f} MMK/tical\n")

    print(f"{'Date':<12} {'Forecast (MMK/tical)':>22} {'80% range':>28}")
    print("-" * 64)
    for date, value, (lo, hi) in zip(mean.index, mean.values, ci.values):
        print(f"{date.date()!s:<12} {value:>22,.0f} {f'{lo:,.0f} – {hi:,.0f}':>28}")

    print(f"\nModel diagnostics: AIC={fitted.aic:.1f}  "
          f"(lower is generally better when comparing model variants)")

    pct_change = (mean.iloc[-1] - last_real_value) / last_real_value * 100
    warning = None
    if abs(pct_change) > 8:
        warning = (f"This forecast implies a {pct_change:+.1f}% move over "
                   f"{FORECAST_DAYS} trading days, which is unusually large for "
                   f"gold. Treat it with caution.")
        print(f"\n⚠️  WARNING: {warning}")

    print("\nNOTE: this is a first baseline model. As more real daily data")
    print("accumulates from gold_data_collector.py, re-run this script to")
    print("get an updated, more reliable forecast — and consider comparing")
    print("against a scikit-learn model once you have a few months of data.")

    # ── Write forecast.json for the website to fetch and display ──
    output = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": "SARIMA(1,1,0)x(0,1,1,5) on log(price)",
        "aic": round(float(fitted.aic), 1),
        "data_quality": meta,
        "last_real": {
            "date": last_real_date.date().isoformat(),
            "value": round(float(last_real_value)),
        },
        "forecast": [
            {
                "date": d.date().isoformat(),
                "value": round(float(v)),
                "low": round(float(lo)),
                "high": round(float(hi)),
            }
            for d, v, (lo, hi) in zip(mean.index, mean.values, ci.values)
        ],
        "warning": warning,
    }
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"\nWrote {JSON_PATH}")


if __name__ == "__main__":
    main()
