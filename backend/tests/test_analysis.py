import numpy as np
import pandas as pd

import analysis


def series(n=240, seed=0):
    idx = pd.date_range("2000-01-01", periods=n, freq="MS")
    rng = np.random.default_rng(seed)
    season = np.sin(idx.month / 12 * 2 * np.pi)
    x = pd.Series(season * 10 + rng.normal(0, 1, n), index=idx)
    return idx, season, x


def test_deseasonalise_removes_calendar_correlation():
    idx, season, x = series()
    rng = np.random.default_rng(5)
    y = pd.Series(season * 5 + rng.normal(0, 1, len(idx)), index=idx)
    w = pd.DataFrame({"x": x, "y": y})
    raw = analysis.pair(w.x, w.y)["r"]
    anom = analysis.pair(analysis.deseasonalise(w, ["x", "y"]).x, analysis.deseasonalise(w, ["x", "y"]).y)["r"]
    assert raw > 0.9 and abs(anom) < 0.3  # shared season explains the raw correlation, not a real link


def test_lag_finds_planted_delay():
    idx, _, x = series(seed=2)
    y = x.shift(3) + np.random.default_rng(3).normal(0, .5, len(x))  # y follows x by 3 months
    w = pd.DataFrame({"x": x, "y": y})
    best = max((r for r in analysis.lagged(w, "x", "y", 6) if r["r"] is not None), key=lambda r: r["r"])
    assert best["lag"] == 3


def test_pair_handles_gaps_and_short_data():
    a = pd.Series([1.0, 2, 3, None, 5]); b = pd.Series([2.0, 4, 6, 8, None])
    assert analysis.pair(a, b)["r"] is None  # only 3 overlapping points


def test_autocorrelation_widens_p_value():
    idx = pd.date_range("2000-01-01", periods=200, freq="MS")
    walk = pd.Series(np.cumsum(np.random.default_rng(9).normal(size=200)), index=idx)
    other = pd.Series(np.cumsum(np.random.default_rng(10).normal(size=200)), index=idx)
    res = analysis.pair(walk, other)
    assert res["n_eff"] < res["n"] / 2


def test_trend_complete_years_only_and_direction():
    idx = pd.date_range("1996-01-01", "2025-06-01", freq="MS")  # 2025 is incomplete
    t = pd.DataFrame({"t2m": 25 + 0.03 * (idx.year - 1996)}, index=idx)
    r = analysis.trends(t, ["t2m"])["t2m"]
    assert r["end_year"] == 2024 and r["direction"] == "increasing" and abs(r["slope_per_decade"] - 0.3) < 0.01


def test_annual_rain_sums_other_means():
    idx = pd.date_range("2001-01-01", "2001-12-01", freq="MS")
    w = pd.DataFrame({"rain_mm": 10.0, "t2m": 20.0}, index=idx)
    a = analysis.annual(w, ["rain_mm", "t2m"])
    assert a.loc[2001, "rain_mm"] == 120 and a.loc[2001, "t2m"] == 20
