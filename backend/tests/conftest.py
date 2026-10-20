import pytest

import db
import manage
from app import create_app

ORIGIN = {"Origin": "http://localhost:3000"}
POLY = '{"type":"Polygon","coordinates":[[[5,7],[5.5,7],[5.5,7.5],[5,7]]]}'


@pytest.fixture()
def engine(tmp_path):
    eng = db.get_engine(f"sqlite:///{tmp_path}/t.db")
    db.init_db(eng)
    with eng.begin() as c:
        db.upsert(c, db.lgas, [{"name": n, "geojson": POLY, "lon": 5.2, "lat": 7.2} for n in ("Akure South", "=EVIL()")],
                  ["name"])
        db.upsert(c, db.climate, [{"lga": n, "year": 2024, "month": m, "rain_mm": 10.0 * m, "t2m": 26.5,
                                   "t2m_max": 31.0, "rh2m": 80.0} for n in ("Akure South", "=EVIL()")
                                  for m in (1, 2, 3)], ["lga", "year", "month"])
    manage.create_user(eng, "ada@example.org", "correct horse battery")
    return eng


@pytest.fixture()
def client(engine):
    app = create_app(engine)
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture()
def authed(client):
    r = client.post("/api/auth/login", json={"email": "ada@example.org", "password": "correct horse battery"},
                    headers=ORIGIN)
    assert r.status_code == 200
    return client
