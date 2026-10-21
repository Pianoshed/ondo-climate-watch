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


def _mail_from():
    return os.environ.get("MAIL_FROM") or os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", "")


def _body(link):
    return (f"Use this link within {RESET_MINUTES} minutes to set a new password:\n{link}\n\n"
            "If you did not ask for this, ignore this email.")


def _send_brevo(to, link):
    """Sends over HTTPS (port 443). Render's free plan blocks SMTP ports, but not this."""
    import requests

    log = logging.getLogger(__name__)
    sender = _mail_from()
    if not sender:
        log.error("BREVO_API_KEY is set but MAIL_FROM is not. Set MAIL_FROM to your verified Brevo sender address.")
        return False
    r = requests.post("https://api.brevo.com/v3/smtp/email", timeout=15,
                      headers={"api-key": os.environ["BREVO_API_KEY"], "accept": "application/json"},
                      json={"sender": {"name": "Ondo Climate Watch", "email": sender}, "to": [{"email": to}],
                            "subject": "Reset your password", "textContent": _body(link)})
    if r.status_code >= 300:
        log.error("Brevo refused the reset email (HTTP %s): %s", r.status_code, r.text[:300])
        return False
    return True


def _send_smtp(to, link):
    msg = EmailMessage()
    msg["Subject"], msg["To"] = "Reset your password", to
    msg["From"] = _mail_from()
    msg.set_content(_body(link))
    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    return True


def send_reset_email(to, link):
    """Email the reset link. The link is never written to the logs, unless you are NOT in production and have
    explicitly set DEV_LOG_RESET_LINK=1 on your own computer. Use `python manage.py reset-link EMAIL` instead."""
    log = logging.getLogger(__name__)
    try:
        if os.environ.get("BREVO_API_KEY"):
            return _send_brevo(to, link)
        if os.environ.get("SMTP_HOST"):
            return _send_smtp(to, link)
    except Exception as e:  # noqa: BLE001 - never let a mail failure leak details or change the page's answer
        log.error("Could not send the reset email (%s). Check the email settings.", type(e).__name__)
        return False
    if os.environ.get("APP_ENV") != "production" and os.environ.get("DEV_LOG_RESET_LINK") == "1":
        log.warning("Dev only, no email service set. Reset link for %s: %s", to, link)
    else:
        log.warning("No email service is set up, so no reset email was sent. "
                    "Use: python manage.py reset-link EMAIL, or set BREVO_API_KEY and MAIL_FROM.")
    return False
