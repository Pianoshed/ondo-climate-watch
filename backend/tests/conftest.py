import numpy as np
import pandas as pd
import pytest
from sqlalchemy import insert
from werkzeug.security import generate_password_hash

import db
from app import create_app

ORIGIN = {"Origin": "http://localhost:3000"}


def square(x, y):
    return {"type": "Polygon", "coordinates": [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]}


@pytest.fixture
def engine(tmp_path):
    e = db.get_engine(f"sqlite:///{tmp_path / 't.db'}")
    db.init_db(e)
    rng = np.random.default_rng(1)
    rows = []
    for lga in ("Alpha", "Beta"):
        for y in range(1996, 2026):  # 30 years, starts well before 2015
            for m in range(1, 13):
                season = np.sin((m - 3) / 12 * 2 * np.pi)
                rain = 150 + 120 * season + rng.normal(0, 20) + (30 if lga == "Beta" else 0)
                rows.append({"lga": lga, "year": y, "month": m, "rain_mm": rain,
                             "t2m": 25 + 0.03 * (y - 1996) - 1.5 * season + rng.normal(0, .3),
                             "t2m_max": 31 + 0.03 * (y - 1996) + rng.normal(0, .4),
                             "rh2m": 80 + 0.1 * (rain - 150) + rng.normal(0, 2),
                             "era5_t2m": None})
    with e.begin() as c:
        c.execute(insert(db.lgas), [{"name": "Alpha", "geojson": __import__("json").dumps(square(5, 7)), "lon": 5.5, "lat": 7.5},
                                    {"name": "Beta", "geojson": __import__("json").dumps(square(6, 7)), "lon": 6.5, "lat": 7.5}])
        db.upsert(c, db.climate, rows, ["lga", "year", "month"])
        c.execute(insert(db.users).values(email="a@b.org", password_hash=generate_password_hash("correct horse battery")))
    return e


@pytest.fixture
def client(engine):
    app = create_app(engine)
    app.testing = True
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": "a@b.org", "password": "correct horse battery"}, headers=ORIGIN)
    assert r.status_code == 200
    return c
