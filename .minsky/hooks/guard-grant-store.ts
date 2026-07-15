// Shared, dependency-free store for ADR-028 Phase-7-adjunct guard-override
// grants (mt#2658).
//
// Generalizes `.minsky/hooks/merge-grant-store.ts`'s TTL-bound, auditable,
// file-based grant pattern (mt#2651) from ONE guard/scope pair (subagent
// merge capability, scoped to `taskId`) to ANY `(guardName, scope)` pair —
// e.g. `{ guardName: "duplicate-child-matcher", scope: "mt#2581" }`.
//
// ## Motivation
//
// Every guard override today — including the ADR-028 D3 unified
// `MINSKY_HOOK_OVERRIDE` — is an env var read by the hook subprocess, which
// inherits the HARNESS env captured at launch. An agent mid-session
// structurally cannot self-serve any such override for MCP-tool-matched
// guards: setting the var via a `Bash` call does not propagate to the
// sibling harness subprocess the guard hook actually runs in. Hit twice on
// 2026-07-07 — `MINSKY_FORCE_DUPLICATE_OK` unreachable when the
// duplicate-child matcher false-positived on generic shared tokens during
// the ADR-028 child filing (workaround was retitling — the exact anti-
// pattern `feedback_use_sanctioned_cli_override_...` warns against), and
// mt#2637's spec independently documenting the same unreachability for
// `MINSKY_SKIP_SPEC_READ_CHECK`. This store is the reachable alternative:
// writable mid-session (a script call), auditable (`reason` is mandatory —
// see `validateGrant` below), and TTL-bound (expires automatically, no
// manual cleanup, no permanently loosened guard).
//
// ## Consumers
//
//   - `.minsky/hooks/dispatcher.ts`'s `checkOverride()` — consults this
//     store (in addition to `MINSKY_HOOK_OVERRIDE`) when the caller supplies
//     a `scope` qualifier.
//   - `.minsky/hooks/parallel-work-guard.ts`'s duplicate-child matcher —
//     consults this store directly (it is NOT dispatcher-migrated; it
//     remains a standalone `PreToolUse` hook) scoped to the parent task id.
//   - `scripts/grant-guard-override.ts` — the mid-session issuance surface
//     (writes the store; `--reason` is a required flag).
//
// Self-containment (per `.claude/hooks/SPEC.md` + ADR-028 "Context —
// Adjacent-but-distinct prior art"): this module imports ONLY `node:fs`,
// `node:os`, `node:path` — no `packages/domain` import, so the guard keeps
// working even when the main codebase has type errors. State-dir resolution
// mirrors `merge-grant-store.ts`'s `getStateDir()` precedent exactly:
// `MINSKY_STATE_DIR` override, else `XDG_STATE_HOME`/minsky, else
// `~/.local/state/minsky`.
//
// @see mt#2658 — this module's tracking task
// @see .minsky/hooks/merge-grant-store.ts — the narrower precedent this generalizes
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md §D8

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// State-dir + store-path resolution
// ---------------------------------------------------------------------------

const GUARD_GRANT_STORE_FILENAME = "guard-grants.json";

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
export function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/** Absolute path to the shared guard-grant store file. */
export function getGuardGrantStorePath(): string {
  return path.join(getStateDir(), GUARD_GRANT_STORE_FILENAME);
}

// ---------------------------------------------------------------------------
// Grant record shape
// ---------------------------------------------------------------------------

/**
 * A TTL-bound capability grant authorizing an override of `guardName`,
 * scoped to `scope` (mt#2658 — generalizes `MergeGrant`'s single
 * `taskId`-scoped shape to any guard/scope pair).
 */
export interface GuardGrant {
  /** The guard this grant authorizes overriding (e.g. "duplicate-child-matcher"). */
  guardName: string;
  /**
   * Scope qualifier the grant is bound to — e.g. a parent task id for the
   * duplicate-child matcher. Required: an unscoped grant would silently
   * authorize every FUTURE invocation of the guard, defeating the
   * audit-and-expire design this store exists to provide.
   */
  scope: string;
  /** ISO-8601 timestamp the grant was issued. */
  issuedAt: string;
  /** Grant lifetime in milliseconds from `issuedAt`. */
  ttlMs: number;
  /** Free-form audit note identifying the issuing agent/session. */
  issuedBy?: string;
  /**
   * Human-readable justification. MANDATORY — every issuance is
   * necessarily an audit record, preserving the deliberate-friction
   * property env vars accidentally provided (mt#2658 Success Criteria).
   */
  reason: string;
}

export interface GuardGrantMatchContext {
  guardName: string;
  scope: string;
}

// ---------------------------------------------------------------------------
// Normalization (mirrors merge-grant-store.ts's normalizeTaskId convention)
// ---------------------------------------------------------------------------

/**
 * Normalize a scope qualifier for comparison: lowercase, strip `#` and
 * whitespace. `mt#2581` / `MT#2581` / `mt2581` / `  mt#2581  ` all normalize
 * to `mt2581`. Scopes are frequently task ids, but the store is
 * scope-shape-agnostic — this normalization is a superset-safe default for
 * any scope string, matching the `#`-stripping convention task ids use.
 */
export function normalizeScope(id: string): string {
  return id.trim().toLowerCase().replace(/#/g, "").replace(/\s+/g, "");
}

/** Normalize a guard name for comparison: lowercase + trim. */
export function normalizeGuardName(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

function validateGrant(item: unknown): GuardGrant | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;

  if (typeof rec.guardName !== "string" || rec.guardName.trim().length === 0) return null;
  if (typeof rec.scope !== "string" || rec.scope.trim().length === 0) return null;
  if (typeof rec.issuedAt !== "string" || Number.isNaN(Date.parse(rec.issuedAt))) return null;
  if (typeof rec.ttlMs !== "number" || !Number.isFinite(rec.ttlMs) || rec.ttlMs <= 0) return null;
  if (typeof rec.reason !== "string" || rec.reason.trim().length === 0) return null;

  const issuedBy = typeof rec.issuedBy === "string" ? rec.issuedBy : undefined;

  return {
    guardName: rec.guardName,
    scope: rec.scope,
    issuedAt: rec.issuedAt,
    ttlMs: rec.ttlMs,
    reason: rec.reason,
    issuedBy,
  };
}

/**
 * Parse the raw contents of the grant-store file into a validated grant
 * array. Malformed individual entries are silently skipped (a mix of one
 * corrupt grant + otherwise-valid grants should not lose the valid ones).
 *
 * Returns `null` only when the top-level JSON itself is unparseable or not
 * shaped like `{ grants: [...] }` — the caller treats `null` as a genuine
 * READ ERROR (fail-open signal), distinct from a validly-parsed empty array
 * (confirmed zero-grants state).
 */
export function parseGuardGrantStoreContent(raw: string): GuardGrant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { grants?: unknown }).grants)
  ) {
    return null;
  }
  const grants: GuardGrant[] = [];
  for (const item of (parsed as { grants: unknown[] }).grants) {
    const validated = validateGrant(item);
    if (validated) grants.push(validated);
  }
  return grants;
}

// ---------------------------------------------------------------------------
// Injectable fs dependency (mirrors merge-grant-store.ts's GrantStoreFsDeps
// pattern — keeps this module's tests fs-mock-free per the
// custom/no-real-fs-in-tests ESLint rule)
// ---------------------------------------------------------------------------

export interface GuardGrantStoreFsDeps {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string) => void;
}

const defaultFsDeps: GuardGrantStoreFsDeps = {
  readFileSync: (p: string): string => fs.readFileSync(p, "utf8"),
  writeFileSync: (p: string, content: string): void => {
    fs.writeFileSync(p, content, "utf8");
  },
  mkdirSync: (p: string): void => {
    fs.mkdirSync(p, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// Read path (used by guards — read-only, fail-open on genuine errors)
// ---------------------------------------------------------------------------

export type GuardGrantStoreReadResult =
  | { status: "ok"; grants: GuardGrant[] }
  | { status: "error"; message: string };

/**
 * Read + parse the grant store at `storePath`.
 *
 * - File absent (ENOENT) -> `{ status: "ok", grants: [] }` — a CONFIRMED
 *   "zero grants exist" state, not an error. Callers deny/skip on this.
 * - File present but unreadable (permissions, etc.) or malformed JSON ->
 *   `{ status: "error", ... }` — callers FAIL OPEN on this per the
 *   fail-open posture (a broken store must not silently deny every guard
 *   invocation that would otherwise have honored a legitimate grant).
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 *   Tests pass an in-memory fake instead of touching the real filesystem.
 */
export function readGuardGrantStore(
  storePath: string,
  fsDeps: GuardGrantStoreFsDeps = defaultFsDeps
): GuardGrantStoreReadResult {
  let raw: string;
  try {
    raw = fsDeps.readFileSync(storePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { status: "ok", grants: [] };
    }
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const grants = parseGuardGrantStoreContent(raw);
  if (grants === null) {
    return { status: "error", message: `malformed guard grant store JSON at ${storePath}` };
  }
  return { status: "ok", grants };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * True when `grant` is currently valid (not expired) AND matches `ctx`.
 *
 * Matching requires:
 *   - not expired: `now < Date.parse(issuedAt) + ttlMs`
 *   - `normalizeGuardName(grant.guardName) === normalizeGuardName(ctx.guardName)`
 *   - `normalizeScope(grant.scope) === normalizeScope(ctx.scope)`
 */
export function isGuardGrantValid(
  grant: GuardGrant,
  ctx: GuardGrantMatchContext,
  nowMs: number
): boolean {
  const issuedMs = Date.parse(grant.issuedAt);
  if (Number.isNaN(issuedMs)) return false;
  if (nowMs >= issuedMs + grant.ttlMs) return false; // expired

  if (normalizeGuardName(grant.guardName) !== normalizeGuardName(ctx.guardName)) return false;
  if (normalizeScope(grant.scope) !== normalizeScope(ctx.scope)) return false;

  return true;
}

/** Return the first grant in `grants` that is valid for `ctx` at `nowMs`, or null. */
export function findValidGuardGrant(
  grants: GuardGrant[],
  ctx: GuardGrantMatchContext,
  nowMs: number
): GuardGrant | null {
  return grants.find((g) => isGuardGrantValid(g, ctx, nowMs)) ?? null;
}

// ---------------------------------------------------------------------------
// Write path (used by the issuance script only)
// ---------------------------------------------------------------------------

/**
 * Append `grant` to the store at `storePath`, pruning already-expired
 * grants along the way (keeps the file from growing unbounded across a
 * long-lived operator workstation). Creates the state dir and an empty
 * store if neither exists yet.
 *
 * If the existing store is unreadable/malformed, this starts fresh rather
 * than failing — issuance is an explicit agent/operator action and should
 * not be blocked by a corrupt read; the READ side's own fail-open posture
 * is what protects guard invocations from a corrupt file, not this
 * function's tolerance.
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 * @param nowMs — clock reading used for the expiry prune, mirroring the
 *   `findValidGuardGrant(grants, query, nowMs)` injectable-clock pattern.
 *   Defaults to `Date.now()` for production callers (no behavior change);
 *   tests pass a fixed `nowMs` so pruning is deterministic relative to their
 *   fixture clock instead of the real wall clock (mt#2839).
 */
export function appendGuardGrant(
  storePath: string,
  grant: GuardGrant,
  fsDeps: GuardGrantStoreFsDeps = defaultFsDeps,
  nowMs: number = Date.now()
): void {
  fsDeps.mkdirSync(path.dirname(storePath));

  const existing = readGuardGrantStore(storePath, fsDeps);
  const currentGrants = existing.status === "ok" ? existing.grants : [];

  const now = nowMs;
  const unexpired = currentGrants.filter((g) => {
    const issuedMs = Date.parse(g.issuedAt);
    return !Number.isNaN(issuedMs) && now < issuedMs + g.ttlMs;
  });

  unexpired.push(grant);
  fsDeps.writeFileSync(storePath, `${JSON.stringify({ grants: unexpired }, null, 2)}\n`);
}
