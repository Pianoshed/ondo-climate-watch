import io

from openpyxl import load_workbook

from tests.conftest import ORIGIN

BAD = {"email": "ada@example.org", "password": "wrong-password-123"}


def test_requires_login(client):
    for path in ("/api/data", "/api/meta", "/api/summary", "/api/export.xlsx", "/api/boundaries"):
        assert client.get(path).status_code == 401


def test_login_and_cookie_flags(client):
    r = client.post("/api/auth/login", json={"email": "ADA@example.org", "password": "correct horse battery"},
                    headers=ORIGIN)
    cookie = r.headers["Set-Cookie"]
    assert r.status_code == 200 and "HttpOnly" in cookie and "SameSite=Strict" in cookie


def test_bad_login_same_message_for_unknown_user(client):
    a = client.post("/api/auth/login", json=BAD, headers=ORIGIN)
    b = client.post("/api/auth/login", json={**BAD, "email": "nobody@example.org"}, headers=ORIGIN)
    assert a.status_code == b.status_code == 401 and a.get_json() == b.get_json()


def test_post_without_origin_rejected(client):
    assert client.post("/api/auth/login", json=BAD).status_code == 403


def test_login_rate_limited(client):
    codes = [client.post("/api/auth/login", json=BAD, headers=ORIGIN).status_code for _ in range(7)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_data_filters(authed):
    rows = authed.get("/api/data?lga=Akure South&start=2024-02&end=2024-03").get_json()
    assert [r["period"] for r in rows] == ["2024-02", "2024-03"]
    assert authed.get("/api/summary?variable=rain_mm").get_json()[0]["value"] == 20.0


def test_injection_attempts_rejected(authed):
    for q in ("lga=x' OR '1'='1", "lga=Akure South'; DROP TABLE users;--", "start=2024-01' OR '1'='1",
              "variable=rain_mm;DROP TABLE users"):
        assert authed.get(f"/api/data?{q}").status_code == 400 or authed.get(f"/api/summary?{q}").status_code == 400
    assert len(authed.get("/api/data").get_json()) == 6  # data intact


def test_export_xlsx_sanitised(authed):
    r = authed.get("/api/export.xlsx")
    wb = load_workbook(io.BytesIO(r.data))
    assert {"Data", "About"} <= set(wb.sheetnames)
    col = [c.value for c in wb["Data"]["A"]]
    assert "'=EVIL()" in col and not any(str(v).startswith("=") for v in col)


def test_boundaries_geojson_and_headers(authed):
    r = authed.get("/api/boundaries?variable=rain_mm")
    assert r.get_json()["type"] == "FeatureCollection" and len(r.get_json()["features"]) == 2
    assert r.headers["X-Content-Type-Options"] == "nosniff" and "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]


def test_logout_clears_session(authed):
    authed.post("/api/auth/logout", headers=ORIGIN)
    assert authed.get("/api/data").status_code == 401
