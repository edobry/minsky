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
# task is about. `railway` (and `mktemp`, for the harness-failure case) are
# stubbed on PATH so each scenario chooses which call fails; nothing here
# touches Railway.
#
# Scenarios 4 and 5 exist because PR #3138 R1 found the first version of the fix
# reintroduced the same defect at smaller scale: an unexpected exit code was
# folded into "auth failed", and a mixed-cause run reported one verdict for
# every failed service.
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
python3 - "${WORKFLOW}" "${WORK}/under-test.sh" <<'PY'
import sys, textwrap
src, dst = sys.argv[1], sys.argv[2]
lines = open(src).read().splitlines()

start = next(i for i, l in enumerate(lines) if "redeploy_with() {" in l)
# The classification block ends at the `fi` CLOSING the failed_services test —
# matched by indentation, because the block nests other if/else blocks whose
# `fi` comes first. Taking an inner one truncates the script mid-conditional,
# which is exactly what this comment exists to stop someone re-introducing.
tail = next(i for i, l in enumerate(lines) if 'if [ -n "${failed_services}" ]; then' in l)
indent = len(lines[tail]) - len(lines[tail].lstrip())
end = next(
    i
    for i in range(tail + 1, len(lines))
    if lines[i].strip() == "fi" and (len(lines[i]) - len(lines[i].lstrip())) == indent
)

block = textwrap.dedent("\n".join(lines[start : end + 1]))
for marker, why in [
    ("|| exit 2", "the link-failed exit code"),
    ("|| exit 3", "the redeploy-failed exit code"),
    ("auth_ok_services", "the authenticated-services bucket"),
    ("auth_failed_services", "the credential-failure bucket"),
    ("unclassified_services", "the cause-not-determined bucket"),
]:
    if marker not in block:
        sys.exit(f"EXTRACT-FAIL: {why} ({marker}) is not in the workflow")
open(dst, "w").write(block + "\n")
PY
if [ $? -ne 0 ]; then
  echo "FAIL: could not extract the redeploy logic from ${WORKFLOW}"
  exit 1
fi

# ── Stubs ────────────────────────────────────────────────────────────────────
# LINK_FAIL_FOR / REDEPLOY_FAIL_FOR are space-separated service-id lists, so a
# single run can mix causes across services (the R1 mixed-service case).
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/railway" <<'STUB'
#!/usr/bin/env bash
in_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
# Both subcommands carry the target as `--service <id>`.
target=""
prev=""
for a in "$@"; do
  [ "${prev}" = "--service" ] && target="${a}"
  prev="${a}"
done
case "$1" in
  link)
    if in_list "${target}" "${LINK_FAIL_FOR:-}"; then
      echo "Invalid RAILWAY_TOKEN. Please check that it is valid." >&2
      exit 1
    fi
    echo "Project minsky-mcp linked successfully!"
    exit 0
    ;;
  redeploy)
    if in_list "${target}" "${REDEPLOY_FAIL_FOR:-}"; then
      echo "Problem processing request" >&2
      exit 1
    fi
    echo "redeploy triggered"
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB
chmod +x "${WORK}/bin/railway"

# Breaks the helper OUTSIDE both instrumented points: mktemp hands back a path
# that does not exist, so the `cd` fails and the subshell exits 1 — neither 2
# nor 3. This is the real path to an unclassified code, not a synthetic one.
cat > "${WORK}/bin/mktemp" <<'STUB'
#!/usr/bin/env bash
if [ "${BREAK_HARNESS:-}" = "1" ]; then
  echo "/nonexistent/mt4288-harness-break"
  exit 0
fi
exec /usr/bin/mktemp "$@"
STUB
chmod +x "${WORK}/bin/mktemp"

run_scenario() { # $1=LINK_FAIL_FOR $2=REDEPLOY_FAIL_FOR $3=services $4=BREAK_HARNESS
  (
    export PATH="${WORK}/bin:${PATH}"
    export LINK_FAIL_FOR="$1" REDEPLOY_FAIL_FOR="$2"
    export REDEPLOY_SERVICES="$3" BREAK_HARNESS="${4:-0}"
    export DEPLOY_TOKEN="stub-token" DEPLOY_TOKEN_SOURCE="RAILWAY_MCP_TOKEN"
    export PROJECT_ID="proj" ENVIRONMENT_ID="env"
    bash "${WORK}/under-test.sh" 2>&1
  )
}

ONE="minsky-mcp svc-1"
TWO="minsky-mcp svc-1
minsky-ops svc-2"

FAILURES=0
assert_contains() {
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
OUT="$(run_scenario "" "svc-1" "${ONE}")"
assert_contains "${OUT}" "AUTHENTICATED and linked the project" "attempt-1 outcome names successful auth"
assert_contains "${OUT}" "NOT a credential failure for: minsky-mcp" "verdict clears the token, and names the service"
assert_not_contains "${OUT}" "Re-mint it against" "no re-mint instruction"

echo "Scenario 2 — link fails (a genuine credential failure):"
# BOTH attempts must fail to reach the classification block at all: attempt 2 is
# project-scope and skips `link`, so it only fails if `redeploy` fails too. A
# scenario that fails link alone exercises the SUCCESS path via attempt 2, which
# is correct behaviour and not what this asserts.
OUT="$(run_scenario "svc-1" "svc-1" "${ONE}")"
assert_contains "${OUT}" "'railway link' was rejected" "attempt-1 outcome names the auth failure"
assert_contains "${OUT}" "CREDENTIAL failure for: minsky-mcp" "verdict blames the credential"
assert_contains "${OUT}" "Re-mint it against" "re-mint instruction IS given"

echo "Scenario 3 — everything succeeds:"
OUT="$(run_scenario "" "" "${ONE}")"
assert_contains "${OUT}" "Railway redeploy triggered successfully" "success is reported"
assert_not_contains "${OUT}" "::error::" "no error emitted on the happy path"

echo "Scenario 4 — MIXED: one service authenticated, one rejected (R1 blocking #2):"
OUT="$(run_scenario "svc-2" "svc-1 svc-2" "${TWO}")"
assert_contains "${OUT}" "NOT a credential failure for: minsky-mcp" "the authenticated service is cleared by name"
assert_contains "${OUT}" "CREDENTIAL failure for: minsky-ops" "the rejected service is blamed by name"
assert_not_contains "${OUT}" "NOT a credential failure for: minsky-mcp minsky-ops" "one verdict does not cover both"

echo "Scenario 5 — helper fails outside both instrumented points (R1 blocking #1):"
OUT="$(run_scenario "" "" "${ONE}" 1)"
assert_contains "${OUT}" "CAUSE NOT DETERMINED for: minsky-mcp" "unexpected exit is its own bucket"
assert_not_contains "${OUT}" "CREDENTIAL failure for:" "an unknown cause is not reported as a credential failure"
assert_not_contains "${OUT}" "Re-mint it against" "no re-mint instruction on an undetermined cause"

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "PASS: all scenarios classified correctly."
  exit 0
fi
echo "FAIL: ${FAILURES} assertion(s) failed."
exit 1
