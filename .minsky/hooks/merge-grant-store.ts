// Shared, dependency-free store for ADR-028 D5 subagent merge-capability
// grants.
//
// Design (ADR-028 D5): subagent-initiated `session_pr_merge` is DEFAULT-DENY.
// The escape valve is an explicit, TTL-bound, auditable capability grant
// issued by the orchestrator (main agent, or an orchestrating parent) at or
// after dispatch time. This module is the single source of truth for the
// grant record shape and the read/write/validate logic, shared by:
//
//   - `.minsky/hooks/block-subagent-merge-without-grant.ts` (the guard —
//     reads the store, never writes it)
//   - `scripts/grant-subagent-merge.ts` (the orchestrator-side issuance
//     surface — writes the store)
//
// Self-containment (per `.claude/hooks/SPEC.md` + ADR-028 "Context —
// Adjacent-but-distinct prior art"): this module imports ONLY `node:fs`,
// `node:os`, `node:path` — no `packages/domain` import, so the guard keeps
// working even when the main codebase has type errors. `scripts/` is NOT
// subject to that invariant, but importing this module keeps the grant
// schema and matching logic in exactly one place instead of duplicated
// between the guard and the issuance script.
//
// State-dir resolution mirrors `.minsky/hooks/inject-prod-state.ts`'s
// `getStateDir()` precedent: `MINSKY_STATE_DIR` override, else
// `XDG_STATE_HOME`/minsky, else `~/.local/state/minsky`. `MINSKY_STATE_DIR`
// is already registered in `HOOK_ONLY_ENV_VARS`
// (packages/domain/src/configuration/sources/environment.ts) — no new
// registration needed for it.
//
// @see mt#2651 — this module's tracking task
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md §D5

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// State-dir + store-path resolution
// ---------------------------------------------------------------------------

const MERGE_GRANT_STORE_FILENAME = "merge-grants.json";

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
export function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/** Absolute path to the shared merge-grant store file. */
export function getMergeGrantStorePath(): string {
  return path.join(getStateDir(), MERGE_GRANT_STORE_FILENAME);
}

// ---------------------------------------------------------------------------
// Grant record shape
// ---------------------------------------------------------------------------

/**
 * A TTL-bound capability grant authorizing a subagent-initiated
 * `session_pr_merge` for a specific task (ADR-028 D5).
 *
 * Scoped primarily by `taskId` (per D5: "scoped to (parentSessionId,
 * taskId)" — `parentSessionId` is folded into `issuedBy` for audit purposes
 * rather than as a matching key, since the guard has no reliable way to
 * observe the parent session id at merge time). `prNumber` is accepted for
 * forward compatibility (grants issued after PR creation, when the PR number
 * is known) but is NOT resolved by the guard in this version — see the
 * "Known limitations" note in `.minsky/rules/hook-files.mdc`'s "Subagent
 * Merge Capability Guard" section.
 */
export interface MergeGrant {
  /** Task id this grant authorizes (e.g. "mt#2651"). Required matching key. */
  taskId: string;
  /**
   * Optional PR number this grant is additionally scoped to. Accepted and
   * persisted, but not yet resolved/matched by the guard (see module doc).
   */
  prNumber?: number;
  /**
   * Which agent(s) this grant covers. `"any"` (default) authorizes any
   * subagent dispatched for the task — the harness's per-dispatch `agent_id`
   * is not knowable at issuance time in the common case. A specific
   * `agent_id` further restricts the grant when the orchestrator does know
   * it (e.g. issuing a grant for an already-running subagent).
   */
  agentScope: string;
  /** ISO-8601 timestamp the grant was issued. */
  issuedAt: string;
  /** Grant lifetime in milliseconds from `issuedAt`. */
  ttlMs: number;
  /** Free-form audit note identifying the issuing orchestrator/session. */
  issuedBy?: string;
  /** Free-form human-readable justification. */
  reason?: string;
}

export interface MergeGrantMatchContext {
  /** Resolved task id for the current `session_pr_merge` invocation, or null if unresolvable. */
  taskId: string | null;
  /** The harness `agent_id` making the call. */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Task-id normalization (mirrors check-task-spec-read.ts's convention)
// ---------------------------------------------------------------------------

/**
 * Normalize a task id for comparison: lowercase, strip `#` and whitespace.
 * `mt#2651` / `MT#2651` / `mt2651` / `  mt#2651  ` all normalize to `mt2651`.
 */
export function normalizeTaskId(id: string): string {
  return id.trim().toLowerCase().replace(/#/g, "").replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

function validateGrant(item: unknown): MergeGrant | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;

  if (typeof rec.taskId !== "string" || rec.taskId.trim().length === 0) return null;
  if (typeof rec.issuedAt !== "string" || Number.isNaN(Date.parse(rec.issuedAt))) return null;
  if (typeof rec.ttlMs !== "number" || !Number.isFinite(rec.ttlMs) || rec.ttlMs <= 0) return null;

  const agentScope =
    typeof rec.agentScope === "string" && rec.agentScope.trim().length > 0 ? rec.agentScope : "any";
  const prNumber =
    typeof rec.prNumber === "number" && Number.isFinite(rec.prNumber) ? rec.prNumber : undefined;
  const issuedBy = typeof rec.issuedBy === "string" ? rec.issuedBy : undefined;
  const reason = typeof rec.reason === "string" ? rec.reason : undefined;

  return {
    taskId: rec.taskId,
    prNumber,
    agentScope,
    issuedAt: rec.issuedAt,
    ttlMs: rec.ttlMs,
    issuedBy,
    reason,
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
export function parseGrantStoreContent(raw: string): MergeGrant[] | null {
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
  const grants: MergeGrant[] = [];
  for (const item of (parsed as { grants: unknown[] }).grants) {
    const validated = validateGrant(item);
    if (validated) grants.push(validated);
  }
  return grants;
}

// ---------------------------------------------------------------------------
// Injectable fs dependency (mirrors types.ts's readHostCap `readFile` inject
// pattern — keeps this module's tests fs-mock-free per the
// custom/no-real-fs-in-tests ESLint rule, instead of touching a real
// temp-dir/tmpdir()/fs.* surface from test code)
// ---------------------------------------------------------------------------

export interface GrantStoreFsDeps {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string) => void;
}

const defaultFsDeps: GrantStoreFsDeps = {
  readFileSync: (p: string): string => fs.readFileSync(p, "utf8"),
  writeFileSync: (p: string, content: string): void => {
    fs.writeFileSync(p, content, "utf8");
  },
  mkdirSync: (p: string): void => {
    fs.mkdirSync(p, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// Read path (used by the guard — read-only, fail-open on genuine errors)
// ---------------------------------------------------------------------------

export type GrantStoreReadResult =
  | { status: "ok"; grants: MergeGrant[] }
  | { status: "error"; message: string };

/**
 * Read + parse the grant store at `storePath`.
 *
 * - File absent (ENOENT) -> `{ status: "ok", grants: [] }` — a CONFIRMED
 *   "zero grants exist" state, not an error. The guard denies on this.
 * - File present but unreadable (permissions, etc.) or malformed JSON ->
 *   `{ status: "error", ... }` — the guard FAILS OPEN on this per the
 *   fail-open posture (a broken store must not silently deny every
 *   subagent merge).
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 *   Tests pass an in-memory fake instead of touching the real filesystem.
 */
export function readGrantStore(
  storePath: string,
  fsDeps: GrantStoreFsDeps = defaultFsDeps
): GrantStoreReadResult {
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

  const grants = parseGrantStoreContent(raw);
  if (grants === null) {
    return { status: "error", message: `malformed grant store JSON at ${storePath}` };
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
 *   - `ctx.taskId` is resolvable (a grant cannot match an unresolvable task)
 *     AND `normalizeTaskId(grant.taskId) === normalizeTaskId(ctx.taskId)`
 *   - `grant.agentScope === "any"` OR `grant.agentScope === ctx.agentId`
 */
export function isGrantValid(
  grant: MergeGrant,
  ctx: MergeGrantMatchContext,
  nowMs: number
): boolean {
  const issuedMs = Date.parse(grant.issuedAt);
  if (Number.isNaN(issuedMs)) return false;
  if (nowMs >= issuedMs + grant.ttlMs) return false; // expired

  if (!ctx.taskId) return false; // cannot confirm task match
  if (normalizeTaskId(grant.taskId) !== normalizeTaskId(ctx.taskId)) return false;

  if (grant.agentScope !== "any" && grant.agentScope !== ctx.agentId) return false;

  return true;
}

/** Return the first grant in `grants` that is valid for `ctx` at `nowMs`, or null. */
export function findValidGrant(
  grants: MergeGrant[],
  ctx: MergeGrantMatchContext,
  nowMs: number
): MergeGrant | null {
  return grants.find((g) => isGrantValid(g, ctx, nowMs)) ?? null;
}

// ---------------------------------------------------------------------------
// Write path (used by the orchestrator-side issuance script only)
// ---------------------------------------------------------------------------

/**
 * Append `grant` to the store at `storePath`, pruning already-expired
 * grants along the way (keeps the file from growing unbounded across a
 * long-lived operator workstation). Creates the state dir and an empty
 * store if neither exists yet.
 *
 * If the existing store is unreadable/malformed, this starts fresh rather
 * than failing — issuance is an explicit operator/orchestrator action and
 * should not be blocked by a corrupt read; the guard's OWN fail-open
 * posture is what protects subagents from a corrupt file, not this
 * function's tolerance.
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 */
export function appendGrant(
  storePath: string,
  grant: MergeGrant,
  fsDeps: GrantStoreFsDeps = defaultFsDeps
): void {
  fsDeps.mkdirSync(path.dirname(storePath));

  const existing = readGrantStore(storePath, fsDeps);
  const currentGrants = existing.status === "ok" ? existing.grants : [];

  const now = Date.now();
  const unexpired = currentGrants.filter((g) => {
    const issuedMs = Date.parse(g.issuedAt);
    return !Number.isNaN(issuedMs) && now < issuedMs + g.ttlMs;
  });

  unexpired.push(grant);
  fsDeps.writeFileSync(storePath, `${JSON.stringify({ grants: unexpired }, null, 2)}\n`);
}
