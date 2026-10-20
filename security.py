"""Helpers for password reset links, two-factor codes and reset emails."""
import base64
import hashlib
import logging
import os
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import pyotp
from cryptography.fernet import Fernet
from sqlalchemy import delete, insert

import db

RESET_MINUTES = 30
APP_NAME = "Ondo State Climate Watch"


def fernet(secret_key):
    """Key for encrypting 2FA secrets at rest, derived from SECRET_KEY (changing SECRET_KEY invalidates enrolled 2FA)."""
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("totp:" + secret_key).encode()).digest()))


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def issue_reset(engine, user_id):
    """Create a single-use token (only its hash is stored). Older tokens for the user are removed."""
    token = secrets.token_urlsafe(32)
    with engine.begin() as c:
        c.execute(delete(db.resets).where(db.resets.c.user_id == user_id))
        c.execute(insert(db.resets).values(token_hash=_hash(token), user_id=user_id,
                                           expires_at=_now() + timedelta(minutes=RESET_MINUTES)))
    return token


def consume_reset(engine, token):
    """Atomically delete the token; return the user id if it existed and had not expired."""
    with engine.begin() as c:
        row = c.execute(delete(db.resets).where(db.resets.c.token_hash == _hash(token))
                        .returning(db.resets.c.user_id, db.resets.c.expires_at)).first()
    return row.user_id if row and row.expires_at > _now() else None


def verify_totp(secret, code):
    return bool(code) and pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


def send_reset_email(to, link):
    host = os.environ.get("SMTP_HOST")
    if not host:
        if os.environ.get("APP_ENV") != "production":
            logging.getLogger(__name__).warning("Dev only, no SMTP set. Reset link for %s: %s", to, link)
        return False
    msg = EmailMessage()
    msg["Subject"], msg["To"] = f"Reset your {APP_NAME} password", to
    msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", "")
    msg.set_content(f"Use this link within {RESET_MINUTES} minutes to set a new password:\n{link}\n\n"
                    "If you did not ask for this, ignore this email.")
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    return True
