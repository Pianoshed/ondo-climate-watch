import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

import surveys


def lgas():
    return gpd.GeoDataFrame({"lga": ["Alpha", "Beta"]}, geometry=[box(5, 7, 6, 8), box(6, 7, 7, 8)], crs=4326)


def test_parse_dhs_keeps_only_ondo_and_strips_label_dots():
    payload = {"Data": [
        {"IndicatorId": "CH_FEVR_C_FEV", "Indicator": "Fever", "SurveyYear": 2023, "CharacteristicLabel": "..Ondo", "Value": 12.5,
         "CILow": 10, "CIHigh": 15, "DenominatorUnweighted": 300},
        {"IndicatorId": "CH_FEVR_C_FEV", "Indicator": "Fever", "SurveyYear": 2023, "CharacteristicLabel": "..Osun", "Value": 9},
        {"IndicatorId": "CH_FEVR_C_FEV", "Indicator": "Fever", "SurveyYear": 2018, "CharacteristicLabel": "..Ondo", "Value": None}]}
    rows = surveys.parse_dhs(payload)
    assert len(rows) == 1 and rows[0]["value"] == 12.5 and rows[0]["geo_level"] == "state" and rows[0]["n"] == 300


def test_cluster_to_lga_weights_flags_and_drops_no_gps():
    ge = pd.DataFrame({"DHSCLUST": [1, 2, 3, 4], "LATNUM": [7.5, 7.5, 7.5, 0.0], "LONGNUM": [5.5, 6.5, 6.6, 0.0]})
    kr = pd.DataFrame({"v001": [1] * 4 + [2] * 2 + [3] * 2 + [4],
                       "v005": [1_000_000] * 9, "b5": [1] * 9,
                       "h11": [0, 0, 2, 8, 0, 0, 1, 1, 1],   # 8 = don't know, excluded
                       "h22": [1, 1, 0, 0, 0, 1, 1, 1, 1]})
    rows = {(r["indicator"], r["geo_name"]): r for r in surveys.cluster_to_lga(kr, ge, lgas(), 2023)}
    a = rows[("dhs_child_diarrhoea", "Alpha")]
    assert a["value"] == round(1 / 3 * 100, 1) and a["n"] == 3 and "Indicative only" in a["note"]  # 3 children: too few
    assert rows[("dhs_child_fever", "Alpha")]["n"] == 4
    assert rows[("dhs_child_diarrhoea", "Beta")]["value"] == 50.0  # cluster 4 had no GPS and is excluded


def test_weights_change_the_estimate():
    ge = pd.DataFrame({"DHSCLUST": [1], "LATNUM": [7.5], "LONGNUM": [5.5]})
    kr = pd.DataFrame({"v001": [1, 1], "v005": [3_000_000, 1_000_000], "b5": [1, 1], "h11": [1, 0], "h22": [0, 0]})
    r = next(x for x in surveys.cluster_to_lga(kr, ge, lgas(), 2023) if x["indicator"] == "dhs_child_diarrhoea")
    assert r["value"] == 75.0


def test_raster_zonal_means_scale_and_naming(tmp_path):
    data = np.zeros((10, 20), dtype="float32"); data[:, :10] = 0.2; data[:, 10:] = 0.4  # west half 0.2, east half 0.4
    with rasterio.open(tmp_path / "pfpr_2022.tif", "w", driver="GTiff", height=10, width=20, count=1, dtype="float32", crs="EPSG:4326",
                       transform=from_origin(5, 8, 0.1, 0.1)) as dst:
        dst.write(data, 1)
    (tmp_path / "bad name.tif").write_bytes(b"")
    (tmp_path / "index.json").write_text('{"pfpr": {"label": "Pf prevalence", "unit": "%", "scale": 100}}')
    rows = {r["geo_name"]: r for r in surveys.raster_rows(tmp_path, lgas().iloc[:2], "MAP")}
    assert rows["Alpha"]["value"] == 20.0 and rows["Beta"]["value"] == 40.0 and rows["Alpha"]["label"] == "Pf prevalence"
    assert rows["Alpha"]["survey_year"] == 2022
