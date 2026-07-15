#!/usr/bin/env python3
"""
train_forecast_sklearn.py — scikit-learn (Gradient Boosting) 7-day gold
forecast, with a walk-forward backtest comparing it directly against the
SARIMA model (train_forecast_model.py) on the SAME held-out real days.

WHY THIS EXISTS
----------------
train_forecast_model.py picks SARIMA as a baseline. This script builds a
second, independent model (lag/rolling features + Gradient Boosting) and
backtests BOTH models on the same recent real data, so the choice between
them is decided by evidence (RMSE/MAE) rather than assumption.

METHOD
------
1. Load the same daily-era series used by train_forecast_model.py.
2. Walk-forward backtest: hold out the last TEST_DAYS real trading days.
   Train both models on everything before that, forecast forward, and
   compare each day's prediction against the REAL value that actually
   happened (never seen during training).
3. Whichever model has lower RMSE/MAE on this real held-out data wins —
   printed as a clear comparison table.
4. Finally, refit the sklearn model on ALL available data and produce the
   actual next-7-trading-day forecast (same as train_forecast_model.py
   does for SARIMA), for use if sklearn turns out to be the better model.

INSTALL (one-time)
-------------------
    pip install pandas scikit-learn statsmodels

USAGE
-----
    python3 train_forecast_sklearn.py
"""

import json
import os
import sys
from datetime import datetime

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import GradientBoostingRegressor
    from statsmodels.tsa.statespace.sarimax import SARIMAX
except ImportError:
    print("Missing packages. Install them first with:\n"
          "    pip install pandas scikit-learn statsmodels\n", file=sys.stderr)
    sys.exit(1)

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_history.csv")
JSON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forecast_sklearn.json")
DAILY_ERA_START = "2025-01-01"
FORECAST_DAYS = 7      # trading days ahead for the final forecast
TEST_DAYS = 14          # held-out real days used for the SARIMA-vs-sklearn backtest
LAGS = [1, 2, 3, 5, 7, 14]
ROLLING_WINDOWS = [7, 14, 30]


# ── Shared data loading (same logic as train_forecast_model.py) ──────
def load_daily_series():
    if not os.path.exists(CSV_PATH):
        print(f"ERROR: {CSV_PATH} not found. Run gold_data_collector.py / "
              f"backfill_gold_history.py first.", file=sys.stderr)
        sys.exit(1)
    df = pd.read_csv(CSV_PATH, parse_dates=["date"])
    df = df[df["date"] >= DAILY_ERA_START].sort_values("date")
    df = df.drop_duplicates(subset="date", keep="last")
    series = df.set_index("date")["gold_mmk_per_tical"].astype(float)
    full_index = pd.bdate_range(series.index.min(), series.index.max())
    real_count = len(series)
    reindexed = series.reindex(full_index)
    filled = reindexed.interpolate(method="linear")
    print(f"Loaded {real_count} real weekdays, {len(filled)} total after "
          f"filling internal gaps ({100*real_count/len(filled):.1f}% real).")
    return filled


# ── Feature engineering for the sklearn model ─────────────────────────
def build_features(series):
    df = pd.DataFrame({"y": series})
    for lag in LAGS:
        df[f"lag_{lag}"] = df["y"].shift(lag)
    for w in ROLLING_WINDOWS:
        df[f"roll_mean_{w}"] = df["y"].shift(1).rolling(w).mean()
        df[f"roll_std_{w}"] = df["y"].shift(1).rolling(w).std()
    df["dow"] = df.index.dayofweek
    return df.dropna()


def fit_sklearn(train_series):
    feat = build_features(train_series)
    X = feat.drop(columns=["y"])
    y = feat["y"]
    model = GradientBoostingRegressor(
        n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42
    )
    model.fit(X, y)
    return model


def sklearn_forecast(model, history_series, steps):
    """Iteratively forecast forward, feeding each prediction back in as a
    lag feature for the next step (standard autoregressive rollout)."""
    history = history_series.copy()
    preds = []
    for i in range(steps):
        next_date = history.index[-1] + pd.tseries.offsets.BDay(1)
        tmp = pd.DataFrame({"y": pd.concat([history, pd.Series([np.nan], index=[next_date])])})
        for lag in LAGS:
            tmp[f"lag_{lag}"] = tmp["y"].shift(lag)
        for w in ROLLING_WINDOWS:
            tmp[f"roll_mean_{w}"] = tmp["y"].shift(1).rolling(w).mean()
            tmp[f"roll_std_{w}"] = tmp["y"].shift(1).rolling(w).std()
        tmp["dow"] = tmp.index.dayofweek
        x_next = tmp.drop(columns=["y"]).iloc[[-1]]
        pred = model.predict(x_next)[0]
        preds.append((next_date, pred))
        history = pd.concat([history, pd.Series([pred], index=[next_date])])
    return preds


# ── SARIMA (same config as train_forecast_model.py) for backtest comparison ──
def fit_sarima_and_forecast(train_series, steps):
    log_series = np.log(train_series)
    model = SARIMAX(
        log_series, order=(1, 1, 0), seasonal_order=(0, 1, 1, 5),
        enforce_stationarity=True, enforce_invertibility=True,
    )
    fitted = model.fit(disp=False)
    fc = fitted.get_forecast(steps=steps)
    return np.exp(fc.predicted_mean)


def rmse(a, b): return float(np.sqrt(np.mean((np.array(a) - np.array(b)) ** 2)))
def mae(a, b):  return float(np.mean(np.abs(np.array(a) - np.array(b))))


def backtest(series):
    if len(series) < TEST_DAYS + 60:
        print(f"WARNING: only {len(series)} data points — backtest with "
              f"{TEST_DAYS} held-out days may be unreliable with this little history.")

    train = series.iloc[:-TEST_DAYS]
    test = series.iloc[-TEST_DAYS:]

    print(f"\nBacktesting on last {TEST_DAYS} real trading days "
          f"({test.index[0].date()} to {test.index[-1].date()})...")

    # SARIMA backtest
    sarima_fc = fit_sarima_and_forecast(train, TEST_DAYS)
    sarima_preds = sarima_fc.values

    # sklearn backtest
    sk_model = fit_sklearn(train)
    sk_preds_raw = sklearn_forecast(sk_model, train, TEST_DAYS)
    sk_preds = [p for _, p in sk_preds_raw]

    actual = test.values

    results = {
        "SARIMA":        {"rmse": rmse(actual, sarima_preds), "mae": mae(actual, sarima_preds)},
        "sklearn (GBR)":  {"rmse": rmse(actual, sk_preds),      "mae": mae(actual, sk_preds)},
    }

    print(f"\n{'Model':<16} {'RMSE (MMK)':>16} {'MAE (MMK)':>16}")
    print("-" * 50)
    for name, m in results.items():
        print(f"{name:<16} {m['rmse']:>16,.0f} {m['mae']:>16,.0f}")

    winner = min(results, key=lambda k: results[k]["rmse"])
    print(f"\n>>> Lower RMSE on real held-out data: {winner}")
    return results, winner


def main():
    series = load_daily_series()
    results, winner = backtest(series)

    # Refit sklearn on ALL data and produce the actual forward forecast
    full_model = fit_sklearn(series)
    forecast = sklearn_forecast(full_model, series, FORECAST_DAYS)

    last_real_date = series.index.max()
    last_real_value = series.iloc[-1]
    print(f"\nLast known price ({last_real_date.date()}): {last_real_value:,.0f} MMK/tical\n")
    print(f"{'Date':<12} {'sklearn Forecast (MMK/tical)':>28}")
    print("-" * 42)
    for d, v in forecast:
        print(f"{d.date()!s:<12} {v:>28,.0f}")

    print(f"\nNOTE: Compare the RMSE/MAE table above — use whichever model")
    print(f"scored lower as the one shown on the website. Re-run this")
    print(f"backtest periodically as more real data accumulates; the winner")
    print(f"can change over time.")

    output = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": "GradientBoostingRegressor (scikit-learn)",
        "backtest": {
            "test_days": TEST_DAYS,
            "results": results,
            "winner": winner,
        },
        "last_real": {"date": last_real_date.date().isoformat(), "value": round(float(last_real_value))},
        "forecast": [{"date": d.date().isoformat(), "value": round(float(v))} for d, v in forecast],
    }
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"\nWrote {JSON_PATH}")


if __name__ == "__main__":
    main()
