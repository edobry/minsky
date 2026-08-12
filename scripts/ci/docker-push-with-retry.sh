#!/usr/bin/env bash
#
# docker-push-with-retry.sh — push image refs to a registry, retrying ONLY on
# transient registry failures (mt#3979).
#
# Usage: docker-push-with-retry.sh <image-ref> [<image-ref> ...]
#
# Refs are pushed in the order given and the script stops at the first ref it
# cannot push, so callers pass the immutable `sha-<short>` tag BEFORE the
# mutable `:latest` pointer — a failure then cannot leave `:latest` promoted
# while the run goes red.
#
# WHY THIS EXISTS. On 2026-08-11 a `Deploy MCP` run failed at `Tag and push
# image` with a bare `unknown blob` after most layers had already pushed.
# That is a known transient GHCR condition: docker/build-push-action#271 and
# #38 report exactly this on GHCR push and were closed as `kind/upstream` with
# no retry implemented, and moby#24772 shows the message arrives AFTER docker's
# own internal per-blob retries are exhausted — which is why re-running the
# whole `docker push` (a fresh upload session) recovers it, and why the
# documented community remedy is "re-run the job". Nothing retried it here, so
# production kept serving the previous image until a human re-ran the job.
# This automates that remedy at a narrower granularity: the push command, not
# the whole job.
#
# CLASSIFICATION IS AN ALLOWLIST. Only the patterns in TRANSIENT_PATTERN are
# retried. Everything else — `unauthorized`, `denied`, `authentication
# required`, `manifest invalid`, `name unknown`, and anything unrecognised —
# fails on the FIRST attempt without consuming retries, so a real failure stays
# loud. `toomanyrequests` (429) is deliberately NOT in the set: a rate limit is
# a signal an operator should see, not a flake to absorb.
#
# Env overrides (the tests use these; the defaults are what CI runs):
#   DOCKER_BIN                     docker executable            (default: docker)
#   DOCKER_PUSH_ATTEMPTS           bounded attempt count        (default: 3)
#   DOCKER_PUSH_RETRY_BASE_DELAY   seconds before first retry   (default: 5,
#                                  doubling on each subsequent attempt)

set -uo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"
DOCKER_PUSH_ATTEMPTS="${DOCKER_PUSH_ATTEMPTS:-3}"
DOCKER_PUSH_RETRY_BASE_DELAY="${DOCKER_PUSH_RETRY_BASE_DELAY:-5}"

# Retried. Extend this list only with conditions that are genuinely
# registry-side and genuinely transient — every addition widens what a red
# deploy is allowed to absorb silently.
#
# `EOF` is matched as a STANDALONE WORD, not as a substring: the registry emits
# it bare (`error: EOF`) as well as inside `unexpected EOF`, and mt#3979's SC2
# names the bare form. Anchoring on word boundaries keeps it from matching
# inside an unrelated identifier. Written as explicit character classes rather
# than `\b` so the pattern behaves identically under BSD and GNU grep.
TRANSIENT_PATTERN='unknown blob|blob upload unknown|BLOB_UPLOAD_UNKNOWN|(^|[^[:alnum:]_])EOF([^[:alnum:]_]|$)|connection reset by peer|i/o timeout|TLS handshake timeout|cannot reuse body, request must be retried|received unexpected HTTP status: 5[0-9][0-9]|error parsing HTTP 5[0-9][0-9] response body'

if [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") <image-ref> [<image-ref> ...]" >&2
  exit 2
fi

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

push_with_retry() {
  local ref="$1"
  local attempt=1
  local rc
  local delay

  while : ; do
    # `tee` keeps the push output streaming into the job log (so a human reading
    # a red run still sees the registry's own message) while also capturing it
    # for classification. PIPESTATUS[0] is docker's exit code, not tee's.
    "$DOCKER_BIN" push "$ref" 2>&1 | tee "$OUTPUT_FILE"
    rc="${PIPESTATUS[0]}"
    # PIPESTATUS[0] is docker's exit code, not tee's, and it is carried all the
    # way out to the caller's exit status below — a registry that exits 7 must
    # not be reported to CI as a generic 1.

    if [ "$rc" -eq 0 ]; then
      # Emitted on EVERY success, including a first-attempt one: the flake rate
      # needs a denominator, so "succeeded on attempt 1/3" is as load-bearing as
      # "succeeded on attempt 2/3".
      echo "mt#3979: push of ${ref} succeeded on attempt ${attempt}/${DOCKER_PUSH_ATTEMPTS}"
      return 0
    fi

    if ! grep -Eqi "$TRANSIENT_PATTERN" "$OUTPUT_FILE"; then
      echo "::error::mt#3979: push of ${ref} failed on attempt ${attempt}/${DOCKER_PUSH_ATTEMPTS} with a NON-transient error (exit ${rc}) — not retrying. See the push output above."
      return "$rc"
    fi

    if [ "$attempt" -ge "$DOCKER_PUSH_ATTEMPTS" ]; then
      echo "::error::mt#3979: push of ${ref} failed on all ${DOCKER_PUSH_ATTEMPTS} attempts (exit ${rc}); the last failure matched the transient set but retrying did not clear it — failing the deploy."
      return "$rc"
    fi

    delay=$(( DOCKER_PUSH_RETRY_BASE_DELAY * (2 ** (attempt - 1)) ))
    echo "mt#3979: push of ${ref} hit a transient registry error on attempt ${attempt}/${DOCKER_PUSH_ATTEMPTS} — retrying in ${delay}s"
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
}

for image_ref in "$@"; do
  push_with_retry "$image_ref"
  push_rc=$?
  if [ "$push_rc" -ne 0 ]; then
    # Propagate docker's OWN exit code rather than collapsing every failure to
    # 1: the code is diagnostic, and the step is the last thing standing
    # between a failed push and a silently-not-deployed service.
    exit "$push_rc"
  fi
done
