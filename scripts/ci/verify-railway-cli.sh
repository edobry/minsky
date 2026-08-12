#!/usr/bin/env bash
#
# verify-railway-cli.sh — assert the `railway` CLI is actually RUNNABLE before a
# deploy job uses it, and attribute a failed install to the install (mt#4075).
#
# Usage: verify-railway-cli.sh <credential-name-for-the-message>
#
# The argument is the secret name the CALLING workflow would otherwise be blamed
# for (e.g. RAILWAY_MCP_TOKEN), so the message can say that credential is not
# implicated. It is used in prose only — nothing reads the secret here.
#
# WHY THIS EXISTS. `npm install -g @railway/cli` reports on the PACKAGE, not on
# the binary: the package's postinstall downloads the executable from GitHub
# releases, and when that download fails it can leave a non-runnable stub behind
# while npm exits 0.
#
# Observed on `Deploy MCP` run 31645082761 (2026-08-12), which was deploying the
# mt#3212 merge:
#
#   npm error FetchError: request to https://github.com/railwayapp/cli/releases/
#     download/v4.44.0/railway-v4.44.0-x86_64-unknown-linux-gnu.tar.gz failed,
#     reason: socket hang up
#   npm install failed — retry 1
#   added 17 packages            <- npm exits 0 here
#   env: 'railway': Permission denied   <- every later invocation
#
# The caller already retried three times; the retry RAN and reported success, so
# a stronger retry would not have helped. Only probing the binary separates
# "installed" from "usable".
#
# WHY IT MATTERS BEYOND A CLEARER FAILURE. Without this, the run continues into
# the redeploy loop, where every attempt fails for want of an executable and the
# job's summary blames the deploy TOKEN — "re-mint it against the minsky-mcp
# project". That sends the reader to rotate a production credential that was
# never wrong. The probe makes the two causes distinguishable at the point where
# the evidence still exists.
#
# Env overrides (the tests use these; the default is what CI runs):
#   RAILWAY_BIN   railway executable   (default: railway)

set -uo pipefail

RAILWAY_BIN="${RAILWAY_BIN:-railway}"
CREDENTIAL_NAME="${1:-the deploy token}"

# `--version` rather than `command -v`: presence is exactly what is NOT in
# question here. In the observed failure the file WAS on PATH and could not be
# executed, so a presence check would have passed and the job would have
# proceeded into the redeploy loop — the outcome this script exists to prevent.
if "$RAILWAY_BIN" --version >/dev/null 2>&1; then
  echo "mt#4075: railway CLI verified runnable: $("$RAILWAY_BIN" --version 2>&1 | head -1)"
  exit 0
fi

echo "::error::mt#4075: the railway CLI installed but is not runnable ('${RAILWAY_BIN} --version' failed). This is an INSTALL failure — ${CREDENTIAL_NAME} is NOT implicated, so do not re-mint any credential for it. The @railway/cli package downloads its binary from GitHub releases on postinstall and can leave a non-executable stub when that download fails, which npm does not report even on a retry. Re-run this job; if it recurs, install via one of the other documented methods (https://docs.railway.com/guides/cli) instead of npm."
echo "Diagnostic — the failing invocation:"
"$RAILWAY_BIN" --version
exit 1
