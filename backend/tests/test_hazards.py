import pandas as pd
import pytest

import hazards
from tests.conftest import ORIGIN  # noqa: F401  (keeps the shared fixtures importable)


def daily(years=(2000, 2001, 2002), hot=(), wet=(), gusty=()):
    idx = pd.date_range(f"{years[0]}-01-01", f"{years[-1]}-12-31", freq="D", name="date")
    d = pd.DataFrame({"tmax": 30.0, "rain": 0.0, "wspd": 3.0, "gust": 6.0, "wdir": 225.0}, index=idx)  # wind from the south-west
    for day in hot:
        d.loc[day, "tmax"] = 40.0
    for day, mm in wet:
        d.loc[day, "rain"] = mm
    for day in gusty:
        d.loc[day, "gust"] = 15.0
    return d


def test_known_events_are_counted():
    d = daily(hot=pd.date_range("2001-03-10", periods=4).strftime("%Y-%m-%d"), wet=[("2001-06-05", 120)],
              gusty=["2001-07-01", "2001-07-02"])
    yr, se, ro, years = hazards.compute({"A": d}, 2000, 2002)
    y = {(r["year"], r["metric"]): r["value"] for r in yr}
    assert years == [2000, 2001, 2002]
    assert (y[2001, "heatwave_days"], y[2001, "heatwave_events"], y[2001, "heatwave_longest"]) == (4, 1, 4)
    assert y[2000, "heatwave_days"] == 0 and y[2001, "tmax_peak"] == 40
    got = (y[2001, "rx1day"], y[2001, "heavy_days_50mm"], y[2001, "flood_alert_days"], y[2001, "annual_rain"])
    assert got == (120, 1, 3, 120)
    assert y[2001, "gust_days_ge14"] == 2 and y[2001, "max_gust"] == 15
    march = next(r["value"] for r in se if r["metric"] == "heatwave_days" and r["month"] == 3)
    assert march == pytest.approx(4 / 3)  # 4 hot days in one of three years
    sw = next(r for r in ro if r["season"] == "all" and r["sector"] == 5)  # 225 degrees is the SW sector
    assert sw["freq"] == pytest.approx(100) and sw["speed"] == pytest.approx(3)


def test_two_hot_days_are_not_a_heat_wave():
    yr, *_ = hazards.compute({"A": daily(hot=["2001-03-10", "2001-03-11"])}, 2000, 2002)
    assert {(r["year"], r["metric"]): r["value"] for r in yr}[2001, "heatwave_days"] == 0


def test_incomplete_years_are_dropped():
    d = daily(years=(2000, 2001)).loc[:"2001-06-30"]
    *_, years = hazards.compute({"A": d}, 2000, 2001)
    assert years == [2000]
    with pytest.raises(ValueError):
        hazards.compute({"A": d.loc[:"2000-06-30"]}, 2000, 2000)


def seed(engine):
    d = daily(hot=pd.date_range("2001-03-10", periods=4).strftime("%Y-%m-%d"), wet=[("2001-06-05", 120)])
    return hazards.store(engine, {"Alpha": d, "Beta": d.assign(rain=d["rain"] * 2)}, 2000, 2002)


def test_store_is_repeatable_and_api_serves_it(client, engine):
    assert client.get("/api/hazards").status_code == 404  # nothing loaded yet
    assert seed(engine)["years"] == 3 and seed(engine)["years"] == 3  # second run replaces, never duplicates
    r = client.get("/api/hazards").get_json()
    assert r["years"] == [2000, 2001, 2002] and set(r["lgas"]) == {"Alpha", "Beta"} and r["sectors"][5] == "SW"
    assert r["lgas"]["Alpha"]["yearly"]["heatwave_days"] == [0, 4, 0]
    assert r["lgas"]["Beta"]["yearly"]["rx1day"][1] == 240
    assert len(r["lgas"]["Alpha"]["seasonal"]["heatwave_days"]) == 12 and len(r["state_seasonal"]["heatwave_days"]) == 12
    sw = r["state_windrose"]["all"]
    assert sw["freq"][5] == pytest.approx(100) and sw["speed"][5] == pytest.approx(3)
    assert r["metrics"]["rx1day"]["group"] == "flood"


def test_csv_export_and_login(client, engine):
    seed(engine)
    body = client.get("/api/hazards/export.csv").data.decode("utf-8-sig")
    assert body.splitlines()[0].startswith("LGA,Year,Wettest day of the year (mm)") and len(body.splitlines()) == 7
    from app import create_app
    app = create_app(engine)
    app.testing = True
    assert app.test_client().get("/api/hazards").status_code == 401
    assert app.test_client().get("/api/hazards/export.csv").status_code == 401


def test_cache_only_downloads_new_days(tmp_path, monkeypatch):
    monkeypatch.setattr(hazards, "CACHE", tmp_path)
    calls = []

    def fake(lat, lon, start, end, pause):
        calls.append((start, end))
        return daily(years=(int(start[:4]), int(end[:4]))).loc[start:end]

    monkeypatch.setattr(hazards, "download", fake)
    hazards.get_daily("Owo", 7, 5, "2000-01-01", "2001-12-31")
    d = hazards.get_daily("Owo", 7, 5, "2000-01-01", "2002-03-31")
    assert calls[0] == ("2000-01-01", "2001-12-31") and calls[1][0] == "2001-12-21"  # last day minus the refetch window
    assert d.index.max() == pd.Timestamp("2002-03-31") and d.index.is_unique
