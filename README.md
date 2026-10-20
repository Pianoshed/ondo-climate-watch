# Ondo State Climate Watch
Climate and health data tool for Ondo State.
Flask API + Supabase (Postgres) + Next.js. Monthly rainfall, temperature and humidity per Ondo LGA, with login, Excel export and charts.

## Setup, step by step
1. **Supabase project.** Create a project at supabase.com. Go to Project Settings > Database > Connection string and copy the *Session pooler* URI. Change the start to `postgresql+psycopg2://` and URL-encode the password.
2. **Backend env.** `cd backend && cp .env.example .env` and fill in `DATABASE_URL` and `SECRET_KEY` (`python -c "import secrets; print(secrets.token_hex(32))"`).
3. **Install.** `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt -r requirements-dev.txt`
4. **Create tables.** `python manage.py init-db` (also turns on row level security, see SECURITY.md).
5. **Load Ondo boundaries automatically.** `python manage.py load-boundaries` downloads Nigeria state and LGA boundaries (geoBoundaries), keeps the LGAs inside Ondo, and stops with an error unless it finds exactly 18.
6. **Create your login.** `python manage.py create-user you@example.org` (password 12+ characters). There is no public sign-up.
7. **Pull climate data.** `python pipeline.py` (CHIRPS + NASA POWER, 2015 to date). Rerun monthly.
8. **Run the API.** `python app.py` (port 5000). For production: `APP_ENV=production gunicorn "app:create_app()"`.
9. **Frontend.** `cd ../frontend && npm install && npm run dev`, open http://localhost:3000 and sign in. Needs Node 20.9 or newer.
10. **Turn on two-factor sign-in.** Sign in, open Security, scan the QR code with an authenticator app and enter the code. From then on sign-in asks for the code. Lost phone: `python manage.py reset-mfa EMAIL`.
11. **Password reset.** Users click "Forgot password?" on the sign-in page. To send emails, fill in the `SMTP_*` and `FRONTEND_URL` values in `.env`. Without email, run `python manage.py reset-link EMAIL` and send the one-time link to the user yourself (valid 30 minutes, works once).

## Pages
`/login` (with the 2FA step) · `/forgot` · `/reset` · `/` dashboard (charts, table, Excel) · `/map` (colour-coded LGA map) · `/security` (two-factor setup)

## Checks and dependency audits
- All checks at once, in CI: `.github/workflows/ci.yml` runs lint, tests, `pip-audit` and `npm audit` on every push and every Monday. Dependabot (`.github/dependabot.yml`) opens weekly upgrade pull requests.
- Audits locally: `scripts/audit.sh` (needs `pip-audit`, from requirements-dev.txt)
- Frontend dev tools may show a `braces` advisory in `npm audit` (no patched version exists, dev-only, never shipped). The CI check covers production dependencies.
- Backend: `ruff check . && pytest` (in `backend/`)
- Frontend: `npm run lint && npm test && npm run build` (in `frontend/`)

## API (all need login except health and login)
`GET /api/health` · `POST /api/auth/login` · `/api/auth/mfa` · `/api/auth/mfa/setup` · `/api/auth/mfa/enable` · `/api/auth/forgot` · `/api/auth/reset` · `POST /api/auth/logout` · `GET /api/auth/me` · `GET /api/meta` · `GET /api/data?lga=&start=YYYY-MM&end=YYYY-MM` · `GET /api/summary?variable=` · `GET /api/boundaries?variable=` (GeoJSON for maps) · `GET /api/export.xlsx`

## Name, icons and metadata
The app name and description live in `frontend/lib/brand.js`. Icons come from the Ondo State Climate Change & Health emblem:
`app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`, share cards `app/opengraph-image.png` and `app/twitter-image.png`,
and phone-install icons in `public/`. The web app manifest is `app/manifest.js`. Because sign-in is required, pages are marked
`noindex` (change `robots` in `app/layout.js` if you want search engines to list the login page).
Set `NEXT_PUBLIC_SITE_URL` to the public https address **when building** so share-card links are absolute.

## Deploying (Render)
Backend: set `APP_ENV=production`, `SECRET_KEY`, `DATABASE_URL`, `ALLOWED_ORIGIN` (the frontend's https URL). Frontend: set `API_URL` to the backend URL and (at build time) `NEXT_PUBLIC_SITE_URL` to the frontend's https URL. Set `FRONTEND_URL` and the `SMTP_*` values for reset emails. Use a Redis URL for `RATELIMIT_STORAGE_URI` if you run more than one worker.
