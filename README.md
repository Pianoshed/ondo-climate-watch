# Ondo climate & health data tool
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
- `npm audit` (with dev tools) still lists 5 high findings, all from one chain inside ESLint's Next.js plugin (`braces`). No patched version exists, they run only on your computer and never ship. The CI check covers production dependencies and reports 0.
- Backend: `ruff check . && pytest` (in `backend/`)
- Frontend: `npm run lint && npm test && npm run build` (in `frontend/`)

## API (all need login except health and login)
`GET /api/health` · `POST /api/auth/login` · `/api/auth/mfa` · `/api/auth/mfa/setup` · `/api/auth/mfa/enable` · `/api/auth/forgot` · `/api/auth/reset` · `POST /api/auth/logout` · `GET /api/auth/me` · `GET /api/meta` · `GET /api/data?lga=&start=YYYY-MM&end=YYYY-MM` · `GET /api/summary?variable=` · `GET /api/boundaries?variable=` (GeoJSON for maps) · `GET /api/export.xlsx`

## Put it on GitHub
1. On github.com create a new **private** repository. Leave it empty (no README, no .gitignore).
2. In the project folder (the one that contains `backend`, `frontend` and `render.yaml`):

        git init -b main
        git add .
        git status        # check the list: there must be no .env, .venv or node_modules
        git commit -m "Ondo climate and health data tool"
        git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
        git push -u origin main
3. When Git asks for a password, paste a personal access token (GitHub > Settings > Developer settings), or sign in first with `gh auth login`.
4. Open the repository's Actions tab. CI runs lint, tests and both audits (Python 3.14).

## Deploy on Render (backend + frontend) with Supabase
1. **Supabase:** Project Settings > Database > Connection string > *Session pooler* (works over IPv4, which Render needs). Change the start to `postgresql+psycopg2://` and URL-encode the password.
2. **Render:** New > Blueprint > choose your repo. It creates `ondo-climate-api` (Python 3.14.3, gunicorn) and `ondo-climate-web` (Node).
3. Fill in the three values it asks for:
   - `DATABASE_URL`: the Supabase string from step 1
   - `ALLOWED_ORIGIN`: the exact URL of the **web** service, e.g. `https://ondo-climate-web.onrender.com` (https, no trailing slash)
   - `API_URL` (web service): the exact URL of the **api** service. It is read at build time, so after changing it use Manual Deploy > Clear build cache & deploy.
   If Render adds a suffix to a name because it is taken, use the real URLs shown on each service page.
4. **Load data** from your own computer, pointing at Supabase (Render's free plan has no shell): in `backend/`, put the Supabase `DATABASE_URL` in `.env`, then run `python manage.py init-db`, `python manage.py load-boundaries`, `python manage.py create-user you@example.org`, `python pipeline.py`.
5. **Check the deployment:** `scripts/check_deploy.sh https://ondo-climate-web.onrender.com`. It confirms the frontend reaches the backend (not localhost), the origin settings match, HSTS is on, and shows the IP the backend sees. If it shows a Render address, raise `TRUSTED_PROXY_HOPS` by 1 on the api service, so rate limits apply per person rather than to everyone at once.
6. Sign in, open Security, turn on two-factor sign-in.

Start command (already in `render.yaml`): `gunicorn "app:create_app()" --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 120`. One worker is deliberate: rate limits are kept in memory, so more workers would multiply the limits. For more than one worker, set `RATELIMIT_STORAGE_URI` to a Redis URL.

Monthly refresh: run `python pipeline.py` on your computer, or add a paid Render cron job. Free Render services sleep when idle, so the first visit after a break takes about a minute.
