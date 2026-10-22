"""Loads health survey and modelled-health indicators for Ondo State into the survey_indicator table.

Everything is safe to re-run (upsert). Easiest way:

  python surveys.py all                           Runs every step that is available (see below).

Single steps:

  python surveys.py dhs-api                       State-level Ondo estimates from the DHS Program API (no login).
                                                  Also searches the DHS indicator list for malaria, diarrhoea, fever,
                                                  cough, vaccination, nutrition and water/sanitation indicators.
  python surveys.py csv-template                  Writes a template for your own data (cholera, any disease).
  python surveys.py csv [DIR]                     Loads every CSV in data/surveys/manual (files starting "_" skipped).
  python surveys.py fetch-maps [--year 2022]      Downloads Malaria Atlas Project GeoTIFFs for Ondo (no login).
  python surveys.py rasters [DIR] --source "MAP"  LGA zonal means from GeoTIFFs in DIR (default data/surveys/map).
  python surveys.py dhs-microdata [--kr F --ge F] LGA estimates from the NDHS child file + GPS cluster file.
                                                  Files are auto-found in data/surveys/ if the flags are omitted.

What "all" does:
  1. dhs-api      fully automatic.
  2. fetch-maps   fully automatic (skipped with a message if the MAP server is unreachable).
  3. rasters      loads every .tif in data/surveys/map (downloaded above, or dropped in by you, e.g. IHME).
  4. csv           loads your own files from data/surveys/manual (cholera, DHIS2 or IDSR counts, etc).
  5. dhs-microdata runs only if NGKR*.DTA and NGGE*.shp (unzipped) are somewhere under data/surveys/.

How accurate is each level? Read this before using LGA numbers in a report or grant:
  * The DHS API gives Ondo as a whole (the survey is designed for state level). It is the safe headline number.
  * dhs-microdata assigns each survey cluster to the LGA containing its GPS point. Cluster coordinates are
    deliberately displaced (up to 2 km urban, 5 km rural, 10 km for 1 percent of rural clusters) and a state has
    only a few dozen clusters, so an LGA may have a handful. Rows carry n and n_clusters and a note; treat LGAs
    with few clusters as indicative only.
  * rasters are modelled surfaces (not surveys). LGA values are real spatial detail, but they are model output.

Data access:
  * Malaria Atlas Project: downloaded by fetch-maps from MAP's public geoserver (CC BY 3.0, cite MAP).
  * NDHS 2023-24 (one-time, needs a login): register at https://dhsprogram.com, request the Nigeria dataset,
    download the children's recode (NGKR*.DTA) and the GPS file (NGGE*.zip, a shapefile; unzip it). Free for
    registered users. Put both anywhere under data/surveys/.
  * IHME Local Burden of Disease rasters (optional, needs manual download): https://ghdx.healthdata.org, name them
    <indicator>_<year>.tif and run: python surveys.py rasters DIR --source "IHME LBD". IHME data is typically
    non-commercial use, so check the licence before publishing."""
import argparse
import fnmatch
import hashlib
import json
import os
import re
from datetime import datetime, timezone
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
DHS_INDICATORS_API = "https://api.dhsprogram.com/rest/dhs/indicators"
DHS_DISCOVER_CAP = 60  # most extra indicators picked up by the keyword search (set DHS_DISCOVER=0 to switch it off)
DHS_TOPICS = [re.compile(p, re.I) for p in (
    r"\bmalaria\b", r"\bnets?\b|\bitns?\b", r"diarrh", r"\bfever\b", r"\bcough\b|acute respiratory|\bari\b",
    r"vaccin|immuni[sz]|measles|\bdpt\b|penta|polio|bcg|rotavirus", r"oral rehydration|\bors\b",
    r"stunt|wast|underweight", r"drinking water|sanitation|toilet|hand ?wash")]
SURVEY_DIR = Path(__file__).parent / "data" / "surveys"
MANUAL_DIR = SURVEY_DIR / "manual"
ORIGIN_SEP = " | Origin: "  # note = caveat text, then the origin trail; the app and the exports split on this
TODAY = datetime.now(timezone.utc).date().isoformat()
MANUAL_COLS = ["indicator", "label", "unit", "geo_level", "geo_name", "year", "value"]
RASTER_DIR = SURVEY_DIR / "map"
LOW_N, LOW_CLUSTERS = 100, 5  # below either, an LGA estimate is flagged as indicative only

# Malaria Atlas Project public geoserver (WCS 2.0.1). Coverage ids are looked up at run time from GetCapabilities
# (they carry a vintage prefix that changes), by keyword. indicator -> (include keywords, exclude keywords, label, unit, scale)
MAP_WCS = "https://data.malariaatlas.org/geoserver/ows"
MAP_LAYERS = {
    "pfpr": (("pf_parasite_rate",), (), "P. falciparum parasite rate, ages 2-10 (modelled)", "%", 100),
    "pf_incidence": (("pf_incidence_rate",), (), "P. falciparum clinical incidence per 1,000 people (modelled)",
                     "per 1,000", 1000),
    "itn_use": (("net_use",), ("rate", "access"), "Insecticide-treated net use (modelled)", "%", 100),
}
MAP_PAD = 0.1  # degrees of margin around the LGA layer when cropping the download


def find_file(pattern):
    """First file under data/surveys matching a lowercase glob, case-insensitive."""
    if not SURVEY_DIR.is_dir():
        return None
    return next((p for p in sorted(SURVEY_DIR.rglob("*")) if fnmatch.fnmatch(p.name.lower(), pattern)), None)


def sha12(path):
    """First 12 hex characters of the file's SHA-256, so a file can be matched to the one that was loaded."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def with_origin(note, origin):
    return note + (ORIGIN_SEP + origin if origin else "")


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


# ---------- DHS API: state level ----------
def parse_dhs(payload, state=STATE):
    """Rows for the given state from a DHS API response (breakdown=subnational). Region labels look like '..Ondo'.
    Each row also carries _rank and _src (dropped by dedupe_dhs) so duplicates can be resolved and reported."""
    rows = []
    for r in payload.get("Data", []):
        label = str(r.get("CharacteristicLabel", "")).lstrip(". ").strip()
        value = _num(r.get("Value"))
        if label.casefold() != state.casefold() or value is None:
            continue
        n = _num(r.get("DenominatorUnweighted"))
        by = str(r.get("ByVariableLabel") or "")
        survey = str(r.get("SurveyId") or "")
        rows.append({"source": "DHS API", "indicator": r["IndicatorId"], "survey_year": int(r["SurveyYear"]),
                     "geo_level": "state", "geo_name": state, "label": r.get("Indicator"), "unit": "%", "value": value,
                     "ci_low": _num(r.get("CILow")), "ci_high": _num(r.get("CIHigh")),
                     "n": int(n) if n is not None else None, "n_clusters": None,
                     "note": with_origin("DHS survey estimate for the state" + (f" ({survey})" if survey else ""),
                                         f"The DHS Program API {DHS_API}; SurveyId {survey or '?'}; IndicatorId {r['IndicatorId']}; "
                                         f"breakdown {by or '?'}; retrieved {TODAY}"),
                     # preferred flag first, then a region/state breakdown, then the larger sample
                     "_rank": (r.get("IsPreferred") == 1, any(w in by.lower() for w in ("region", "state")), n or 0),
                     "_src": f"{survey or '?'} / {by or '?'} / n={n if n is not None else '?'} / value={value}"})
    return rows


def dedupe_dhs(rows):
    """One row per indicator and survey year. The API can return several Ondo rows for the same year (different
    survey series or breakdowns); keep the preferred / largest-sample one and report what was dropped."""
    groups = {}
    for r in rows:
        groups.setdefault((r["indicator"], r["survey_year"]), []).append(r)
    kept, dropped = [], []
    for g in groups.values():
        g = sorted(g, key=lambda r: r["_rank"], reverse=True)
        kept.append(g[0])
        dropped += [(g[0], x) for x in g[1:]]
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in kept]
    return clean, dropped


def discover_dhs():
    """Percent indicators for Nigeria whose label matches a health topic above. Needs no indicator ids typed by hand."""
    r = requests.get(DHS_INDICATORS_API, timeout=120, params={"countryIds": "NG", "perpage": 5000, "f": "json"})
    r.raise_for_status()
    hits = []
    for x in r.json().get("Data", []):
        if str(x.get("MeasurementType") or "percent").lower() != "percent":
            continue
        if any(rx.search(str(x.get("Label", ""))) for rx in DHS_TOPICS):
            hits.append(x["IndicatorId"])
    return hits[:DHS_DISCOVER_CAP]


def _dhs_get(ids):
    """All pages of the DHS data endpoint for a batch of indicator ids."""
    rows, page = [], 1
    while True:
        r = requests.get(DHS_API, timeout=120, params={"countryIds": "NG", "indicatorIds": ",".join(ids),
                                                        "breakdown": "subnational", "f": "json", "perpage": 5000, "page": page})
        r.raise_for_status()
        payload = r.json()
        rows += payload.get("Data", [])
        if page >= int(payload.get("TotalPages") or 1):
            return {"Data": rows}
        page += 1


def fetch_dhs(indicators=None):
    ids = list(indicators or [i for i in os.environ.get("DHS_INDICATORS", "").split(",") if i] or DHS_INDICATORS)
    if os.environ.get("DHS_DISCOVER", "1") != "0":
        try:
            extra = [i for i in discover_dhs() if i not in ids]
            print(f"DHS indicator search: {len(extra)} more candidates")
            ids += extra
        except Exception as e:
            print(f"skip DHS indicator search: {e}")
    out, found, dup = [], set(), 0
    for k in range(0, len(ids), 10):
        batch = ids[k:k + 10]
        try:
            got = parse_dhs(_dhs_get(batch))
        except Exception as e:  # one bad batch must not stop the rest
            print(f"DHS batch {k // 10 + 1} failed: {e}")
            continue
        clean, dropped = dedupe_dhs(got)
        dup += len(dropped)
        for ind in sorted({c["indicator"] for c in clean}):
            years = sorted(c["survey_year"] for c in clean if c["indicator"] == ind)
            print(f"{ind}: {len(years)} survey years for {STATE} ({years[0]} to {years[-1]})")
            found.add(ind)
        out += clean
    missing = [i for i in ids if i not in found]
    if missing:
        print(f"No {STATE} data for {len(missing)} indicators (not asked in Ondo, or id not valid): " + ", ".join(missing[:15])
              + (" ..." if len(missing) > 15 else ""))
    if dup:
        print(f"{dup} duplicate rows resolved (kept the preferred or largest sample)")
    return out


# ---------- DHS microdata: LGA level ----------
def _flags(kr):
    """Binary child indicators from DHS children's recode variables (h11 diarrhoea, h22 fever, 2 week recall)."""
    out = pd.DataFrame({"cluster": kr["v001"].astype(int), "w": kr["v005"] / 1e6})
    if "b5" in kr:  # keep living children
        out = out[kr["b5"] == 1]
    h11, h22 = pd.to_numeric(kr["h11"], errors="coerce"), pd.to_numeric(kr["h22"], errors="coerce")
    out["dhs_child_diarrhoea"] = np.where(h11.isin([0, 1, 2]), h11.isin([1, 2]).astype(float), np.nan)[out.index]
    out["dhs_child_fever"] = np.where(h22.isin([0, 1]), (h22 == 1).astype(float), np.nan)[out.index]
    return out


LABELS = {"dhs_child_diarrhoea": "Children under 5 with diarrhoea in past 2 weeks (survey estimate, LGA)",
          "dhs_child_fever": "Children under 5 with fever in past 2 weeks (survey estimate, LGA)"}


def cluster_to_lga(kr, ge, lga_gdf, year, origin=""):
    """Weighted LGA prevalence (%) of child diarrhoea and fever from the DHS children's file and GPS cluster file."""
    ge = ge[(ge["LATNUM"].abs() > 0) & (ge["LONGNUM"].abs() > 0)]  # clusters without GPS are coded 0,0
    pts = gpd.GeoDataFrame({"cluster": ge["DHSCLUST"].astype(int)},
                           geometry=gpd.points_from_xy(ge["LONGNUM"], ge["LATNUM"]), crs=4326)
    lga_gdf = lga_gdf.to_crs(4326) if lga_gdf.crs else lga_gdf.set_crs(4326)
    where = gpd.sjoin(pts, lga_gdf[["lga", "geometry"]], predicate="within", how="inner")[["cluster", "lga"]]
    df = _flags(kr).merge(where, on="cluster", how="inner")
    if df.empty:
        raise SystemExit("No survey clusters matched any LGA. Check the GPS file, its CRS and the cluster ids.")
    rows = []
    for ind, label in LABELS.items():
        d = df.dropna(subset=[ind])
        for lga, g in d.groupby("lga"):
            n, k = len(g), g["cluster"].nunique()
            low = n < LOW_N or k < LOW_CLUSTERS
            rows.append({"source": "DHS microdata", "indicator": ind, "survey_year": year, "geo_level": "lga", "geo_name": lga,
                         "label": label, "unit": "%", "value": round(float(np.average(g[ind], weights=g["w"]) * 100), 1),
                         "ci_low": None, "ci_high": None, "n": int(n), "n_clusters": int(k),
                         "note": with_origin(("Indicative only: " if low else "") + f"{n} children in {k} clusters; GPS displaced "
                                             "up to 2 km urban / 5 km rural; no design-based interval", origin)})
    return rows


def run_microdata(engine, kr_path, ge_path, year):
    for flag, path in (("--kr", kr_path), ("--ge", ge_path)):
        if not Path(path).is_file():
            raise SystemExit(f"{flag}: file not found: {path}")
    kr = pd.read_stata(kr_path, convert_categoricals=False, columns=["v001", "v005", "b5", "h11", "h22"])
    origin = (f"NDHS files from dhsprogram.com (registered download): {Path(kr_path).name} sha256 {sha12(kr_path)}, "
              f"{Path(ge_path).name} sha256 {sha12(ge_path)}; processed {TODAY}")
    return save(engine, cluster_to_lga(kr, gpd.read_file(ge_path), pipeline.lga_frame(engine), year, origin))


# ---------- Your own data: cholera, DHIS2 / IDSR counts, anything else ----------
def write_template(folder=MANUAL_DIR):
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / "_template_cholera.csv"
    dest.write_text(
        "indicator,label,unit,geo_level,geo_name,year,value,n,source,note\n"
        "cholera_cases,Suspected cholera cases,cases,state,Ondo,2021,0,,Ondo State Epidemiology Unit,EXAMPLE ROW\n"
        "cholera_cases,Suspected cholera cases,cases,lga,Akure South,2021,0,,Ondo State Epidemiology Unit,EXAMPLE ROW\n"
        "cholera_cases,Suspected cholera cases,cases,lga,Ondo West,2021,0,,Ondo State Epidemiology Unit,EXAMPLE ROW\n")
    print(f"Template written: {dest}\nCopy it to e.g. cholera.csv (no underscore), replace the rows, then run: python surveys.py csv")


def manual_rows(folder, lga_names):
    """One row per CSV line. Columns: indicator,label,unit,geo_level (state or lga),geo_name,year,value; optional n,source,note."""
    folder = Path(folder)
    known = {n.casefold(): n for n in lga_names}
    rows = []
    for f in sorted(folder.glob("*.csv")) if folder.is_dir() else []:
        if f.name.startswith("_"):
            continue
        df = pd.read_csv(f)
        df.columns = [str(c).strip().lower() for c in df.columns]
        miss = [c for c in MANUAL_COLS if c not in df.columns]
        if miss:
            print(f"skip {f.name}: missing columns {miss}")
            continue
        bad, kept, digest = set(), 0, sha12(f)
        for r in df.to_dict("records"):
            v, level = _num(r["value"]), str(r["geo_level"]).strip().lower()
            if v is None or level not in ("state", "lga") or _num(r["year"]) is None:
                continue
            name = STATE if level == "state" else known.get(str(r["geo_name"]).strip().casefold())
            if name is None:
                bad.add(str(r["geo_name"]))
                continue
            src = r.get("source")
            rows.append({"source": f.stem if pd.isna(src) or not src else str(src),
                         "indicator": re.sub(r"\W+", "_", str(r["indicator"]).strip().lower()).strip("_"),
                         "survey_year": int(r["year"]), "geo_level": level, "geo_name": name,
                         "label": str(r["label"]).strip(), "unit": "" if pd.isna(r["unit"]) else str(r["unit"]).strip(),
                         "value": v, "ci_low": None, "ci_high": None,
                         "n": None if _num(r.get("n")) is None else int(_num(r["n"])), "n_clusters": None,
                         "note": with_origin(f"Loaded from {f.name}" if pd.isna(r.get("note")) or not r.get("note") else str(r["note"]),
                                             f"user-supplied file {f.name} sha256 {digest}; named source: "
                                             f"{f.stem if pd.isna(src) or not src else src}; loaded {TODAY}")})
            kept += 1
        print(f"{f.name}: {kept} rows" + (f"; LGA names not recognised, skipped: {sorted(bad)}" if bad else ""))
    return rows


# ---------- Malaria Atlas Project: automatic raster download ----------
def map_coverages():
    """All coverage ids on the MAP geoserver."""
    r = requests.get(MAP_WCS, timeout=120, params={"service": "WCS", "version": "2.0.1", "request": "GetCapabilities"})
    r.raise_for_status()
    return sorted({c.strip() for c in re.findall(r"CoverageId>([^<]+)<", r.text) if c.strip()})


def pick_coverage(ids, include, exclude):
    """Latest vintage coverage whose id has all include words and none of the exclude words."""
    ok = [i for i in ids if all(w in i.lower() for w in include) and not any(w in i.lower() for w in exclude)]
    return sorted(ok, reverse=True)[0] if ok else None


def download_coverage(cov, bbox, year, dest):
    """GetCoverage -> GeoTIFF cropped to bbox (minx, miny, maxx, maxy). Tries the time slice for `year`, then none."""
    minx, miny, maxx, maxy = bbox
    base = [("service", "WCS"), ("version", "2.0.1"), ("request", "GetCoverage"), ("coverageId", cov),
            ("format", "image/tiff")]
    spatial = [[("subset", f"Long({minx},{maxx})"), ("subset", f"Lat({miny},{maxy})")],
               [("subset", f"lon({minx},{maxx})"), ("subset", f"lat({miny},{maxy})")]]
    last = ""
    for time in ([("subset", f'time("{year}-01-01T00:00:00.000Z")')], []):
        for sp in spatial:
            r = requests.get(MAP_WCS, params=base + sp + time, timeout=300)
            if r.ok and r.content[:2] in (b"II", b"MM"):
                dest.write_bytes(r.content)
                return bool(time)
            last = r.text[:200].replace("\n", " ")
    raise RuntimeError(f"GetCoverage failed for {cov}: {last}")


def fetch_maps(lga_gdf, year, folder=RASTER_DIR):
    """Download MAP rasters for Ondo into folder as <indicator>_<year>.tif and write index.json for the loader."""
    folder.mkdir(parents=True, exist_ok=True)
    ids = map_coverages()
    minx, miny, maxx, maxy = lga_gdf.to_crs(4326).total_bounds
    bbox = (minx - MAP_PAD, miny - MAP_PAD, maxx + MAP_PAD, maxy + MAP_PAD)
    meta_path = folder / "index.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    got = 0
    for ind, (include, exclude, label, unit, scale) in MAP_LAYERS.items():
        cov = pick_coverage(ids, include, exclude)
        if not cov:
            print(f"{ind}: no matching layer on the MAP server (looked for {include}), skipped")
            continue
        dest = folder / f"{ind}_{year}.tif"
        try:
            timed = download_coverage(cov, bbox, year, dest)
        except Exception as e:  # keep going with the other layers
            print(f"{ind}: {e}")
            continue
        meta[ind] = {"label": label, "unit": unit, "scale": scale}
        meta.setdefault("_files", {})[dest.name] = {"coverage": cov, "retrieved": TODAY, "server": MAP_WCS}
        note = "" if timed else " (server ignored the year, file is the layer's default time slice)"
        print(f"{ind}: {cov} -> {dest.name}{note}")
        got += 1
    meta_path.write_text(json.dumps(meta, indent=2))
    return got


# ---------- Rasters: LGA zonal means ----------
def zonal_rows(tif, lga_gdf, source, indicator, year, label=None, unit="", scale=1.0, origin=""):
    stats = zonal_stats(lga_gdf, str(tif), stats=["mean"], all_touched=True)
    return [{"source": source, "indicator": indicator, "survey_year": year, "geo_level": "lga", "geo_name": n,
             "label": label or indicator.replace("_", " "), "unit": unit,
             "value": None if s["mean"] is None else round(s["mean"] * scale, 3), "ci_low": None, "ci_high": None,
             "n": None, "n_clusters": None, "note": with_origin(f"Modelled surface ({source}); mean of raster cells in the LGA", origin)}
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
        m, fm = meta.get(ind, {}), meta.get("_files", {}).get(tif.name, {})
        retrieved = fm.get("retrieved") or datetime.fromtimestamp(tif.stat().st_mtime, timezone.utc).date().isoformat()
        origin = f"file {tif.name} sha256 {sha12(tif)}; retrieved {retrieved}" + (
            f"; layer {fm['coverage']} from {fm['server']}" if fm.get("coverage") else "; supplied manually, see the source's own site")
        rows += zonal_rows(tif, lga_gdf, source, ind, int(year), m.get("label"), m.get("unit", ""), m.get("scale", 1.0), origin)
        print(f"{tif.name}: done")
    return rows


def save(engine, rows):
    with engine.begin() as c:
        db.upsert(c, db.surveys, rows, db.SURVEY_KEYS)
    return len(rows)


def run_all(engine, year):
    total = 0
    try:
        total += save(engine, fetch_dhs())
    except Exception as e:
        print(f"skip dhs-api: {e}")
    try:
        fetch_maps(pipeline.lga_frame(engine), year)
    except Exception as e:
        print(f"skip fetch-maps: {e}")
    if any(RASTER_DIR.glob("*.tif")):
        total += save(engine, raster_rows(RASTER_DIR, pipeline.lga_frame(engine), "MAP"))
    else:
        print(f"skip rasters: no .tif files in {RASTER_DIR}")
    try:
        total += save(engine, manual_rows(MANUAL_DIR, list(pipeline.lga_frame(engine)["lga"])))
    except Exception as e:
        print(f"skip csv: {e}")
    kr_path, ge_path = find_file("ngkr*.dta"), find_file("ngge*.shp")
    if kr_path and ge_path:
        total += run_microdata(engine, kr_path, ge_path, 2023)
    else:
        print("skip dhs-microdata: put NGKR*.DTA and NGGE*.shp (unzipped) anywhere under data/surveys/")
    return total


def main():
    load_dotenv()
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("all", help="run every step that is available")
    sub.add_parser("dhs-api")
    sub.add_parser("csv-template", help="write a template CSV for your own data (cholera etc)")
    c = sub.add_parser("csv", help="load CSV files from data/surveys/manual")
    c.add_argument("folder", nargs="?", default=str(MANUAL_DIR))
    f = sub.add_parser("fetch-maps", help="download Malaria Atlas Project GeoTIFFs for Ondo, then load them")
    f.add_argument("--year", type=int, default=2022, help="raster year to download (latest MAP vintage is usually 2022)")
    f.add_argument("--no-load", action="store_true", help="download only, do not load into the database")
    m = sub.add_parser("dhs-microdata")
    m.add_argument("--kr", help="children's recode, e.g. data/surveys/NGKR8CFL.DTA (auto-found if omitted)")
    m.add_argument("--ge", help="GPS cluster shapefile, e.g. data/surveys/NGGE8AFL/NGGE8AFL.shp (auto-found if omitted)")
    m.add_argument("--year", type=int, default=2023, help="survey year to record (NDHS 2023-24 -> 2023)")
    r = sub.add_parser("rasters")
    r.add_argument("folder", nargs="?", default=str(RASTER_DIR))
    r.add_argument("--source", default="MAP", help='e.g. "MAP" or "IHME LBD"')
    a = p.parse_args()
    engine = db.get_engine()
    db.init_db(engine)

    if a.cmd == "all":
        n = run_all(engine, 2022)
    elif a.cmd == "dhs-api":
        n = save(engine, fetch_dhs())
    elif a.cmd == "csv-template":
        write_template()
        return
    elif a.cmd == "csv":
        n = save(engine, manual_rows(a.folder, list(pipeline.lga_frame(engine)["lga"])))
    elif a.cmd == "fetch-maps":
        fetch_maps(pipeline.lga_frame(engine), a.year)
        n = 0 if a.no_load else save(engine, raster_rows(RASTER_DIR, pipeline.lga_frame(engine), "MAP"))
    elif a.cmd == "dhs-microdata":
        kr_path, ge_path = a.kr or find_file("ngkr*.dta"), a.ge or find_file("ngge*.shp")
        if not (kr_path and ge_path):
            raise SystemExit("Need NGKR*.DTA and NGGE*.shp under data/surveys/, or pass --kr and --ge")
        n = run_microdata(engine, kr_path, ge_path, a.year)
    else:  # rasters
        if not Path(a.folder).is_dir():
            raise SystemExit(f"rasters: folder not found: {a.folder}")
        n = save(engine, raster_rows(a.folder, pipeline.lga_frame(engine), a.source))
    print("Saved", n, "rows")


if __name__ == "__main__":
    main()
