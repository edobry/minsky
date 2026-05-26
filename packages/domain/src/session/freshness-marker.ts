// Branch-freshness marker (mt#1522)
//
// Closes the residual Class-2 TOCTOU race left open by mt#1483: between the
// freshness hook's allow decision and `session_commit`'s actual push,
// `origin/main` can advance. The agent's branch push succeeds (it's a
// fast-forward of `origin/<branch>`, not `origin/main`), but the new commit
// is now built on a stale base — same shape of bug the hook is designed to
// prevent, just at a smaller (~seconds) time scale.
//
// Mechanism: the hook captures `origin/main`'s SHA at allow time and writes
// a marker to `.git/.minsky-freshness-sha`. session_commit reads the marker,
// re-fetches origin, resolves `origin/main`, and compares. If the SHA
// advanced, abort with a clear error directing the agent to retry (which
// re-runs the hook, which either re-allows at the new SHA or blocks).
//
// §7b TOCTOU enumeration on the CAS check itself:
//   - Read atomicity: marker is a single read; current-SHA is a single
//     `git rev-parse` after fetch. PASS.
//   - Decision-action gap: between CAS pass and push, origin/main can
//     advance again. ACCEPT — irreducible (no remote locking primitive)
//     AND FF-conflict-preserving (push to origin/<branch> doesn't conflict
//     with origin/main advances). The push-duration window is ms-class,
//     orders of magnitude smaller than the seconds-class gap we're closing.
//   - Stale-read at read time: forced fresh `git fetch` before SHA resolve.
//     PASS.
//
// Override path: when MINSKY_SKIP_FRESHNESS=1, the hook exits before
// writing a marker. session_commit's CAS check reads no marker and bypasses.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// PR #963 R2 BLOCKING #2 fix: this module is imported by the
// `.claude/hooks/check-branch-fresh.ts` hook to access writeFreshnessMarker.
// Importing app-domain modules (errors/, schemas/, etc.) from here would
// drag transitive dependencies into the hook's dependency surface, slowing
// startup and introducing fragility. So `FreshnessCasError` lives in the
// session-commands callsite (where the throw happens), not here. This module
// imports only `node:fs` + `node:path`.

/**
 * Filename of the freshness marker, scoped to `.git/`. Per-repo, hidden
 * inside the git dir so it doesn't pollute the working tree. Transient —
 * cleaned up after every session_commit attempt.
 *
 * Must stay in sync with the literal in `.claude/hooks/check-branch-fresh.ts`.
 */
export const FRESHNESS_MARKER_FILENAME = ".minsky-freshness-sha";

export interface FreshnessMarkerPayload {
  /** The detected default-branch ref (e.g., "origin/main"). */
  mainRef: string;
  /** The SHA of mainRef captured by the hook at allow time. */
  sha: string;
  /** The tool name the hook fired against (e.g., "mcp__minsky__session_commit"). */
  toolName: string;
  /** ISO timestamp of capture. */
  ts: string;
}

/**
 * Path to the marker file given a session/repo workdir. Assumes the workdir
 * is a regular git repository whose `.git/` directory already exists. For
 * bare repos, worktrees, or unusual layouts, the right path may differ —
 * such cases are out of scope here (the hook only fires inside a session
 * workspace, which is always a regular checkout). PR #963 R1 NON-BLOCKING
 * #7 noted this assumption.
 */
export function markerPath(workdir: string): string {
  return join(workdir, ".git", FRESHNESS_MARKER_FILENAME);
}

/**
 * Write a freshness marker. Best-effort: returns the failure reason on I/O
 * error so the caller can warn but not abort. (A failed marker write means
 * the CAS check won't fire on the next push — same outcome as no hook ran,
 * which is the pre-mt#1522 baseline.)
 *
 * Does NOT create `.git/` if missing — assumes the workdir is a git repo
 * (which it always is in a session workspace). Failure to find `.git/`
 * shows up as an `ENOENT` whose reason is returned in the result.
 */
export function writeFreshnessMarker(
  workdir: string,
  payload: FreshnessMarkerPayload
): { ok: boolean; reason?: string } {
  try {
    writeFileSync(markerPath(workdir), JSON.stringify(payload), "utf8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Strict regex for the `mainRef` field. Refs are restricted to alphanumeric,
 * dot, underscore, slash, and dash — AND the first character must NOT be
 * a dash. Critically rejects:
 *   - Shell metacharacters (quotes, backticks, semicolons, dollar signs,
 *     parentheses) so the value is safe to interpolate into a shell command.
 *     PR #963 R1 BLOCKING #1 fix.
 *   - Refs that start with `-` (e.g., `--help`), which `git rev-parse` would
 *     parse as command-line OPTIONS rather than ref names. PR #963 R2
 *     BLOCKING #1 fix — addresses option-injection, distinct from shell
 *     metacharacter injection.
 *
 * Examples accepted: `origin/main`, `origin/master`, `origin/feature/branch`,
 * `refs/remotes/origin/HEAD`, `_internal/x`.
 * Examples rejected: `origin/main"; rm -rf /`, `origin/$(touch pwn)`,
 * `--help`, `-h`, `--exec=...`, anything with backticks or shell control
 * chars.
 */
const SAFE_REF_RE = /^[A-Za-z0-9_./][A-Za-z0-9._/-]*$/;

/** Strict regex for the `sha` field — must be exactly 40 lowercase hex chars. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Read and parse the freshness marker. Returns null when:
 *   - File does not exist (no hook fired, or override active).
 *   - File exists but cannot be read (permissions, etc.).
 *   - File contents are not valid JSON.
 *   - File parses but is missing required fields.
 *   - File parses but `mainRef` contains shell metacharacters.
 *   - File parses but `sha` is not 40 lowercase hex chars.
 *
 * Each null return is a bypass signal — the CAS check should proceed-without-check
 * rather than fail closed, since a corrupted/malicious/missing marker means we
 * have no captured SHA to compare against. Strict shape validation closes the
 * command-injection vector at the CAS site (PR #963 R1).
 */
export function readFreshnessMarker(workdir: string): FreshnessMarkerPayload | null {
  const p = markerPath(workdir);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, { encoding: "utf8" }) as string;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = parsed as Record<string, unknown>;
  if (
    typeof fields["mainRef"] !== "string" ||
    typeof fields["sha"] !== "string" ||
    typeof fields["toolName"] !== "string" ||
    typeof fields["ts"] !== "string"
  ) {
    return null;
  }
  if (!SAFE_REF_RE.test(fields["mainRef"])) return null;
  if (!SHA_RE.test(fields["sha"])) return null;
  return {
    mainRef: fields["mainRef"],
    sha: fields["sha"],
    toolName: fields["toolName"],
    ts: fields["ts"],
  };
}

/**
 * Best-effort cleanup of the marker file. Silent on missing-file or
 * unlink-failure — transient state that doesn't survive is acceptable.
 *
 * Intended to run unconditionally on every session_commit attempt
 * (success or failure) so that the next attempt starts with a fresh slate.
 */
export function cleanupFreshnessMarker(workdir: string): void {
  const p = markerPath(workdir);
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // best-effort cleanup
  }
}

/** Injectable deps for `checkFreshnessCas` — tests pass fakes here. */
export interface FreshnessCasDeps {
  /** Refresh remote-tracking refs from origin. Returns true on success. */
  fetchOrigin: (workdir: string) => Promise<boolean>;
  /** Resolve a ref to its 40-char SHA. Returns null if the ref does not exist. */
  resolveRefSha: (workdir: string, ref: string) => Promise<string | null>;
  /** Read the current marker if any (defaults to `readFreshnessMarker`). */
  readMarker?: (workdir: string) => FreshnessMarkerPayload | null;
}

export type FreshnessCasBypass = "no-marker" | "fetch-failed" | "ref-unresolvable";

export interface FreshnessCasResult {
  /** True iff the push should proceed (no marker, bypass, or SHAs match). */
  ok: boolean;
  /** When ok=false: human-readable explanation for the agent. */
  reason?: string;
  /** When a marker was found: the captured SHA (for logging). */
  capturedSha?: string;
  /** When the check ran fully: the SHA seen at push time. */
  currentSha?: string;
  /** When the check was bypassed: the reason class. */
  bypass?: FreshnessCasBypass;
}

/**
 * Verify that origin/<mainRef> hasn't advanced since the freshness hook
 * captured it. Returns ok=true to proceed, ok=false with a reason to abort.
 *
 * Bypass conditions (all return ok=true):
 *   - no-marker:        no hook fired (or override active).
 *   - fetch-failed:     network/auth error refreshing remote refs; we'd be
 *                       comparing against possibly-stale local copies, which
 *                       is no worse than the pre-hook baseline.
 *   - ref-unresolvable: the captured ref doesn't exist locally (deleted
 *                       branch, repo restructure); the comparison is moot.
 */
export async function checkFreshnessCas(
  workdir: string,
  deps: FreshnessCasDeps
): Promise<FreshnessCasResult> {
  const readMarker = deps.readMarker ?? readFreshnessMarker;
  const marker = readMarker(workdir);
  if (!marker) {
    return { ok: true, bypass: "no-marker" };
  }

  const fetched = await deps.fetchOrigin(workdir);
  if (!fetched) {
    return { ok: true, bypass: "fetch-failed", capturedSha: marker.sha };
  }

  const currentSha = await deps.resolveRefSha(workdir, marker.mainRef);
  if (currentSha === null) {
    return { ok: true, bypass: "ref-unresolvable", capturedSha: marker.sha };
  }

  if (currentSha === marker.sha) {
    return { ok: true, capturedSha: marker.sha, currentSha };
  }

  return {
    ok: false,
    reason:
      `${marker.mainRef} advanced from ${marker.sha} to ${currentSha} between the ` +
      `freshness hook's allow decision and this push. Re-run session_commit so the ` +
      `hook re-validates against the new state (it will either re-allow at the new ` +
      `SHA or block with a list of new commits to review).`,
    capturedSha: marker.sha,
    currentSha,
  };
}
