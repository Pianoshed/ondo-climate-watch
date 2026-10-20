import geopandas as gpd
import pytest
from shapely.geometry import box

import db
from boundaries import load, select_ondo
from pipeline import parse_power


def frames():
    adm1 = gpd.GeoDataFrame({"shapeName": ["Ondo", "Ekiti"]}, geometry=[box(0, 0, 10, 10), box(10, 0, 20, 10)], crs=4326)
    adm2 = gpd.GeoDataFrame({"shapeName": ["A", "B", "C"]}, geometry=[box(1, 1, 2, 2), box(5, 5, 6, 6), box(12, 1, 13, 2)],
                            crs=4326)
    return adm1, adm2


def test_select_ondo_picks_only_lgas_inside_state():
    assert list(select_ondo(*frames(), expected=2)["name"]) == ["A", "B"]


def test_select_ondo_fails_loudly_on_wrong_count():
    with pytest.raises(ValueError):
        select_ondo(*frames(), expected=18)


def test_load_writes_lgas_idempotently(tmp_path):
    eng = db.get_engine(f"sqlite:///{tmp_path}/b.db")
    db.init_db(eng)
    assert load(eng, *frames(), expected=2) == 2 and load(eng, *frames(), expected=2) == 2
    with eng.connect() as c:
        assert len(c.execute(db.lgas.select()).all()) == 2


def test_parse_power_handles_missing_and_annual():
    par = {k: {"202401": 1.5, "202402": -999, "202413": 9.9} for k in ("T2M", "T2M_MAX", "RH2M")}
    rows = parse_power("Owo", {"properties": {"parameter": par}})
    assert len(rows) == 2 and rows[1]["t2m"] is None and rows[0]["month"] == 1


def test_partial_upsert_keeps_other_columns(tmp_path):
    eng = db.get_engine(f"sqlite:///{tmp_path}/u.db")
    db.init_db(eng)
    key = {"lga": "Owo", "year": 2024, "month": 1}
    with eng.begin() as c:
        db.upsert(c, db.climate, [{**key, "rain_mm": 5.0}], list(key))
        db.upsert(c, db.climate, [{**key, "t2m": 27.0}], list(key))
        db.upsert(c, db.climate, [{**key, "rain_mm": 6.0}], list(key))
        row = c.execute(db.climate.select()).one()
    assert (row.rain_mm, row.t2m) == (6.0, 27.0)
