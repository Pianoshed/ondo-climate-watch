"""Correlation and trend analysis for the climate (and survey) indicators. Pure functions on DataFrames, no Flask.

Why the options exist:
  * Climate variables share a strong seasonal cycle, so raw monthly correlations mostly measure the calendar
    (rain and humidity look 0.76 correlated but the month-to-month anomalies much less). deseasonalise=True removes
    each month-of-year's mean first, which is the right default for asking "do they move together?".
  * Monthly data are autocorrelated, so a naive p-value is far too small. p-values here use an effective
    sample size (Bretherton et al. 1999: n_eff = n (1 - r1x r1y) / (1 + r1x r1y)).
  * Trends use complete years (12 months), Theil-Sen slope and a Kendall-tau (Mann-Kendall) p-value, which are
    robust to outliers and need no normality."""
import numpy as np
import pandas as pd
from scipy import stats

ADDITIVE = {"rain_mm", "era5_rain_mm"}  # summed over a year; everything else is averaged
MIN_PAIRS = 8


def wide(df, cols, scope="state", lgas=None):
    """Long rows (lga, year, month, <cols>) -> one row per month. scope: 'state' (mean over the LGAs given)
    or an LGA name. Months are sorted; an index of the first of each month."""
    d = df if not lgas else df[df["lga"].isin(lgas)]
    if scope not in ("state", None):
        d = d[d["lga"] == scope]
    w = d.groupby(["year", "month"])[cols].mean().reset_index()
    w["date"] = pd.to_datetime(dict(year=w["year"], month=w["month"], day=1))
    return w.sort_values("date").set_index("date")


def deseasonalise(w, cols):
    out = w.copy()
    for c in cols:
        out[c] = w[c] - w.groupby(w.index.month)[c].transform("mean")
    return out


def _lag1(x):
    x = x.dropna()
    return float(x.autocorr(1)) if len(x) > 3 else 0.0


def pair(x, y, method="pearson"):
    """r, p (autocorrelation-adjusted), n and n_eff for two aligned Series. None if too few overlapping points."""
    d = pd.concat([x, y], axis=1, keys=["x", "y"]).dropna()
    n = len(d)
    if n < MIN_PAIRS or d["x"].nunique() < 2 or d["y"].nunique() < 2:
        return {"r": None, "p": None, "n": n, "n_eff": None}
    r = float(d["x"].corr(d["y"], method=method))
    rx, ry = _lag1(d["x"]), _lag1(d["y"])
    prod = max(0.0, rx * ry)
    n_eff = max(3.0, n * (1 - prod) / (1 + prod))
    t = r * np.sqrt((n_eff - 2) / max(1e-12, 1 - r * r))
    p = float(2 * stats.t.sf(abs(t), n_eff - 2))
    return {"r": round(r, 3), "p": round(p, 4), "n": n, "n_eff": round(float(n_eff), 1)}


def matrix(w, cols, method="pearson"):
    return [{"a": a, "b": b, **pair(w[a], w[b], method)} for a in cols for b in cols]


def lagged(w, a, b, max_lag=12, method="pearson"):
    """Correlation of a(t) with b(t+lag). Positive lag = b responds after a (e.g. rain then cases)."""
    out = []
    for lag in range(-max_lag, max_lag + 1):
        out.append({"lag": lag, **pair(w[a], w[b].shift(-lag), method)})
    return out


def annual(w, cols):
    """Yearly values from complete years only (12 months with data): totals for rainfall, means otherwise."""
    g = w.groupby(w.index.year)
    out = pd.DataFrame(index=sorted(g.groups))
    for c in cols:
        agg = g[c].agg(["count", "sum", "mean"])
        v = agg["sum"] if c in ADDITIVE else agg["mean"]
        out[c] = v.where(agg["count"] == 12)
    return out


def trend(series):
    """Theil-Sen slope per decade, Kendall-tau p-value and the fitted start/end values for a yearly Series."""
    s = series.dropna()
    if len(s) < 6:
        return {"slope_per_decade": None, "p": None, "n_years": len(s), "direction": "not enough complete years"}
    ts = stats.theilslopes(s.values, s.index.values.astype(float))
    tau = stats.kendalltau(s.index.values, s.values)
    p = float(tau.pvalue)
    return {"slope_per_decade": round(float(ts[0]) * 10, 3), "p": round(p, 4), "n_years": int(len(s)),
            "start_year": int(s.index.min()), "end_year": int(s.index.max()),
            "fit_start": round(float(ts[1] + ts[0] * s.index.min()), 3),
            "fit_end": round(float(ts[1] + ts[0] * s.index.max()), 3),
            "direction": ("no clear trend" if p >= 0.05 else "increasing" if ts[0] > 0 else "decreasing")}


def trends(w, cols):
    a = annual(w, cols)
    return {c: {**trend(a[c]), "annual": [{"year": int(y), "value": None if pd.isna(v) else round(float(v), 3)}
                                           for y, v in a[c].items()]} for c in cols}


def cross_section(x, y, method="pearson"):
    """Correlation across areas (e.g. 18 LGAs): plain p-value, no autocorrelation adjustment. Returns r, p, n and points."""
    d = pd.concat([x, y], axis=1, keys=["x", "y"]).dropna()
    if len(d) < 5 or d["x"].nunique() < 2 or d["y"].nunique() < 2:
        return {"r": None, "p": None, "n": len(d), "points": []}
    f = stats.spearmanr if method == "spearman" else stats.pearsonr
    res = f(d["x"], d["y"])
    return {"r": round(float(res[0]), 3), "p": round(float(res[1]), 4), "n": int(len(d)),
            "points": [{"lga": k, "x": float(r.x), "y": float(r.y)} for k, r in d.iterrows()]}
