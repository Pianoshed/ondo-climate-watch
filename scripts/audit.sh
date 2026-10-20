#!/usr/bin/env bash
# Dependency vulnerability audit for both halves. Fails if a known vulnerability is found.
set -e
(cd backend && pip-audit -r requirements.txt)
(cd frontend && npm audit --omit=dev --audit-level=high)
