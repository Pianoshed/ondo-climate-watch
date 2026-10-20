import pytest

from app import create_app


def test_production_refuses_local_or_missing_frontend_origin(engine, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SECRET_KEY", "x" * 32)
    for bad in ("http://localhost:3000", "http://ondo-web.onrender.com", "https://ondo-web.onrender.com/"):
        monkeypatch.setenv("ALLOWED_ORIGIN", bad)
        with pytest.raises(RuntimeError):
            create_app(engine)
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://ondo-web.onrender.com")
    assert create_app(engine)


def test_production_requires_secret_key(engine, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError):
        create_app(engine)
