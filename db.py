import os

from sqlalchemy import Boolean, Column, DateTime, Float, Integer, MetaData, String, Table, Text, create_engine, false, func, text
from sqlalchemy.dialects import postgresql, sqlite

meta = MetaData()
users = Table("users", meta,
              Column("id", Integer, primary_key=True),
              Column("email", String(254), unique=True, nullable=False),
              Column("password_hash", String(255), nullable=False),
              Column("totp_secret", String(255)),
              Column("totp_enabled", Boolean, nullable=False, server_default=false()),
              Column("created_at", DateTime, server_default=func.now()))
resets = Table("password_resets", meta,
               Column("token_hash", String(64), primary_key=True),
               Column("user_id", Integer, nullable=False),
               Column("expires_at", DateTime, nullable=False))
lgas = Table("lgas", meta,
             Column("name", String(100), primary_key=True),
             Column("geojson", Text, nullable=False),
             Column("lon", Float), Column("lat", Float))
climate = Table("climate_lga_month", meta,
                Column("lga", String(100), primary_key=True),
                Column("year", Integer, primary_key=True),
                Column("month", Integer, primary_key=True),
                Column("rain_mm", Float), Column("t2m", Float), Column("t2m_max", Float), Column("rh2m", Float))


def get_engine(url=None):
    url = url or os.environ["DATABASE_URL"]
    for old in ("postgres://", "postgresql://"):
        if url.startswith(old):
            url = "postgresql+psycopg2://" + url[len(old):]
    return create_engine(url, pool_pre_ping=True)


def init_db(engine):
    """Create tables. On Postgres/Supabase also enable row level security with no policies, so the public
    Supabase REST API (anon key) cannot read anything; only this server's direct connection can."""
    meta.create_all(engine)
    if engine.dialect.name == "postgresql":
        with engine.begin() as c:  # upgrade a database created before two-factor login existed
            c.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255)"))
            c.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false"))
            for name in meta.tables:
                c.execute(text(f'ALTER TABLE "{name}" ENABLE ROW LEVEL SECURITY'))  # noqa: S608


def upsert(conn, table, rows, keys):
    """Insert or update rows (list of dicts) on the key columns. Only the columns present in rows are updated."""
    if not rows:
        return
    ins = (postgresql if conn.dialect.name == "postgresql" else sqlite).insert(table)
    cols = [c for c in rows[0] if c not in keys]
    conn.execute(ins.on_conflict_do_update(index_elements=keys, set_={c: ins.excluded[c] for c in cols}), rows)
