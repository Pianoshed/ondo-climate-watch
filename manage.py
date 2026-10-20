"""Admin commands: init-db, load-boundaries, create-user, reset-link, reset-mfa (the last three take an EMAIL)."""
import argparse
import getpass
import os

from dotenv import load_dotenv
from sqlalchemy import insert, select, update
from werkzeug.security import generate_password_hash

import boundaries
import db
import security


def create_user(engine, email, password):
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters")
    with engine.begin() as c:
        c.execute(insert(db.users).values(email=email.strip().lower(), password_hash=generate_password_hash(password)))


def main():
    load_dotenv()
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["init-db", "load-boundaries", "create-user", "reset-link", "reset-mfa"])
    p.add_argument("email", nargs="?")
    a = p.parse_args()
    engine = db.get_engine()
    if a.cmd == "init-db":
        db.init_db(engine)
    elif a.cmd == "load-boundaries":
        print("Loaded", boundaries.load(engine), "LGAs")
    elif a.cmd == "reset-mfa":  # lost phone: turn two-factor off so the user can set it up again
        with engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.email == a.email.lower()).values(totp_secret=None, totp_enabled=False))
    elif a.cmd == "reset-link":  # works without email set up: send this one-time link to the user yourself
        with engine.connect() as c:
            user = c.execute(select(db.users).where(db.users.c.email == a.email.lower())).first()
        if not user:
            raise SystemExit("No such user")
        print(f"{os.environ.get('FRONTEND_URL', 'http://localhost:3000')}/reset#token={security.issue_reset(engine, user.id)}")
    else:
        create_user(engine, a.email, getpass.getpass("Password (12+ chars): "))
    print("OK")


if __name__ == "__main__":
    main()
