"""Fetches 30 years of ERA5-Land monthly climate (Copernicus CDS) and stores the mean per Ondo LGA in the
era5_* columns of climate_lga_month. Only missing months are downloaded; the latest 3 are refreshed because
recent ERA5 data is preliminary (ERA5T).

    python era5.py                 # 30 years to date (first run), then only new months
    python era5.py --start 2000    # a different first year
    python era5.py --no-db --csv era5_ondo.csv   # just write a CSV

One-time setup: free account at https://cds.climate.copernicus.eu, then either create ~/.cdsapirc with the url
and key shown on your CDS profile, or set CDSAPI_URL=https://cds.climate.copernicus.eu/api and CDSAPI_KEY in .env.
Open the dataset page "ERA5-Land monthly averaged data from 1950 to present" and accept its licence once."""
import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
from dotenv import load_dotenv
from shapely import contains_xy
from shapely.geometry import shape
from sqlalchemy import select

import db

DATASET = "reanalysis-era5-land-monthly-means"
AREA = [7.9, 4.4, 5.6, 6.2]  # North, West, South, East: Ondo State plus a small buffer
VARIABLES = ["2m_temperature", "2m_dewpoint_temperature", "total_precipitation", "surface_solar_radiation_downwards",
             "10m_u_component_of_wind", "10m_v_component_of_wind", "surface_pressure", "volumetric_soil_water_layer_1"]
CACHE = Path(__file__).parent / "data" / "cache" / "era5"
KEYS = ["lga", "year", "month"]
CHUNK_YEARS = 5
LAG_MONTHS = 2  # newest month requested is this many months before today
REFRESH = 3  # latest months re-fetched each run (preliminary data)


def periods(start_year, today=None):
    t = today or pd.Timestamp.today()
    end = t.year * 12 + t.month - 1 - LAG_MONTHS
    return [(i // 12, i % 12 + 1) for i in range(start_year * 12, end + 1)]


def blocks(todo):
    """Group (year, month) pairs into CDS requests: consecutive years that need the same months, 5 years at most."""
    by_year = {}
    for y, m in todo:
        by_year.setdefault(y, []).append(m)
    out = []
    for y in sorted(by_year):
        months = sorted(by_year[y])
        if out and out[-1][1] == months and out[-1][0][-1] == y - 1 and len(out[-1][0]) < CHUNK_YEARS:
            out[-1][0].append(y)
        else:
            out.append(([y], months))
    return out


def fetch(years, months):
    import cdsapi  # imported here so the rest of the module works (and tests run) without CDS credentials

    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"era5land_{years[0]}-{years[-1]}_m{'-'.join(f'{m:02d}' for m in months)}.nc"
    if target.exists() and target.stat().st_size > 0:
        return target
    print(f"Requesting ERA5-Land {years[0]}-{years[-1]}, months {months} ...")
    tmp = target.with_suffix(".part")
    cdsapi.Client().retrieve(DATASET, {
        "product_type": "monthly_averaged_reanalysis", "variable": VARIABLES,
        "year": [str(y) for y in years], "month": [f"{m:02d}" for m in months], "time": "00:00",
        "area": AREA, "data_format": "netcdf", "download_format": "unarchived"}, str(tmp))
    tmp.replace(target)
    return target


def open_nc(path):
    """Open a CDS NetCDF: handles zip wrappers, the newer 'valid_time' name and ERA5T 'expver' duplicates."""
    if zipfile.is_zipfile(path):
        folder = path.with_suffix("")
        folder.mkdir(exist_ok=True)
        with zipfile.ZipFile(path) as z:
            z.extractall(folder)
        ds = xr.merge([xr.open_dataset(f) for f in sorted(folder.glob("*.nc"))])
    else:
        ds = xr.open_dataset(path)
    if "valid_time" in ds.dims:
        ds = ds.rename({"valid_time": "time"})
    if "expver" in ds.dims:
        ds = ds.sel(expver=1).combine_first(ds.sel(expver=5))
    return ds


def load_lgas(engine):
    with engine.connect() as c:
        rows = c.execute(select(db.lgas)).all()
    if not rows:
        raise SystemExit("No LGAs in the database. Run: python manage.py load-boundaries")
    return [(r.name, shape(json.loads(r.geojson))) for r in rows]


def masks_for(ds, lgas):
    """Grid cells whose centre lies inside each LGA; the nearest cell to the centroid if none does."""
    lon, lat = np.meshgrid(ds.longitude.values, ds.latitude.values)
    out = {}
    for name, geom in lgas:
        m = contains_xy(geom, lon, lat)
        if not m.any():
            c = geom.centroid
            m = np.zeros_like(m)
            m.flat[np.argmin((lat - c.y) ** 2 + (lon - c.x) ** 2)] = True
        out[name] = m
    return out


def to_rows(ds, masks):
    """Zonal means per LGA, converted to the units used by the dashboard."""
    times = pd.DatetimeIndex(ds.time.values)
    days = times.days_in_month.to_numpy()
    rows = []
    for lga, mask in masks.items():
        v = {k: np.nanmean(ds[k].transpose("time", "latitude", "longitude").values[:, mask], axis=1) for k in ds.data_vars}
        t, d = v["t2m"] - 273.15, v["d2m"] - 273.15
        # Magnus formula on the monthly means: an approximation of mean relative humidity
        rh = np.clip(100 * np.exp(17.625 * d / (243.04 + d)) / np.exp(17.625 * t / (243.04 + t)), 0, 100)
        cols = {"era5_t2m": t, "era5_dewpoint": d,
                "era5_rain_mm": v["tp"] * 1000 * days,  # monthly-mean files hold the mean DAILY total in metres
                "era5_rh2m": rh,
                "era5_radiation": v["ssrd"] / 86400,  # mean daily J/m2 -> mean W/m2
                "era5_wind": np.hypot(v["u10"], v["v10"]),
                "era5_pressure": v["sp"] / 100, "era5_soil": v["swvl1"]}
        for i, ts in enumerate(times):
            rows.append({"lga": lga, "year": int(ts.year), "month": int(ts.month),
                         **{k: None if np.isnan(a[i]) else round(float(a[i]), 3) for k, a in cols.items()}})
    return rows


def run(engine, start_year, csv=None, save=True):
    lgas = load_lgas(engine)
    want = periods(start_year)
    with engine.connect() as c:
        q = select(db.climate.c.year, db.climate.c.month).where(db.climate.c.era5_t2m.is_not(None)).distinct()
        have = {(r.year, r.month) for r in c.execute(q)} if save else set()
    todo = [ym for ym in want if ym not in have or ym in set(sorted(have)[-REFRESH:])]
    if not todo:
        print("ERA5 is up to date.")
        return 0
    rows, masks = [], None
    for years, months in blocks(todo):
        try:
            path = fetch(years, months)
        except Exception as e:
            if (years[-1], months[-1]) >= want[-4]:  # newest months may simply not be released yet
                print(f"Skipping {years[-1]}-{months[-1]:02d}: {e}")
                continue
            raise
        path_ds = open_nc(path)
        masks = masks or masks_for(path_ds, lgas)
        rows += [r for r in to_rows(path_ds, masks) if (r["year"], r["month"]) in set(todo)]
        path_ds.close()
    if csv:
        pd.DataFrame(rows).to_csv(csv, index=False)
    if save:
        with engine.begin() as c:
            db.upsert(c, db.climate, rows, KEYS)
    print(f"ERA5: {len(rows)} LGA-months {'saved' if save else 'processed'}")
    return len(rows)


def main():
    load_dotenv()
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=int, default=pd.Timestamp.today().year - 30, help="first year (default: 30 years ago)")
    p.add_argument("--csv", help="also write the new rows to this CSV")
    p.add_argument("--no-db", action="store_true", help="do not write to the database")
    a = p.parse_args()
    if not (os.environ.get("CDSAPI_KEY") or (Path.home() / ".cdsapirc").exists()):
        sys.exit("No CDS credentials. See the top of era5.py.")
    run(db.get_engine(), a.start, csv=a.csv, save=not a.no_db)


if __name__ == "__main__":
    main()
