#!/usr/bin/env python3
"""
Crawl daily ERA5 weather for every Ondo State LGA and turn it into flood, heat-wave and wind indicators.

  pip install pandas numpy requests
  python tools/crawl_hazards.py --boundaries path/to/ondo_lgas.geojson --out public/data

Source: Open-Meteo historical API (ERA5 reanalysis, free, no key). One point per LGA (its centroid).
Writes: <out>/ondo_hazards.json (read by the /hazards page) and <out>/ondo_hazards_lga_year.csv.
"""
import argparse, json, os, re, sys, time
from datetime import date, timedelta

import numpy as np
import pandas as pd
import requests

API = "https://archive-api.open-meteo.com/v1/archive"
DAILY = "temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant"
RENAME = {"temperature_2m_max": "tmax", "precipitation_sum": "rain", "wind_speed_10m_max": "wspd",
          "wind_gusts_10m_max": "gust", "wind_direction_10m_dominant": "wdir"}
NAME_FIELDS = ["lga", "LGA", "lga_name", "LGAName", "lganame", "NAME_2", "ADM2_EN", "shapeName", "admin2Name", "name", "NAME"]
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
RAINY = [4, 5, 6, 7, 8, 9, 10]
DRY = [11, 12, 1, 2, 3]

# key: (label, unit, group, what it means)
METRICS = {
    "rx1day": ("Wettest day of the year", "mm", "flood", "Highest one-day rainfall in the year."),
    "rx5day": ("Wettest 5 days of the year", "mm", "flood", "Highest rainfall over any 5 days in a row. Long wet spells saturate soil and fill rivers."),
    "heavy_days_50mm": ("Heavy-rain days (50 mm or more)", "days", "flood", "Days with at least 50 mm of rain."),
    "flood_alert_days": ("Flood-alert days (100 mm in 3 days)", "days", "flood", "Days on which the last 3 days added up to 100 mm or more."),
    "extreme_days_p99": ("Extreme-rain days", "days", "flood", "Days wetter than the 99th percentile of this LGA's own rainy days."),
    "annual_rain": ("Yearly rainfall", "mm", "flood", "Total rain in the year."),
    "heatwave_days": ("Heat-wave days", "days", "heat", "Days inside a heat wave: 3 or more days in a row with max temperature above the LGA's own 90th percentile for that time of year."),
    "heatwave_events": ("Heat-wave events", "events", "heat", "Number of separate heat waves starting in the year."),
    "heatwave_longest": ("Longest heat wave", "days", "heat", "Length of the longest heat wave starting in the year."),
    "hot_days_35": ("Days at or above 35 °C", "days", "heat", "Days when the maximum temperature reached 35 °C or more."),
    "tmax_peak": ("Hottest day of the year", "°C", "heat", "Highest daily maximum temperature."),
    "mean_wind": ("Average wind speed", "m/s", "wind", "Mean of the daily maximum 10 m wind speed."),
    "max_gust": ("Strongest gust", "m/s", "wind", "Highest daily wind gust."),
    "gust_days_ge14": ("Strong-gust days (14 m/s or more)", "days", "wind", "Days with gusts of 14 m/s (about 50 km/h) or more, the start of a damaging wind."),
}
SEASONAL = {"heavy_days_50mm": "flood", "heatwave_days": "heat", "gust_days_ge14": "wind"}


# ---------- boundaries ----------
def ring_centroid(ring):
    a = cx = cy = 0.0
    for p, q in zip(ring, ring[1:]):
        c = p[0] * q[1] - q[0] * p[1]
        a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c
    a *= 0.5
    if abs(a) < 1e-12:
        return (float(np.mean([p[0] for p in ring])), float(np.mean([p[1] for p in ring]))), 1e-12
    return (cx / (6 * a), cy / (6 * a)), abs(a)


def centroid(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    tot = sx = sy = 0.0
    for poly in polys:
        (x, y), a = ring_centroid(poly[0])
        sx += x * a; sy += y * a; tot += a
    return sy / tot, sx / tot  # lat, lon


def load_lgas(path, field=None):
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    feats = gj["features"]
    props = feats[0]["properties"]
    field = field or next((k for k in NAME_FIELDS if k in props), None)
    if not field:
        sys.exit(f"Could not find the LGA name field. Properties are: {list(props)}. Re-run with --name-field NAME")
    return {str(ft["properties"][field]).strip(): centroid(ft["geometry"]) for ft in feats}


# ---------- download ----------
def fetch(lat, lon, start, end, tries=6):
    p = dict(latitude=round(lat, 4), longitude=round(lon, 4), start_date=start, end_date=end, daily=DAILY,
             wind_speed_unit="ms", timezone="Africa/Lagos", models="era5")
    for i in range(tries):
        r = requests.get(API, params=p, timeout=180)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:
            wait = 65 * (i + 1); print(f"   rate limited, waiting {wait}s"); time.sleep(wait); continue
        r.raise_for_status()
    raise RuntimeError("Open-Meteo kept refusing the request. Try again in an hour.")


def get_daily(name, lat, lon, start, end, cache, refresh, pause):
    path = os.path.join(cache, re.sub(r"[^a-z0-9]+", "_", name.lower()) + ".csv")
    if os.path.exists(path) and not refresh:
        return pd.read_csv(path, index_col=0, parse_dates=True)
    parts, y0, y1 = [], int(start[:4]), int(end[:4])
    for ys in range(y0, y1 + 1, 10):
        a = max(start, f"{ys}-01-01"); b = min(end, f"{min(ys + 9, y1)}-12-31")
        j = fetch(lat, lon, a, b)["daily"]
        parts.append(pd.DataFrame(j).set_index("time").rename(columns=RENAME))
        time.sleep(pause)
    d = pd.concat(parts); d.index = pd.to_datetime(d.index); d.index.name = "date"
    os.makedirs(cache, exist_ok=True); d.to_csv(path)
    return d


# ---------- indicators ----------
def flood(d, b0, b1):
    r = d["rain"].fillna(0); y = r.index.year
    base = r[(y >= b0) & (y <= b1) & (r >= 1)]
    p99 = base.quantile(0.99) if len(base) else np.nan
    g = lambda s: s.groupby(s.index.year)
    return pd.DataFrame({
        "rx1day": g(r).max(), "rx5day": g(r.rolling(5).sum()).max(),
        "heavy_days_50mm": g((r >= 50).astype(int)).sum(),
        "flood_alert_days": g((r.rolling(3).sum() >= 100).astype(int)).sum(),
        "extreme_days_p99": g((r > p99).astype(int)).sum(), "annual_rain": g(r).sum(),
    })


def heat(d, b0, b1):
    t = d["tmax"]; yr = d.index.year.values; doy = np.minimum(d.index.dayofyear.values, 365)
    m = (yr >= b0) & (yr <= b1)
    bt, bd = t.values[m], doy[m]
    thr = np.full(366, np.nan)
    for k in range(1, 366):  # 15-day window around each calendar day, wrapping at year end
        v = bt[np.isin(bd, ((k - 1 + np.arange(-7, 8)) % 365) + 1)]
        v = v[~np.isnan(v)]
        if len(v) > 20:
            thr[k] = np.percentile(v, 90)
    hot = t.values > thr[doy]
    df = pd.DataFrame({"hot": hot, "date": d.index}, index=d.index)
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
    x = d.dropna(subset=["wdir", "wspd"])
    if months:
        x = x[x.index.month.isin(months)]
    if not len(x):
        return {"freq": [0] * 8, "speed": [None] * 8}
    sec = (((x["wdir"] + 22.5) % 360) // 45).astype(int)
    return {"freq": [round(float(v), 2) for v in np.bincount(sec, minlength=8) / len(x) * 100],
            "speed": [None if pd.isna(v) else round(float(v), 2) for v in x["wspd"].groupby(sec).mean().reindex(range(8))]}


def clean(v, nd=2):
    return None if v is None or pd.isna(v) else round(float(v), nd)


def build(daily, coords, b0, b1):
    full = {n: d.index.year.value_counts() for n, d in daily.items()}
    years = sorted(set.intersection(*[set(c[c >= 360].index) for c in full.values()]))
    out, rows, allw = {}, [], []
    for name, d in daily.items():
        h, ev = heat(d, b0, b1)
        yearly = pd.concat([flood(d, b0, b1), h, wind(d)], axis=1).reindex(years)
        seas = {}
        for k, src in (("heavy_days_50mm", (d["rain"].fillna(0) >= 50).astype(int)), ("heatwave_days", ev),
                       ("gust_days_ge14", (d["gust"] >= 14).astype(int))):
            s = src[src.index.year.isin(years)]
            seas[k] = [clean(v) for v in s.groupby([s.index.year, s.index.month]).sum().groupby(level=1).mean().reindex(range(1, 13))]
        out[name] = {"lat": round(coords[name][0], 4), "lon": round(coords[name][1], 4),
                     "yearly": {k: [clean(v) for v in yearly[k]] for k in METRICS}, "seasonal": seas,
                     "windrose": {"all": rose(d), "rainy": rose(d, RAINY), "dry": rose(d, DRY)}}
        yy = yearly.copy(); yy.insert(0, "year", years); yy.insert(0, "lga", name); rows.append(yy)
        allw.append(d)
    pooled = pd.concat(allw)
    state_seas = {k: [clean(np.nanmean([o["seasonal"][k][m] for o in out.values()])) for m in range(12)] for k in SEASONAL}
    return {
        "generated": date.today().isoformat(), "source": "ERA5 reanalysis via Open-Meteo (one point per LGA centroid)",
        "period": [min(years), max(years)], "years": years, "baseline": [b0, b1],
        "metrics": {k: {"label": v[0], "unit": v[1], "group": v[2], "desc": v[3]} for k, v in METRICS.items()},
        "seasonal_metric": SEASONAL, "state_seasonal": state_seas,
        "state_windrose": {"all": rose(pooled), "rainy": rose(pooled, RAINY), "dry": rose(pooled, DRY)},
        "sectors": SECTORS, "lgas": out,
    }, pd.concat(rows, ignore_index=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--boundaries", required=True, help="GeoJSON of the Ondo LGAs (the file you loaded into the backend)")
    ap.add_argument("--name-field"); ap.add_argument("--out", default="public/data"); ap.add_argument("--cache", default=".hazard_cache")
    ap.add_argument("--start", default="1996-01-01"); ap.add_argument("--end", default=(date.today() - timedelta(days=7)).isoformat())
    ap.add_argument("--base-start", type=int, default=1996); ap.add_argument("--base-end", type=int, default=2020)
    ap.add_argument("--pause", type=float, default=2.0); ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    lgas = load_lgas(a.boundaries, a.name_field)
    print(f"{len(lgas)} LGAs found: {', '.join(lgas)}")
    daily = {}
    for i, (n, (lat, lon)) in enumerate(lgas.items(), 1):
        print(f"[{i}/{len(lgas)}] {n} ({lat:.3f}, {lon:.3f})")
        daily[n] = get_daily(n, lat, lon, a.start, a.end, a.cache, a.refresh, a.pause)
    js, table = build(daily, lgas, a.base_start, a.base_end)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "ondo_hazards.json"), "w", encoding="utf-8") as f:
        json.dump(js, f, ensure_ascii=False, separators=(",", ":"))
    table.round(2).to_csv(os.path.join(a.out, "ondo_hazards_lga_year.csv"), index=False)
    print(f"Done. {len(js['years'])} complete years ({js['period'][0]}-{js['period'][1]}). Wrote {a.out}/ondo_hazards.json")


if __name__ == "__main__":
    main()
