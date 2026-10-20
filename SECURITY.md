# Security architecture
Browser > Next.js (proxies /api, adds security headers) > Flask API > Supabase Postgres (direct connection only).

| Risk | Control |
|---|---|
| SQL injection | SQLAlchemy bound parameters only; LGAs checked against an allow-list from the database, variables against a fixed list, dates against a strict pattern. Tests send injection strings. |
| Brute force / credential stuffing | Login limited to 5/min and 30/hour per IP, plus 10/hour per email; 200/min default on every route. Generic error message and equal timing for unknown emails. |
| Weak passwords / stolen DB | 12+ character minimum, scrypt hashes, no public sign-up (admin creates users). |
| Stolen password | Optional authenticator-app (TOTP) second step. The half-signed-in state lasts 5 minutes and code guesses are limited to 5/min and 10/hour per user. 2FA secrets are encrypted in the database (key derived from SECRET_KEY; changing SECRET_KEY means users must set up 2FA again). |
| Password reset abuse | Single-use tokens that expire in 30 minutes, stored only as hashes. Same reply whether or not the email exists, 3 requests/hour per IP and per email. The link carries the token after `#` so it never reaches server logs. A reset ends all existing sessions and does not bypass 2FA. |
| Vulnerable dependencies | `pip-audit` and `npm audit` in CI on every push and weekly, plus Dependabot upgrades. |
| Session theft / CSRF | Server session in an HttpOnly, SameSite=Strict cookie (Secure in production), 8-hour lifetime, Origin header required on every POST. |
| Public database access | Row level security enabled with no policies, so the Supabase anon key reads nothing. Only the server's direct connection works. Never put the service-role key in the frontend. |
| Excel formula injection | Text cells starting with = + - @ are prefixed with an apostrophe in exports. |
| Clickjacking, sniffing | X-Frame-Options, nosniff, Referrer-Policy, strict CSP on the API, HSTS in production. |
| Secrets | `.env` is git-ignored; the app refuses to start in production without SECRET_KEY. |

Not included yet: a full script CSP for Next.js (needs nonces), backup codes for 2FA (admin reset instead), audit logging of sign-ins and data downloads.
