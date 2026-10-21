import os

from sqlalchemy import Boolean, Column, DateTime, Float, Integer, MetaData, String, Table, Text, create_engine, false, func, text
from sqlalchemy.dialects import postgresql, sqlite

meta = MetaData()
ERA5_COLUMNS = ["era5_t2m", "era5_dewpoint", "era5_rain_mm", "era5_rh2m", "era5_radiation", "era5_wind",
                "era5_pressure", "era5_soil"]
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
                Column("rain_mm", Float), Column("t2m", Float), Column("t2m_max", Float), Column("rh2m", Float),
                # ERA5-Land (Copernicus), 1996 to date; filled by era5.py
                *[Column(c, Float) for c in ERA5_COLUMNS])
# Survey and modelled health indicators (DHS, Malaria Atlas Project, IHME rasters). One row per
# source x indicator x survey year x area. geo_level is "state" (survey estimate for Ondo as a whole) or "lga".
surveys = Table("survey_indicator", meta,
                Column("source", String(40), primary_key=True),
                Column("indicator", String(80), primary_key=True),
                Column("survey_year", Integer, primary_key=True),
                Column("geo_level", String(10), primary_key=True),
                Column("geo_name", String(100), primary_key=True),
                Column("label", String(200)), Column("unit", String(40)),
                Column("value", Float), Column("ci_low", Float), Column("ci_high", Float),
                Column("n", Integer), Column("n_clusters", Integer),
                Column("note", String(300)))
SURVEY_KEYS = ["source", "indicator", "survey_year", "geo_level", "geo_name"]


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
            for col in ERA5_COLUMNS:  # upgrade a database created before the ERA5 columns existed
                c.execute(text(f"ALTER TABLE climate_lga_month ADD COLUMN IF NOT EXISTS {col} DOUBLE PRECISION"))  # noqa: S608
            for name in meta.tables:
                c.execute(text(f'ALTER TABLE "{name}" ENABLE ROW LEVEL SECURITY'))  # noqa: S608


def upsert(conn, table, rows, keys, chunk=500):
    """Insert or update rows (list of dicts) on the key columns. Only the columns present in rows are updated.
    Rows go to the database in multi-row statements of `chunk` rows: one network round trip per chunk instead of one
    per row, which is what makes a 6,000-row load to a remote Postgres take seconds rather than many minutes."""
    if not rows:
        return
    ins = (postgresql if conn.dialect.name == "postgresql" else sqlite).insert(table)
    first = list(rows[0])
    cols = [c for c in first if c not in keys]
    for i in range(0, len(rows), chunk):
        stmt = ins.values([{k: r.get(k) for k in first} for r in rows[i:i + chunk]])
        conn.execute(stmt.on_conflict_do_update(index_elements=keys, set_={c: stmt.excluded[c] for c in cols}))
