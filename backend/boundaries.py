"""Loads Ondo State LGA boundaries automatically from the open geoBoundaries dataset into the lgas table."""
import json
import os

import geopandas as gpd
from dotenv import load_dotenv
from shapely.geometry import mapping

import db

# media.githubusercontent.com resolves the Git LFS files; override with BOUNDARY_ADM1_URL / BOUNDARY_ADM2_URL
BASE = "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/NGA/{lvl}/"
BASE += "geoBoundaries-NGA-{lvl}.geojson"
EXPECTED_LGAS = 18


def select_ondo(adm1, adm2, state="Ondo", expected=EXPECTED_LGAS):
    """Keep the LGAs (admin 2) whose representative point lies inside the state polygon (admin 1)."""
    st = adm1[adm1.shapeName.str.contains(state, case=False)]
    if len(st) != 1:
        raise ValueError(f"Expected one state matching {state!r}, found {len(st)}")
    inside = adm2[adm2.geometry.representative_point().within(st.geometry.iloc[0])]
    if expected and len(inside) != expected:
        raise ValueError(f"Expected {expected} LGAs for {state}, found {len(inside)}. Check the boundary source.")
    return inside[["shapeName", "geometry"]].rename(columns={"shapeName": "name"})


def load(engine, adm1=None, adm2=None, **kw):
    if adm1 is None:
        adm1 = gpd.read_file(os.environ.get("BOUNDARY_ADM1_URL") or BASE.format(lvl="ADM1")).to_crs(4326)
    if adm2 is None:
        adm2 = gpd.read_file(os.environ.get("BOUNDARY_ADM2_URL") or BASE.format(lvl="ADM2")).to_crs(4326)
    lg = select_ondo(adm1, adm2, **kw)
    cent = lg.to_crs(32631).geometry.centroid.to_crs(4326)
    rows = [{"name": n, "geojson": json.dumps(mapping(g)), "lon": round(c.x, 4), "lat": round(c.y, 4)}
            for n, g, c in zip(lg["name"], lg.geometry, cent, strict=True)]
    with engine.begin() as conn:
        db.upsert(conn, db.lgas, rows, ["name"])
    return len(rows)


if __name__ == "__main__":
    load_dotenv()
    print("Loaded", load(db.get_engine()), "LGAs")
