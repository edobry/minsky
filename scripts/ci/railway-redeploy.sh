#!/usr/bin/env bash
#
# railway-redeploy.sh — redeploy every service on the shared image tag,
# retrying a transport/timeout failure on the SAME token scope before falling
# through to the alternate scope (mt#4959).
#
# WHY THIS EXISTS. On 2026-09-04 (run 33846875791, merge e4ae39ea9 of
# PR #3612 / mt#4943) the "Trigger Railway redeploy" step's per-service loop
# hit a failure it had no way to absorb: attempt 1 for minsky-ops
# authenticated, ran `railway link`, and then the redeploy call itself died
# with `Failed to fetch: error sending request for url
# (https://backboard.railway.com/graphql/v2) ... operation timed out` after
# ~30s. Attempt 2 then tried the OTHER token scope (project, via
# RAILWAY_TOKEN) — a credential-shape fallback, not a transport retry — and
# failed with `Invalid RAILWAY_TOKEN`, because that scope was never the right
# one for this secret. minsky-mcp had already redeployed at 07:03:12Z, so from
# then until a manual `forge_ci_run_rerun` at 07:06Z, minsky-mcp ran the new
# image while minsky-ops stayed on the previous merge's — a split deploy
# state with only the run's red status as the signal. The same window also
# produced a `Railway token refresh timed out after 30000ms` from
# `deployment_wait-for-latest`, so the platform's API was genuinely slow for
# about a minute; a bounded retry on the SAME scope would have covered it
# without ever reaching the wrong-scope fallback.
#
# CLASSIFICATION IS THE EXIT CODE, NEVER RAILWAY'S ERROR PROSE. redeploy_with()
# below exits 2 when `railway link` is rejected (the token could not
# authenticate or resolve the target) and 3 when link succeeded (or was not
# attempted, for a project token) but the redeploy call itself failed — the
# same two-code contract the calling workflow's mt#4288 comment describes and
# has classified failures on since PR #3138. Exit 3 is retried on the SAME
# scope, bounded; exit 2 is NEVER retried on that scope (a rejected credential
# does not become valid by waiting) and falls straight through to the other
# scope, which gets its own bounded retry on ITS OWN exit-3. Any exit code
# other than 2 or 3 means the helper failed somewhere neither instrumented
# point covers — it is reported as "unclassified" (preserving the three
# PR #3138 R1 buckets) and is NOT retried, the same as exit 2.
#
# The asymmetry that justifies keying on the exit code rather than trying to
# pattern-match "operation timed out" / "Failed to fetch" in the redeploy
# call's own output: a wrongly-skipped retry reproduces this incident (split
# state, a red run over what was really a ~1-minute API blip); a wrongly-taken
# retry on a genuinely permanent redeploy failure costs one bounded delay and
# the failure still lands loud at the end. Railway's error text is vendor
# prose that can change without notice — the exit code contract is ours.
#
# DOUBLE-TRIGGER HAZARD (recorded, not handled here). A redeploy request that
# timed out client-side may have been accepted server-side, so a retry can
# fire a second redeploy of the same image and tag. That is mt#4709's
# concurrent-redeploy class; harmless for correctness (the image and tag are
# identical either way), and out of scope for this script.
#
# INPUT (stdin): "<service-dir> <serviceId>" lines — exactly the
# REDEPLOY_SERVICES shape the calling workflow already builds. Blank lines are
# skipped; `read`'s default word-splitting strips the workflow's heredoc
# indentation the same way the original inline loop did.
#
# REQUIRED ENV: DEPLOY_TOKEN, DEPLOY_TOKEN_SOURCE (the secret NAME, carried
# into every message so a debugger is never sent to inspect the wrong
# credential), PROJECT_ID, ENVIRONMENT_ID.
#
# ENV OVERRIDES (naming mirrors docker-push-with-retry.sh; the tests use
# these, the defaults are what CI runs):
#   RAILWAY_BIN                    railway executable            (default: railway)
#   RAILWAY_REDEPLOY_ATTEMPTS      bounded same-scope attempts   (default: 3)
#   RAILWAY_REDEPLOY_RETRY_DELAY   seconds between retries       (default: 10)
#   RAILWAY_REDEPLOY_ATTEMPT_DIR   base dir for the per-attempt mktemp below;
#                                  TEST-ONLY — unset in production, where the
#                                  system default is always used. Lets a test
#                                  force the "helper failed outside the
#                                  instrumented exit points" path
#                                  deterministically, by pointing it at a
#                                  path that does not exist.
#
# Each attempt runs in its OWN empty working directory (PR #2776 R1
# BLOCKING): `railway link` persists project context to disk in the cwd, so
# without this a retry — or the project-scope fallback — would inherit an
# earlier attempt's link instead of genuinely re-authenticating.

set -uo pipefail

RAILWAY_BIN="${RAILWAY_BIN:-railway}"
RAILWAY_REDEPLOY_ATTEMPTS="${RAILWAY_REDEPLOY_ATTEMPTS:-3}"
RAILWAY_REDEPLOY_RETRY_DELAY="${RAILWAY_REDEPLOY_RETRY_DELAY:-10}"
RAILWAY_REDEPLOY_ATTEMPT_DIR="${RAILWAY_REDEPLOY_ATTEMPT_DIR:-}"

: "${DEPLOY_TOKEN:?railway-redeploy.sh: DEPLOY_TOKEN must be set}"
: "${DEPLOY_TOKEN_SOURCE:?railway-redeploy.sh: DEPLOY_TOKEN_SOURCE must be set}"
: "${PROJECT_ID:?railway-redeploy.sh: PROJECT_ID must be set}"
: "${ENVIRONMENT_ID:?railway-redeploy.sh: ENVIRONMENT_ID must be set}"

# mt#4288 — the two failures below get DIFFERENT exit codes, because they mean
# different things and the caller has to tell them apart. A failed link is the
# token being rejected or unable to resolve the target; a failed redeploy
# AFTER a successful (or skipped, for a project token) link is a token that
# authenticated fine and a call that failed for some other reason.
#
# $1 = the Railway service id to redeploy
# $2 = env var name to carry the token (RAILWAY_API_TOKEN or RAILWAY_TOKEN)
# $3 = "link" to establish project context first (account/workspace scope)
redeploy_with() {
  local service_id="$1"
  local attempt_dir
  if [ -n "${RAILWAY_REDEPLOY_ATTEMPT_DIR}" ]; then
    attempt_dir="$(mktemp -d "${RAILWAY_REDEPLOY_ATTEMPT_DIR}/attempt.XXXXXX" 2>/dev/null)"
  else
    attempt_dir="$(mktemp -d 2>/dev/null)"
  fi
  (
    cd "${attempt_dir}" || exit 1
    if [ "${3:-}" = "link" ]; then
      env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN "$2=${DEPLOY_TOKEN}" \
        "${RAILWAY_BIN}" link --project "${PROJECT_ID}" \
                     --environment "${ENVIRONMENT_ID}" \
                     --service "${service_id}" || exit 2
    fi
    env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN "$2=${DEPLOY_TOKEN}" \
      "${RAILWAY_BIN}" redeploy --from-source --service "${service_id}" -y || exit 3
  )
}

# Retries redeploy_with on the SAME scope up to RAILWAY_REDEPLOY_ATTEMPTS
# total, ONLY when it exits 3 (mt#4959 SC1). Exit 2 and any other code return
# on the first attempt with no retry — see the header for why.
#
# $1 = service id, $2 = token env var, $3 = "link" or "", $4 = svc label (for
# the retry message), $5 = scope label (for the retry message)
redeploy_with_retry() {
  local service_id="$1" env_var="$2" link_mode="${3:-}" svc="$4" scope_label="$5"
  local attempt=1
  local rc

  while :; do
    redeploy_with "${service_id}" "${env_var}" "${link_mode}"
    rc=$?
    if [ "${rc}" -eq 0 ]; then
      return 0
    fi
    if [ "${rc}" -ne 3 ]; then
      return "${rc}"
    fi
    if [ "${attempt}" -ge "${RAILWAY_REDEPLOY_ATTEMPTS}" ]; then
      return "${rc}"
    fi
    echo "Attempt ${attempt}/${RAILWAY_REDEPLOY_ATTEMPTS} for ${svc} (${scope_label}): redeploy call failed after a successful link — retrying in ${RAILWAY_REDEPLOY_RETRY_DELAY}s."
    sleep "${RAILWAY_REDEPLOY_RETRY_DELAY}"
    attempt=$((attempt + 1))
  done
}

# Trims the convention's leading-space concatenation and reports "(none)"
# rather than an empty string, so the split-state line below is readable even
# when one side is empty.
trim_or_none() {
  local trimmed="${1# }"
  if [ -n "${trimmed}" ]; then
    echo "${trimmed}"
  else
    echo "(none)"
  fi
}

# Diagnostic only, never fatal: prints the authenticated identity so a
# credential failure is self-describing (PR #2772 R1 NON-BLOCKING). Run under
# the account/workspace interpretation, since that is the only scope for
# which `whoami` is meaningful at all: a project token is not a user identity
# and legitimately reports nothing. Silence here is therefore evidence of a
# PROJECT token, not of a broken one. Email masked — this repo's CI logs are
# public.
echo "Railway auth identity (diagnostic; blank is expected for a project token):"
env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN "RAILWAY_API_TOKEN=${DEPLOY_TOKEN}" \
  "${RAILWAY_BIN}" whoami 2>&1 | sed -E 's/([A-Za-z0-9._%+-]+)@/***@/g' \
  || echo "note: whoami reported no identity — expected for a project token, see below."

# mt#3933 — every service on the shared tag is redeployed, and the loop does
# NOT short-circuit on the first failure: a run where minsky-mcp succeeds and
# minsky-ops fails must report BOTH, because the whole point of this task is
# that a service failing to redeploy is invisible from the outside. Failures
# are collected and the script exits non-zero at the end.
failed_services=""
redeployed_services=""      # mt#4959 SC2 — every service actually redeployed
# mt#4288 — per-service buckets, keyed on a LOCALLY OBSERVABLE fact: whether
# 'railway link' completed, which requires a valid credential that can
# resolve the project, environment and service. Deliberately not a
# pattern-match on Railway's error prose, which is vendor text and can change
# without notice.
#
# Leading-space concatenation matches the existing `failed_services`
# convention in this step; the messages below strip it with ${var# } so
# rendering does not depend on it (PR #3138 R1 NON-BLOCKING).
auth_ok_services=""          # link OK, redeploy failed (even after retries)
auth_failed_services=""      # link rejected
unclassified_services=""     # helper failed somewhere else entirely

while read -r svc service_id; do
  [ -n "${svc}" ] || continue
  echo "Attempt 1/2 for ${svc} (${service_id}): treating the ${DEPLOY_TOKEN_SOURCE} token as ACCOUNT/WORKSPACE scope (RAILWAY_API_TOKEN + railway link)."
  redeploy_with_retry "${service_id}" RAILWAY_API_TOKEN link "${svc}" "account/workspace scope"
  attempt1_rc=$?
  if [ "${attempt1_rc}" -eq 0 ]; then
    echo "Railway redeploy triggered successfully for ${svc} via the CLI (${DEPLOY_TOKEN_SOURCE}, account/workspace scope)."
    redeployed_services="${redeployed_services} ${svc}"
    continue
  fi
  # PR #3138 R1 — three buckets, not two. An exit code that is neither 2 nor 3
  # means the helper failed somewhere other than the two points we
  # instrumented, so NEITHER authentication nor the redeploy call can be
  # blamed. Folding that into "auth failed" would be this task's own defect
  # at smaller scale: a confident verdict the evidence does not support.
  case "${attempt1_rc}" in
    3)
      attempt1_class="authenticated"
      echo "Attempt 1 for ${svc}: the ${DEPLOY_TOKEN_SOURCE} token AUTHENTICATED and linked the project — the redeploy call itself is what failed."
      ;;
    2)
      attempt1_class="auth-failed"
      echo "Attempt 1 for ${svc}: 'railway link' was rejected — the token could not authenticate or resolve the target under account/workspace scope."
      ;;
    *)
      attempt1_class="unclassified"
      echo "Attempt 1 for ${svc}: the redeploy helper exited ${attempt1_rc}, which is neither the link-failed (2) nor the redeploy-failed (3) signal — cause not determined from this attempt."
      ;;
  esac
  echo "Attempt 1 failed for ${svc} — retrying the ${DEPLOY_TOKEN_SOURCE} token as PROJECT scope (RAILWAY_TOKEN)."
  redeploy_with_retry "${service_id}" RAILWAY_TOKEN "" "${svc}" "project scope"
  if [ $? -eq 0 ]; then
    echo "Railway redeploy triggered successfully for ${svc} via the CLI (${DEPLOY_TOKEN_SOURCE}, project scope)."
    redeployed_services="${redeployed_services} ${svc}"
    continue
  fi
  echo "::error::railway redeploy failed under BOTH token scopes for ${svc} (${service_id})."
  failed_services="${failed_services} ${svc}"
  # PR #3138 R1 — bucket PER SERVICE. A run where one service authenticated
  # and another was rejected must not report one verdict for both; that is
  # the same over-claiming one level up.
  case "${attempt1_class}" in
    authenticated) auth_ok_services="${auth_ok_services} ${svc}" ;;
    auth-failed) auth_failed_services="${auth_failed_services} ${svc}" ;;
    *) unclassified_services="${unclassified_services} ${svc}" ;;
  esac
done

if [ -n "${failed_services}" ]; then
  # mt#4075: this branch may only be reached once the CLI is known to run —
  # the caller's probe before invoking this script guarantees that. Do not
  # weaken that probe without rewording this, or a broken install lands here
  # again and reads as a credential problem.
  #
  # mt#4288: "CLI runs + both attempts failed" does NOT entail a bad
  # credential, and this branch asserted that it did. On 2026-08-19 the token
  # logged in, linked the project, and only the redeploy call failed — and
  # the message still told the operator to re-mint it, at 01:29, as a
  # severity-incident page. Report only what was observed.
  # PR #3138 R1: ONE VERDICT PER GROUP. A run can mix causes — one service
  # authenticated and failed to redeploy while another was rejected outright
  # — and a single sentence covering all of ${failed_services} is wrong for
  # at least one of them.
  echo "::error::railway redeploy failed for:${failed_services}."
  if [ -n "${auth_ok_services}" ]; then
    echo "::error::  NOT a credential failure for: ${auth_ok_services# } — the ${DEPLOY_TOKEN_SOURCE} token authenticated and completed 'railway link' for these, so the secret is valid and resolves the target; only the redeploy call failed. Check Railway's status page and the per-attempt output above before re-minting anything."
  fi
  if [ -n "${auth_failed_services}" ]; then
    echo "::error::  CREDENTIAL failure for: ${auth_failed_services# } — 'railway link' was rejected, so the ${DEPLOY_TOKEN_SOURCE} token could not authenticate or resolve these services. Re-mint it against the minsky-mcp project and store it as RAILWAY_MCP_TOKEN."
  fi
  if [ -n "${unclassified_services}" ]; then
    echo "::error::  CAUSE NOT DETERMINED for: ${unclassified_services# } — the redeploy helper exited outside the instrumented failure points, so this run does not say whether the credential or the redeploy call was at fault. Read the per-attempt output above rather than acting on a guess."
  fi
  # mt#4959 SC2 — one explicit line naming the split state, so the reader
  # does not have to reconstruct it from the per-attempt output above.
  echo "::error::redeploy split state — redeployed: $(trim_or_none "${redeployed_services}"); NOT redeployed: $(trim_or_none "${failed_services}")"
  exit 1
fi

echo "redeployed: $(trim_or_none "${redeployed_services}")"
