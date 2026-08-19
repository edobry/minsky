#!/usr/bin/env bash
# Verify the Deploy MCP redeploy step's failure CLASSIFICATION (mt#4288).
#
# The defect this guards: the step used to conclude "this is a CREDENTIAL
# failure" whenever both token-scope attempts returned non-zero, without
# inspecting why either failed. On 2026-08-19 the token authenticated, linked
# the project, and only the `railway redeploy` call failed — and the step still
# told the operator to re-mint the secret, as a severity-incident page.
#
# The logic under test is EXTRACTED FROM THE SHIPPED WORKFLOW rather than
# reimplemented here. A reimplementation would be a copy that can pass while the
# workflow is broken — the exact "probe observes the wrong system" trap this
# task is about. `railway` is stubbed on PATH so each scenario can choose which
# call fails; nothing here touches Railway.
#
# Usage: bash scripts/verify-deploy-redeploy-classification.sh
# Exit 0 = all scenarios classified correctly; non-zero = a scenario misclassified.

set -uo pipefail

WORKFLOW=".github/workflows/deploy-minsky-mcp.yml"
if [ ! -f "${WORKFLOW}" ]; then
  echo "SKIP: ${WORKFLOW} not found (run from the repo root)."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ── Extract the unit under test straight out of the YAML ─────────────────────
# From the `redeploy_with() {` definition through the classification block's
# closing `fi`. Dedented so it can run as a standalone script.
python3 - "${WORKFLOW}" "${WORK}/under-test.sh" <<'PY'
import sys, textwrap
src, dst = sys.argv[1], sys.argv[2]
lines = open(src).read().splitlines()

start = next(i for i, l in enumerate(lines) if "redeploy_with() {" in l)
# The classification block ends at the `fi` CLOSING the failed_services test —
# matched by indentation, because the block nests another if/else whose `fi`
# comes first. Taking that inner one truncates the script mid-conditional, which
# is exactly what this comment exists to stop someone re-introducing.
tail = next(i for i, l in enumerate(lines) if 'if [ -n "${failed_services}" ]; then' in l)
indent = len(lines[tail]) - len(lines[tail].lstrip())
end = next(
    i
    for i in range(tail + 1, len(lines))
    if lines[i].strip() == "fi" and (len(lines[i]) - len(lines[i].lstrip())) == indent
)

block = textwrap.dedent("\n".join(lines[start : end + 1]))
if "|| exit 2" not in block or "|| exit 3" not in block:
    sys.exit("EXTRACT-FAIL: the distinct link/redeploy exit codes are not in the workflow")
if "authenticated_services" not in block:
    sys.exit("EXTRACT-FAIL: the workflow records no authenticated-services evidence")
open(dst, "w").write(block + "\n")
PY
if [ $? -ne 0 ]; then
  echo "FAIL: could not extract the redeploy logic from ${WORKFLOW}"
  exit 1
fi

# ── Stub `railway` ───────────────────────────────────────────────────────────
# STUB_MODE picks which call fails, so each scenario drives a different branch.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/railway" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  link)
    if [ "${STUB_MODE}" = "link-fails" ]; then
      echo "Invalid RAILWAY_TOKEN. Please check that it is valid." >&2
      exit 1
    fi
    echo "Project minsky-mcp linked successfully!"
    exit 0
    ;;
  redeploy)
    if [ "${STUB_MODE}" = "all-ok" ]; then
      echo "redeploy triggered"
      exit 0
    fi
    echo "Problem processing request" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "${WORK}/bin/railway"

run_scenario() {
  # $1 = STUB_MODE
  (
    export PATH="${WORK}/bin:${PATH}"
    export STUB_MODE="$1"
    export DEPLOY_TOKEN="stub-token"
    export DEPLOY_TOKEN_SOURCE="RAILWAY_MCP_TOKEN"
    export PROJECT_ID="proj" ENVIRONMENT_ID="env"
    export REDEPLOY_SERVICES="minsky-mcp svc-id-1"
    bash "${WORK}/under-test.sh" 2>&1
  )
}

FAILURES=0
assert_contains() { # $1=haystack $2=needle $3=label
  case "$1" in
    *"$2"*) echo "  PASS: $3" ;;
    *) echo "  FAIL: $3"; echo "        expected to find: $2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}
assert_not_contains() {
  case "$1" in
    *"$2"*) echo "  FAIL: $3"; echo "        did not expect: $2"; FAILURES=$((FAILURES + 1)) ;;
    *) echo "  PASS: $3" ;;
  esac
}

echo "Scenario 1 — link succeeds, redeploy fails (the 2026-08-19 shape):"
OUT="$(run_scenario "redeploy-fails")"
assert_contains "${OUT}" "AUTHENTICATED and linked the project" "attempt-1 outcome names successful auth"
assert_contains "${OUT}" "This is NOT a credential failure" "final verdict does not blame the token"
assert_not_contains "${OUT}" "re-mint the token against the minsky-mcp project" "no re-mint instruction"

echo "Scenario 2 — link fails (a genuine credential failure):"
OUT="$(run_scenario "link-fails")"
assert_contains "${OUT}" "could not authenticate or resolve the target" "attempt-1 outcome names the auth failure"
assert_contains "${OUT}" "authentication was never demonstrated" "final verdict says auth was never shown"
assert_contains "${OUT}" "re-mint the token" "re-mint instruction IS given"

echo "Scenario 3 — everything succeeds:"
OUT="$(run_scenario "all-ok")"
assert_contains "${OUT}" "Railway redeploy triggered successfully" "success is reported"
assert_not_contains "${OUT}" "::error::" "no error emitted on the happy path"

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "PASS: all scenarios classified correctly."
  exit 0
fi
echo "FAIL: ${FAILURES} assertion(s) failed."
exit 1
