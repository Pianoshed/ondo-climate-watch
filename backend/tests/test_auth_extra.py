import pyotp
from sqlalchemy import select, update

import db
import security
from tests.conftest import ORIGIN

NEW = "a brand new passphrase"


def post(c, path, body):
    return c.post(path, json=body, headers=ORIGIN)


def test_two_factor_login_flow(authed):
    setup = post(authed, "/api/auth/mfa/setup", {}).get_json()
    assert setup["qr"].startswith("data:image/svg+xml")
    totp = pyotp.TOTP(setup["secret"])
    assert post(authed, "/api/auth/mfa/enable", {"code": "000000"}).status_code == 400
    assert post(authed, "/api/auth/mfa/enable", {"code": totp.now()}).status_code == 200
    post(authed, "/api/auth/logout", {})
    r = post(authed, "/api/auth/login", {"email": "ada@example.org", "password": "correct horse battery"})
    assert r.get_json() == {"mfa_required": True} and authed.get("/api/data").status_code == 401
    assert post(authed, "/api/auth/mfa", {"code": "000000"}).status_code == 401
    assert post(authed, "/api/auth/mfa", {"code": totp.now()}).status_code == 200
    assert authed.get("/api/data").status_code == 200 and authed.get("/api/auth/me").get_json()["mfa"] is True


def test_mfa_code_without_password_step_rejected(client):
    assert post(client, "/api/auth/mfa", {"code": "123456"}).status_code == 401


def test_two_factor_secret_encrypted_at_rest(authed, engine):
    secret = post(authed, "/api/auth/mfa/setup", {}).get_json()["secret"]
    post(authed, "/api/auth/mfa/enable", {"code": pyotp.TOTP(secret).now()})
    with engine.connect() as c:
        assert secret not in c.execute(select(db.users.c.totp_secret)).scalar()


def capture(monkeypatch):
    sent = []
    monkeypatch.setattr(security, "send_reset_email", lambda to, link: sent.append(link))
    return sent


def test_password_reset_flow(client, monkeypatch):
    sent = capture(monkeypatch)
    assert post(client, "/api/auth/forgot", {"email": "ada@example.org"}).status_code == 200
    token = sent[0].split("#token=")[1]
    assert post(client, "/api/auth/reset", {"token": token, "password": "short"}).status_code == 400  # token not burned
    assert post(client, "/api/auth/reset", {"token": token, "password": NEW}).status_code == 200
    assert post(client, "/api/auth/reset", {"token": token, "password": NEW}).status_code == 400  # single use
    assert post(client, "/api/auth/login", {"email": "ada@example.org", "password": "correct horse battery"}).status_code == 401
    assert post(client, "/api/auth/login", {"email": "ada@example.org", "password": NEW}).status_code == 200


def test_forgot_does_not_reveal_accounts(client, monkeypatch):
    sent = capture(monkeypatch)
    a = post(client, "/api/auth/forgot", {"email": "ada@example.org"})
    b = post(client, "/api/auth/forgot", {"email": "nobody@example.org"})
    assert a.status_code == b.status_code == 200 and a.get_json() == b.get_json() and len(sent) == 1


def test_expired_reset_token_rejected(client, engine, monkeypatch):
    sent = capture(monkeypatch)
    post(client, "/api/auth/forgot", {"email": "ada@example.org"})
    with engine.begin() as c:
        c.execute(update(db.resets).values(expires_at=security._now()))
    assert post(client, "/api/auth/reset", {"token": sent[0].split("#token=")[1], "password": NEW}).status_code == 400


def test_forgot_rate_limited(client, monkeypatch):
    capture(monkeypatch)
    codes = [post(client, "/api/auth/forgot", {"email": "ada@example.org"}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_password_reset_ends_existing_sessions(authed, engine):
    token = security.issue_reset(engine, 1)
    other = authed.application.test_client()
    assert post(other, "/api/auth/reset", {"token": token, "password": NEW}).status_code == 200
    assert authed.get("/api/data").status_code == 401
