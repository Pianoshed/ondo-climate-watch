"""Flood, heat-wave and wind indicators for every Ondo LGA, from daily ERA5 reanalysis (Open-Meteo archive API).

    python hazards.py                  # first run: 1996 to a week ago; later runs only fetch the newest days
    python hazards.py --refresh        # throw the downloaded daily files away and start again
    python hazards.py --base-end 2020  # years used for the "unusually hot" and "extreme rain" thresholds

One point per LGA (the centroid already stored by load-boundaries). The daily files are cached in
data/cache/hazards/, the indicators are written to the hazard_* tables and served by /api/hazards.
Open-Meteo is free for non-commercial use and its data is CC BY 4.0: keep the attribution in the app."""
import argparse
import json
import re
import time
import warnings
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv
from sqlalchemy import delete, select

import db

# harmless pandas/NumPy version-mismatch warning ("'generic' unit for NumPy timedelta")
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*'generic' unit.*")

API = "https://archive-api.open-meteo.com/v1/archive"
DAILY = "temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant"
RENAME = {"temperature_2m_max": "tmax", "precipitation_sum": "rain", "wind_speed_10m_max": "wspd",
          "wind_gusts_10m_max": "gust", "wind_direction_10m_dominant": "wdir"}
CACHE = Path(__file__).parent / "data" / "cache" / "hazards"
SOURCE = "ERA5 reanalysis (ECMWF / Copernicus) via Open-Meteo, CC BY 4.0. One point per LGA centroid, daily."
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
RAINY, DRY = [4, 5, 6, 7, 8, 9, 10], [11, 12, 1, 2, 3]
SEASONS = {"all": None, "rainy": RAINY, "dry": DRY}
LAG_DAYS = 7  # the archive trails real time by a few days
REFETCH_DAYS = 10  # newest days are preliminary, so they are downloaded again on the next run
BASE_START, BASE_END = 1996, 2020

# key: (label, unit, group, what it means)
METRICS = {
    "rx1day": ("Wettest day of the year", "mm", "flood", "Highest one-day rainfall in the year."),
    "rx5day": ("Wettest 5 days of the year", "mm", "flood",
               "Highest rainfall over any 5 days in a row. Long wet spells saturate soil and fill rivers."),
    "heavy_days_50mm": ("Heavy-rain days (50 mm or more)", "days", "flood", "Days with at least 50 mm of rain."),
    "flood_alert_days": ("Flood-alert days (100 mm in 3 days)", "days", "flood",
                         "Days on which the last 3 days added up to 100 mm or more."),
    "extreme_days_p99": ("Extreme-rain days", "days", "flood",
                         "Days wetter than the 99th percentile of this LGA's own rainy days."),
    "annual_rain": ("Yearly rainfall", "mm", "flood", "Total rain in the year."),
    "heatwave_days": ("Heat-wave days", "days", "heat",
                      "Days inside a heat wave: 3 or more days in a row with max temperature above the LGA's own "
                      "90th percentile for that time of year."),
    "heatwave_events": ("Heat-wave events", "events", "heat", "Number of separate heat waves starting in the year."),
    "heatwave_longest": ("Longest heat wave", "days", "heat", "Length of the longest heat wave starting in the year."),
    "hot_days_35": ("Days at or above 35 °C", "days", "heat", "Days when the maximum temperature reached 35 °C or more."),
    "tmax_peak": ("Hottest day of the year", "°C", "heat", "Highest daily maximum temperature."),
    "mean_wind": ("Average wind speed", "m/s", "wind", "Mean of the daily maximum 10 m wind speed."),
    "max_gust": ("Strongest gust", "m/s", "wind", "Highest daily wind gust."),
    "gust_days_ge14": ("Strong-gust days (14 m/s or more)", "days", "wind",
                       "Days with gusts of 14 m/s (about 50 km/h) or more, the start of a damaging wind."),
}
SEASONAL = {"heavy_days_50mm": "flood", "heatwave_days": "heat", "gust_days_ge14": "wind"}  # metric -> hazard tab


# ---------- download ----------
def fetch(lat, lon, start, end, tries=8):
    p = {"latitude": round(lat, 4), "longitude": round(lon, 4), "start_date": start, "end_date": end, "daily": DAILY,
         "wind_speed_unit": "ms", "timezone": "Africa/Lagos", "models": "era5"}
    for i in range(tries):
        r = requests.get(API, params=p, timeout=180)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            try:
                reason = r.json().get("reason", "")
            except ValueError:
                reason = ""
            low = reason.lower()
            if "daily" in low:
                raise SystemExit(f"Daily limit hit. Rerun tomorrow, finished LGAs are cached.\n{reason}")
            if "hourly" in low:
                t = time.localtime()
                wait = (60 - t.tm_min) * 60 - t.tm_sec + 30  # until just after the next hour
            else:
                wait = 65
            print(f"   rate limited ({reason or '429'}), waiting {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
    raise RuntimeError("Open-Meteo kept refusing the request. Try again in an hour.")


def download(lat, lon, start, end, pause):
    parts, y0, y1 = [], int(start[:4]), int(end[:4])
    for ys in range(y0, y1 + 1, 10):  # 10-year requests keep each call small
        a, b = max(start, f"{ys}-01-01"), min(end, f"{min(ys + 9, y1)}-12-31")
        parts.append(pd.DataFrame(fetch(lat, lon, a, b)["daily"]).set_index("time").rename(columns=RENAME))
        time.sleep(pause)
    d = pd.concat(parts)
    d.index = pd.to_datetime(d.index)
    d.index.name = "date"
    return d


def get_daily(name, lat, lon, start, end, refresh=False, pause=2.0):
    """Daily frame for one LGA. Cached on disk; a later run only downloads the days since the last one."""
    path = CACHE / (re.sub(r"[^a-z0-9]+", "_", name.lower()) + ".csv")
    old = pd.read_csv(path, index_col=0, parse_dates=True) if path.exists() and not refresh else None
    first = pd.Timestamp(start)
    if old is not None and len(old):
        first = max(first, old.index.max() - pd.Timedelta(days=REFETCH_DAYS))
        if first > pd.Timestamp(end):
            return old
    new = download(lat, lon, first.strftime("%Y-%m-%d"), end, pause)
    d = new if old is None else pd.concat([old, new])
    d = d[~d.index.duplicated(keep="last")].sort_index()
    CACHE.mkdir(parents=True, exist_ok=True)
    d.to_csv(path)
    return d


# ---------- indicators (daily frame -> one row per year) ----------
def flood(d, b0, b1):
    r = d["rain"].fillna(0)
    y = r.index.year
    wet = r[(y >= b0) & (y <= b1) & (r >= 1)]
    p99 = wet.quantile(0.99) if len(wet) else np.nan
    g = lambda s: s.groupby(s.index.year)  # noqa: E731
    return pd.DataFrame({
        "rx1day": g(r).max(), "rx5day": g(r.rolling(5).sum()).max(),
        "heavy_days_50mm": g((r >= 50).astype(int)).sum(),
        "flood_alert_days": g((r.rolling(3).sum() >= 100).astype(int)).sum(),
        "extreme_days_p99": g((r > p99).astype(int)).sum(), "annual_rain": g(r).sum(),
    })


def heat(d, b0, b1):
    """Heat wave = 3+ days in a row above the LGA's own 90th percentile for that calendar day (15-day window)."""
    t = d["tmax"]
    yr, doy = d.index.year.values, np.minimum(d.index.dayofyear.values, 365)
    m = (yr >= b0) & (yr <= b1)
    bt, bd = t.values[m], doy[m]
    thr = np.full(366, np.nan)
    for k in range(1, 366):  # window wraps at the end of the year
        v = bt[np.isin(bd, ((k - 1 + np.arange(-7, 8)) % 365) + 1)]
        v = v[~np.isnan(v)]
        if len(v) > 20:
            thr[k] = np.percentile(v, 90)
    df = pd.DataFrame({"hot": t.values > thr[doy], "date": d.index}, index=d.index)
    df["run"] = (df["hot"] != df["hot"].shift()).cumsum()
    info = df.groupby("run").agg(hot=("hot", "first"), n=("hot", "size"), start=("date", "min"))
    ev = info[info["hot"] & (info["n"] >= 3)]
    df["ev"] = df["run"].isin(ev.index).astype(int)
    ys = ev["start"].dt.year
    out = pd.DataFrame({
        "heatwave_days": df.groupby(df.index.year)["ev"].sum(),
        "heatwave_events": ev.groupby(ys).size(), "heatwave_longest": ev.groupby(ys)["n"].max(),
        "hot_days_35": (t >= 35).astype(int).groupby(t.index.year).sum(), "tmax_peak": t.groupby(t.index.year).max(),
    })
    out[["heatwave_events", "heatwave_longest"]] = out[["heatwave_events", "heatwave_longest"]].fillna(0)
    return out, df["ev"]


def wind(d):
    w, g = d["wspd"], d["gust"]
    return pd.DataFrame({"mean_wind": w.groupby(w.index.year).mean(), "max_gust": g.groupby(g.index.year).max(),
                         "gust_days_ge14": (g >= 14).astype(int).groupby(g.index.year).sum()})


def rose(d, months=None):
    """Share of days (%) the wind blew FROM each of 8 sectors, and the mean speed in each."""
    x = d.dropna(subset=["wdir", "wspd"])
    if months:
        x = x[x.index.month.isin(months)]
    if not len(x):
        return [0.0] * 8, [None] * 8
    sec = (((x["wdir"] + 22.5) % 360) // 45).astype(int)
    freq = np.bincount(sec, minlength=8) / len(x) * 100
    speed = x["wspd"].groupby(sec).mean().reindex(range(8))
    return [float(v) for v in freq], [None if pd.isna(v) else float(v) for v in speed]


def compute(daily, b0=BASE_START, b1=BASE_END):
    """{lga: daily frame} -> (yearly rows, seasonal rows, wind-rose rows, years). Only complete years are kept."""
    counts = [d.index.year.value_counts() for d in daily.values()]
    years = sorted(set.intersection(*[set(c[c >= 360].index) for c in counts]))
    if not years:
        raise ValueError("No complete year of data. Download at least one full calendar year.")
    yr, se, ro = [], [], []
    for name, d in daily.items():
        h, ev = heat(d, b0, b1)
        yearly = pd.concat([flood(d, b0, b1), h, wind(d)], axis=1).reindex(years)
        yr += [{"lga": name, "year": int(y), "metric": k, "value": float(v)}
               for k in METRICS for y, v in yearly[k].items() if not pd.isna(v)]
        for k, src in (("heavy_days_50mm", (d["rain"].fillna(0) >= 50).astype(int)), ("heatwave_days", ev),
                       ("gust_days_ge14", (d["gust"] >= 14).astype(int))):
            s = src[src.index.year.isin(years)]
            per = s.groupby([s.index.year, s.index.month]).sum().groupby(level=1).mean().reindex(range(1, 13))
            se += [{"lga": name, "metric": k, "month": int(m), "value": float(v)} for m, v in per.items() if not pd.isna(v)]
        for season, months in SEASONS.items():
            freq, speed = rose(d, months)
            ro += [{"lga": name, "season": season, "sector": i, "freq": freq[i], "speed": speed[i]} for i in range(8)]
    return yr, se, ro, years


# ---------- database ----------
def store(engine, daily, b0=BASE_START, b1=BASE_END):
    yr, se, ro, years = compute(daily, b0, b1)
    meta = {"generated": date.today().isoformat(), "source": SOURCE, "baseline": json.dumps([b0, b1]),
            "last_day": max(d.index.max() for d in daily.values()).strftime("%Y-%m-%d")}
    with engine.begin() as c:  # a full recompute: nothing stale is left behind if the baseline or years change
        for t in (db.hazard_yearly, db.hazard_seasonal, db.hazard_windrose, db.hazard_meta):
            c.execute(delete(t))
        db.upsert(c, db.hazard_yearly, yr, ["lga", "year", "metric"])
        db.upsert(c, db.hazard_seasonal, se, ["lga", "metric", "month"])
        db.upsert(c, db.hazard_windrose, ro, ["lga", "season", "sector"])
        db.upsert(c, db.hazard_meta, [{"key": k, "value": v} for k, v in meta.items()], ["key"])
    return {"lgas": len(daily), "years": len(years), "first_year": years[0], "last_year": years[-1], "rows": len(yr)}


def lga_points(engine):
    with engine.connect() as c:
        rows = c.execute(select(db.lgas.c.name, db.lgas.c.lat, db.lgas.c.lon)).all()
    if not rows:
        raise SystemExit("No LGAs in the database. Run: python manage.py load-boundaries")
    return {r.name: (r.lat, r.lon) for r in rows}


def load(engine, start="1996-01-01", end=None, refresh=False, pause=2.0, b0=BASE_START, b1=BASE_END):
    end = end or (date.today() - timedelta(days=LAG_DAYS)).isoformat()
    pts, daily = lga_points(engine), {}
    for i, (name, (lat, lon)) in enumerate(pts.items(), 1):
        print(f"[{i}/{len(pts)}] {name}")
        daily[name] = get_daily(name, lat, lon, start, end, refresh, pause)
    return store(engine, daily, b0, b1)


def _clean(v, nd=2):
    return None if v is None or pd.isna(v) else round(float(v), nd)


def assemble(engine):
    """Everything the /hazards page needs, as one JSON-ready dict. None if nothing has been loaded."""
    with engine.connect() as c:
        y, s, w = (pd.read_sql(select(t), c) for t in (db.hazard_yearly, db.hazard_seasonal, db.hazard_windrose))
        meta = dict(c.execute(select(db.hazard_meta.c.key, db.hazard_meta.c.value)).all())
    if y.empty:
        return None
    years = sorted(int(v) for v in y["year"].unique())
    lgas, seas_all, rose_all = {}, {}, {k: [] for k in SEASONS}
    for name in sorted(y["lga"].unique()):
        yy = y[y["lga"] == name].pivot(index="year", columns="metric", values="value").reindex(years)
        ss = s[s["lga"] == name].pivot(index="month", columns="metric", values="value").reindex(range(1, 13))
        roses = {}
        for season in SEASONS:
            r = w[(w["lga"] == name) & (w["season"] == season)].set_index("sector").reindex(range(8))
            roses[season] = {"freq": [_clean(v) or 0.0 for v in r["freq"]], "speed": [_clean(v) for v in r["speed"]]}
            rose_all[season].append(roses[season])
        seasonal = {k: [_clean(v) for v in ss[k]] if k in ss else [None] * 12 for k in SEASONAL}
        seas_all[name] = seasonal
        lgas[name] = {"yearly": {k: [_clean(v) for v in yy[k]] if k in yy else [None] * len(years) for k in METRICS},
                      "seasonal": seasonal, "windrose": roses}
    state_seas = {k: [_clean(v) for v in pd.DataFrame([seas_all[n][k] for n in seas_all], dtype=float).mean()] for k in SEASONAL}
    state_rose = {}
    for season, items in rose_all.items():  # same days for every LGA, so the state share is the mean of the LGA shares
        freq = np.mean([r["freq"] for r in items], axis=0)
        num = np.nansum([[(sp or 0) * f for sp, f in zip(r["speed"], r["freq"], strict=True)] for r in items], axis=0)
        state_rose[season] = {"freq": [round(float(v), 2) for v in freq],
                              "speed": [round(float(n / (f * len(items))), 2) if f else None
                                        for n, f in zip(num, freq, strict=True)]}
    return {"generated": meta.get("generated"), "source": meta.get("source"), "last_day": meta.get("last_day"),
            "baseline": json.loads(meta.get("baseline", "[]")), "period": [years[0], years[-1]], "years": years,
            "metrics": {k: {"label": v[0], "unit": v[1], "group": v[2], "desc": v[3]} for k, v in METRICS.items()},
            "seasonal_metric": SEASONAL, "state_seasonal": state_seas, "state_windrose": state_rose,
            "sectors": SECTORS, "lgas": lgas}


def yearly_table(engine):
    """One row per LGA and year, one column per indicator (for the CSV download)."""
    with engine.connect() as c:
        y = pd.read_sql(select(db.hazard_yearly), c)
    if y.empty:
        return None
    t = y.pivot_table(index=["lga", "year"], columns="metric", values="value").reset_index()
    return t[["lga", "year", *[k for k in METRICS if k in t]]].round(2)


if __name__ == "__main__":
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default="1996-01-01")
    ap.add_argument("--end")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--pause", type=float, default=8.0, help="seconds between requests")
    ap.add_argument("--base-start", type=int, default=BASE_START)
    ap.add_argument("--base-end", type=int, default=BASE_END)
    a = ap.parse_args()
    res = load(db.get_engine(), a.start, a.end, a.refresh, a.pause, a.base_start, a.base_end)
    print(f"Done: {res['lgas']} LGAs, {res['years']} complete years ({res['first_year']} to {res['last_year']}).")