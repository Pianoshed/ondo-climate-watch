"""Loads health survey and modelled-health indicators for Ondo State into the survey_indicator table.

Three loaders, each safe to re-run (upsert):

  python surveys.py dhs-api                       State-level Ondo estimates from the DHS Program API (no login).
  python surveys.py dhs-microdata --kr X --ge Y   LGA estimates from the NDHS child file + GPS cluster file.
  python surveys.py rasters DIR --source "MAP"    LGA zonal means from GeoTIFFs (Malaria Atlas Project, IHME LBD).

How accurate is each level? Read this before using LGA numbers in a report or grant:
  * The DHS API gives Ondo as a whole (the survey is designed for state level). It is the safe headline number.
  * dhs-microdata assigns each survey cluster to the LGA containing its GPS point. Cluster coordinates are
    deliberately displaced (up to 2 km urban, 5 km rural, 10 km for 1 percent of rural clusters) and a state has
    only a few dozen clusters, so an LGA may have a handful. Rows carry n and n_clusters and a note; treat LGAs
    with few clusters as indicative only.
  * rasters are modelled surfaces (not surveys). LGA values are real spatial detail, but they are model output.

Data access (one-time):
  * NDHS 2023-24: register at https://dhsprogram.com, request the Nigeria dataset, download the children's
    recode (NGKR*.DTA) and the GPS file (NGGE*.zip, a shapefile). Both are free for registered users.
  * Malaria Atlas Project rasters: use the R package malariaAtlas (listRaster() then getRaster()) or the download
    page https://data.malariaatlas.org, and save GeoTIFFs as data/surveys/map/<indicator>_<year>.tif.
  * IHME Local Burden of Disease rasters: download from https://ghdx.healthdata.org and name them the same way.
    Check each source's licence (IHME data is typically non-commercial use) before publishing."""
import argparse
import json
import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from dotenv import load_dotenv
from rasterstats import zonal_stats

import db
import pipeline

DHS_API = "https://api.dhsprogram.com/rest/dhs/data"
STATE = "Ondo"
# DHS indicator ids. Override with DHS_INDICATORS="ID1,ID2" if you want others (browse
# https://api.dhsprogram.com/rest/dhs/indicators?countryIds=NG). Ids that return nothing are skipped with a message.
DHS_INDICATORS = ["CH_DIAR_C_DIA", "CH_FEVR_C_FEV", "CH_ARIS_C_ARI", "ML_PMAL_C_RDT", "ML_NETU_C_ITN"]
RASTER_DIR = Path(__file__).parent / "data" / "surveys" / "map"
LOW_N, LOW_CLUSTERS = 100, 5  # below either, an LGA estimate is flagged as indicative only


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


# ---------- DHS API: state level ----------
def parse_dhs(payload, state=STATE):
    """Rows for the given state from a DHS API response (breakdown=subnational). Region labels look like '..Ondo'."""
    rows = []
    for r in payload.get("Data", []):
        label = str(r.get("CharacteristicLabel", "")).lstrip(". ").strip()
        value = _num(r.get("Value"))
        if label.casefold() != state.casefold() or value is None:
            continue
        n = _num(r.get("DenominatorUnweighted"))
        rows.append({"source": "DHS API", "indicator": r["IndicatorId"], "survey_year": int(r["SurveyYear"]),
                     "geo_level": "state", "geo_name": state, "label": r.get("Indicator"),
                     "unit": "%" if r.get("IsPreferred", 1) is not None else "", "value": value,
                     "ci_low": _num(r.get("CILow")), "ci_high": _num(r.get("CIHigh")),
                     "n": int(n) if n is not None else None, "n_clusters": None,
                     "note": "DHS survey estimate for the state"})
    return rows


def fetch_dhs(indicators=None):
    ids = indicators or [i for i in os.environ.get("DHS_INDICATORS", "").split(",") if i] or DHS_INDICATORS
    rows = []
    for ind in ids:
        r = requests.get(DHS_API, timeout=60, params={"countryIds": "NG", "indicatorIds": ind, "breakdown": "subnational",
                                                       "f": "json", "perpage": 5000})
        r.raise_for_status()
        got = parse_dhs(r.json())
        print(f"{ind}: {len(got)} Ondo rows" if got else f"{ind}: nothing for {STATE}, check the indicator id")
        rows += got
    return rows


# ---------- DHS microdata: LGA level ----------
def _flags(kr):
    """Binary child indicators from DHS children's recode variables (h11 diarrhoea, h22 fever, 2 week recall)."""
    out = pd.DataFrame({"cluster": kr["v001"], "w": kr["v005"] / 1e6})
    if "b5" in kr:  # keep living children
        out = out[kr["b5"] == 1]
    h11, h22 = pd.to_numeric(kr["h11"], errors="coerce"), pd.to_numeric(kr["h22"], errors="coerce")
    out["dhs_child_diarrhoea"] = np.where(h11.isin([0, 1, 2]), h11.isin([1, 2]).astype(float), np.nan)[out.index]
    out["dhs_child_fever"] = np.where(h22.isin([0, 1]), (h22 == 1).astype(float), np.nan)[out.index]
    return out


LABELS = {"dhs_child_diarrhoea": "Children under 5 with diarrhoea in past 2 weeks (survey estimate, LGA)",
          "dhs_child_fever": "Children under 5 with fever in past 2 weeks (survey estimate, LGA)"}


def cluster_to_lga(kr, ge, lga_gdf, year):
    """Weighted LGA prevalence (%) of child diarrhoea and fever from the DHS children's file and GPS cluster file."""
    ge = ge[(ge["LATNUM"].abs() > 0) & (ge["LONGNUM"].abs() > 0)]  # clusters without GPS are coded 0,0
    pts = gpd.GeoDataFrame({"cluster": ge["DHSCLUST"]}, geometry=gpd.points_from_xy(ge["LONGNUM"], ge["LATNUM"]), crs=4326)
    where = gpd.sjoin(pts, lga_gdf[["lga", "geometry"]], predicate="within", how="inner")[["cluster", "lga"]]
    df = _flags(kr).merge(where, on="cluster", how="inner")
    rows = []
    for ind, label in LABELS.items():
        d = df.dropna(subset=[ind])
        for lga, g in d.groupby("lga"):
            n, k = len(g), g["cluster"].nunique()
            low = n < LOW_N or k < LOW_CLUSTERS
            rows.append({"source": "DHS microdata", "indicator": ind, "survey_year": year, "geo_level": "lga", "geo_name": lga,
                         "label": label, "unit": "%", "value": round(float(np.average(g[ind], weights=g["w"]) * 100), 1),
                         "ci_low": None, "ci_high": None, "n": int(n), "n_clusters": int(k),
                         "note": ("Indicative only: " if low else "") + f"{n} children in {k} clusters; GPS displaced up to 2 km "
                                 "urban / 5 km rural; no design-based interval"})
    return rows


# ---------- Rasters: LGA zonal means ----------
def zonal_rows(tif, lga_gdf, source, indicator, year, label=None, unit="", scale=1.0):
    stats = zonal_stats(lga_gdf, str(tif), stats=["mean"], all_touched=True)
    return [{"source": source, "indicator": indicator, "survey_year": year, "geo_level": "lga", "geo_name": n,
             "label": label or indicator.replace("_", " "), "unit": unit,
             "value": None if s["mean"] is None else round(s["mean"] * scale, 3), "ci_low": None, "ci_high": None,
             "n": None, "n_clusters": None, "note": f"Modelled surface ({source}); mean of raster cells in the LGA"}
            for n, s in zip(lga_gdf["lga"], stats, strict=True)]


def raster_rows(folder, lga_gdf, source):
    """Files named <indicator>_<year>.tif. Optional index.json: {"pfpr": {"label": "...", "unit": "%", "scale": 100}}"""
    folder = Path(folder)
    meta = json.loads((folder / "index.json").read_text()) if (folder / "index.json").exists() else {}
    rows = []
    for tif in sorted(folder.glob("*.tif")):
        ind, _, year = tif.stem.rpartition("_")
        if not ind or not year.isdigit():
            print(f"skip {tif.name}: name must look like indicator_2022.tif")
            continue
        m = meta.get(ind, {})
        rows += zonal_rows(tif, lga_gdf, source, ind, int(year), m.get("label"), m.get("unit", ""), m.get("scale", 1.0))
        print(f"{tif.name}: done")
    return rows


def save(engine, rows):
    with engine.begin() as c:
        db.upsert(c, db.surveys, rows, db.SURVEY_KEYS)
    return len(rows)


def main():
    load_dotenv()
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("dhs-api")
    m = sub.add_parser("dhs-microdata")
    m.add_argument("--kr", required=True, help="children's recode, e.g. NGKR8CFL.DTA")
    m.add_argument("--ge", required=True, help="GPS cluster shapefile, e.g. NGGE8AFL.shp")
    m.add_argument("--year", type=int, default=2023, help="survey year to record (NDHS 2023-24 -> 2023)")
    r = sub.add_parser("rasters")
    r.add_argument("folder", nargs="?", default=str(RASTER_DIR))
    r.add_argument("--source", default="MAP", help='e.g. "MAP" or "IHME LBD"')
    a = p.parse_args()
    engine = db.get_engine()
    db.init_db(engine)
    if a.cmd == "dhs-api":
        n = save(engine, fetch_dhs())
    elif a.cmd == "dhs-microdata":
        kr = pd.read_stata(a.kr, convert_categoricals=False, columns=["v001", "v005", "b5", "h11", "h22"])
        n = save(engine, cluster_to_lga(kr, gpd.read_file(a.ge), pipeline.lga_frame(engine), a.year))
    else:
        n = save(engine, raster_rows(a.folder, pipeline.lga_frame(engine), a.source))
    print("Saved", n, "rows")


if __name__ == "__main__":
    main()
