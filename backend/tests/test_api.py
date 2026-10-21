from sqlalchemy import insert

import db
from tests.conftest import ORIGIN


def seed_surveys(engine):
    rows = [{"source": "DHS microdata", "indicator": "dhs_child_fever", "survey_year": 2023, "geo_level": "lga", "geo_name": n,
             "label": "Fever", "unit": "%", "value": v, "n": 120, "n_clusters": 6, "note": "x"} for n, v in (("Alpha", 10.0), ("Beta", 20.0))]
    rows.append({"source": "DHS API", "indicator": "dhs_child_fever", "survey_year": 2023, "geo_level": "state", "geo_name": "Ondo",
                 "label": "Fever", "unit": "%", "value": 15.0, "n": None, "n_clusters": None, "note": None})
    with engine.begin() as c:
        c.execute(insert(db.surveys), rows)


def test_long_history_is_served(client):
    r = client.get("/api/meta").get_json()
    assert r["start"] == "1996-01" and r["end"] == "2025-12"


def test_correlations_matrix_and_lag(client):
    r = client.get("/api/correlations?variable=rain_mm&variable=rh2m&lag_a=rain_mm&lag_b=rh2m&max_lag=3").get_json()
    cell = next(c for c in r["matrix"] if c["a"] == "rain_mm" and c["b"] == "rh2m")
    assert cell["r"] > 0.5 and cell["n"] == 360 and r["deseasonalised"] is True
    assert len(r["lag"]) == 7 and r["start"] == "1996-01"


def test_correlations_drop_variables_without_data_and_validate(client):
    r = client.get("/api/correlations?variable=rain_mm&variable=t2m&variable=era5_t2m").get_json()
    assert "era5_t2m" not in r["variables"]  # no ERA5 data in range: dropped, not an error
    assert client.get("/api/correlations?variable=rain_mm&variable=nope").status_code == 400
    assert client.get("/api/correlations?variable=rain_mm&variable=t2m&method=bad").status_code == 400
    assert client.get("/api/correlations?variable=rain_mm&variable=t2m&scope=Nowhere").status_code == 400


def test_trends_detect_planted_warming(client):
    r = client.get("/api/trends?variable=t2m&variable=rain_mm").get_json()["trends"]
    assert r["t2m"]["direction"] == "increasing" and 0.2 < r["t2m"]["slope_per_decade"] < 0.4
    assert r["rain_mm"]["n_years"] == 30


def test_window_limits_period_and_scope(client):
    r = client.get("/api/trends?variable=t2m&start=2010-01&end=2020-12&scope=Beta").get_json()["trends"]["t2m"]
    assert r["start_year"] == 2010 and r["end_year"] == 2020


def test_survey_endpoints_and_cross_lga_correlation(client, engine):
    seed_surveys(engine)
    meta = client.get("/api/surveys/meta").get_json()
    assert {m["source"] for m in meta} == {"DHS microdata", "DHS API"}
    assert len(client.get("/api/surveys?indicator=dhs_child_fever&geo_level=lga").get_json()) == 2
    fc = client.get("/api/surveys/boundaries?indicator=dhs_child_fever&source=DHS%20microdata").get_json()
    assert {f["properties"]["lga"]: f["properties"]["value"] for f in fc["features"]} == {"Alpha": 10.0, "Beta": 20.0}
    # only 2 LGAs: too few for a correlation, so the API says so rather than inventing one
    cc = client.get("/api/correlations/survey?indicator=dhs_child_fever&source=DHS%20microdata&variable=rain_mm").get_json()
    assert cc["results"][0]["r"] is None and cc["n_lgas"] == 2
    assert client.get("/api/surveys?indicator=bogus").status_code == 400
    assert client.get("/api/surveys?indicator=dhs_child_fever").status_code == 400  # two sources: must choose


def test_requires_login(engine):
    from app import create_app
    app = create_app(engine); app.testing = True
    assert app.test_client().get("/api/correlations?variable=rain_mm&variable=t2m").status_code == 401


def test_export_includes_survey_sheet(client, engine):
    seed_surveys(engine)
    import io

    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(client.get("/api/export.xlsx").data))
    assert "Survey indicators" in wb.sheetnames
