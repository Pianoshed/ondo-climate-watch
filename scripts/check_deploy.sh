#!/usr/bin/env bash
# Usage: scripts/check_deploy.sh https://your-frontend.onrender.com
# Checks that the live frontend really talks to the live backend (not localhost) and that the settings agree.
set -u
F="${1:?Usage: check_deploy.sh https://your-frontend.onrender.com}"; F="${F%/}"
FAILED=0; ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; FAILED=1; }
code() { curl -s -o /dev/null -m 60 -w '%{http_code}' "$@"; }
[ "$(code "$F/login")" = 200 ] && ok "login page loads" || bad "login page did not load"
H=$(curl -s -m 60 "$F/api/health")
echo "$H" | grep -Eq '"ok": *true' && ok "frontend reaches the backend through /api" \
  || bad "$F/api/health returned: ${H:0:120}. API_URL is wrong, or was not set before the frontend build"
c=$(code -X POST -H "Origin: $F" -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.org","password":"wrong-password-1"}' "$F/api/auth/login")
case $c in 401) ok "backend accepts this frontend address (ALLOWED_ORIGIN matches)";;
  403) bad "403: ALLOWED_ORIGIN on the backend does not match $F";; *) bad "login test returned $c";; esac
curl -sI -m 60 "$F/api/health" | grep -qi strict-transport-security && ok "HSTS header present" \
  || bad "HSTS missing: is APP_ENV=production set on the backend?"
echo "The backend sees your IP as: $(echo "$H" | sed -n 's/.*"ip": *"\([^"]*\)".*/\1/p')"
echo "Compare with https://ifconfig.me. If it shows a Render address instead, raise TRUSTED_PROXY_HOPS by 1; if it is wrong the other way, lower it."
exit $FAILED
