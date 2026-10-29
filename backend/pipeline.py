"""Fetches CHIRPS rainfall (LGA zonal mean) and NASA POWER temperature/humidity (LGA centroid) into Postgres.
Only new months are fetched; the latest 3 are refreshed because recent CHIRPS data is preliminary."""
import gzip
import json
import os
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests
from dotenv import load_dotenv
from rasterstats import zonal_stats
from shapely.geometry import shape
from sqlalchemy import select

import db

load_dotenv()  # so START_YEAR in .env is read before it is used below
CACHE = Path(__file__).parent / "data" / "cache"
# CHIRPS and NASA POWER both go back to 1981; ERA5-Land (era5.py) starts at 1996. Set START_YEAR in .env to change.
START_YEAR = int(os.environ.get("START_YEAR", "2015"))
KEYS = ["lga", "year", "month"]
CHIRPS = "https://data.chc.ucsb.edu/products/CHIRPS-2.0/africa_monthly/tifs/chirps-v2.0.{y}.{m:02d}.tif.gz"
POWER = "https://power.larc.nasa.gov/api/temporal/monthly/point"


def lga_frame(engine):
    with engine.connect() as c:
        rows = c.execute(select(db.lgas)).all()
    if not rows:
        raise SystemExit("No LGAs in the database. Run: python manage.py load-boundaries")
    return gpd.GeoDataFrame({"lga": [r.name for r in rows], "lon": [r.lon for r in rows], "lat": [r.lat for r in rows]},
                            geometry=[shape(json.loads(r.geojson)) for r in rows], crs=4326)


def months():
    t = pd.Timestamp.today()
    return [(y, m) for y in range(START_YEAR, t.year + 1) for m in range(1, 13) if (y, m) <= (t.year, t.month)]


def chirps(gdf, todo, refresh):
    CACHE.mkdir(parents=True, exist_ok=True)
    out = []
    for y, m in todo:
        tif = CACHE / f"chirps-v2.0.{y}.{m:02d}.tif"
        if (y, m) in refresh:
            tif.unlink(missing_ok=True)
        if not tif.exists():
            r = requests.get(CHIRPS.format(y=y, m=m), timeout=180)
            if r.status_code == 404:
                print(f"{y}-{m:02d} not published yet")
                continue
            r.raise_for_status()
            tif.write_bytes(gzip.decompress(r.content))
        stats = zonal_stats(gdf, str(tif), stats=["mean"], all_touched=True, nodata=-9999)
        out += [{"lga": n, "year": y, "month": m, "rain_mm": s["mean"]} for n, s in zip(gdf["lga"], stats, strict=True)]
        print(f"CHIRPS {y}-{m:02d} done")
    return out


def parse_power(name, payload):
    par = payload["properties"]["parameter"]
    rows = []
    for key in par["T2M"]:
        if key.endswith("13"):  # annual summary
            continue
        rec = {"lga": name, "year": int(key[:4]), "month": int(key[4:])}
        for p, col in (("T2M", "t2m"), ("T2M_MAX", "t2m_max"), ("RH2M", "rh2m")):
            v = par[p][key]
            rec[col] = None if v == -999 else v
        rows.append(rec)
    return rows


def power(gdf):
    rows = []
    for name, lon, lat in zip(gdf["lga"], gdf["lon"], gdf["lat"], strict=True):
        r = requests.get(POWER, timeout=90, params={
            "parameters": "T2M,T2M_MAX,RH2M", "community": "AG", "format": "JSON", "longitude": lon,
            "latitude": lat, "start": START_YEAR, "end": pd.Timestamp.today().year})
        r.raise_for_status()
        rows += parse_power(name, r.json())
        time.sleep(0.5)
    return rows


def main():
    load_dotenv()
    engine = db.get_engine()
    gdf = lga_frame(engine)
    with engine.connect() as c:
        q = select(db.climate.c.year, db.climate.c.month).where(db.climate.c.rain_mm.is_not(None)).distinct()
        have = {(r.year, r.month) for r in c.execute(q)}
    recent = set(sorted(have)[-3:])
    rain = chirps(gdf, [ym for ym in months() if ym not in have or ym in recent], recent)
    with engine.begin() as c:
        db.upsert(c, db.climate, rain, KEYS)
        db.upsert(c, db.climate, power(gdf), KEYS)
    print("Done")


if __name__ == "__main__":
    main()
