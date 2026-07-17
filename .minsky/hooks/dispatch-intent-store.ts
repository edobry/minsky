// Shared, dependency-free store for subagent dispatch-intent declarations
// (mt#2865).
//
// This is the FOURTH instance of the ADR-028 D5/D8 file-based grant/
// declaration-store pattern in this hooks tree — after
// `merge-grant-store.ts` (subagent merge capability, mt#2651),
// `guard-grant-store.ts` (generalized guard-override grants, mt#2658), and
// `ask-grant-store.ts` (approved-Ask action grants, mt#2823). This module
// mirrors `guard-grant-store.ts`'s shape line-for-line (state-dir
// resolution, injectable fs deps, read/parse/validate/match/append
// functions) with the record shape swapped for a dispatch-intent
// declaration instead of a guard-override grant. Deliberately NOT further
// abstracted into a shared generic — per this pattern's own precedent
// (`guard-grant-store.ts`'s header explicitly generalized ONE prior
// instance, not built a framework ahead of need) each store stays a small,
// self-contained, independently auditable file. A fifth instance appearing
// would be the trigger to extract a shared base, not this one.
//
// ## Motivation (mt#2865 — fork scope-violation incident)
//
// During mt#2828 (2026-07-16), an implementer dispatched a `fork` subagent
// with a narrow, bounded, read-only instruction ("search memory... report
// back under 300 words"). The fork inherited the FULL conversation context
// (confirmed at the transcript level — see mt#2865's spec "Incident
// reconstruction" section) and, primed by that inherited implementation
// context, proceeded to write code, commit to the shared session
// workspace, and edit the shared GitHub PR's title/body/author AFTER the
// primary implementer had already finalized it — including writing a false
// test-count claim into the PR body. The harness's own fork-boilerplate
// prompt ("you are NOT a continuation of that agent... execute ONE
// directive, then stop... do NOT spawn subagents") was insufficient:
// prompt-level containment does not hold once a fork carries a full
// implementation context. This store backs a STRUCTURAL (tool-level)
// mitigation instead: an orchestrator dispatching a subagent for a
// bounded, read-only task declares that intent for the SESSION (the shared
// resource the incident fork corrupted) BEFORE dispatch, and
// `dispatch-intent-write-gate.ts` denies session-mutating/PR-mutating tool
// calls from ANY subagent (agent_id present) while a live read-only
// declaration covers the call's target session — regardless of which
// specific agent_id ends up making the call, which is exactly what a
// fork's inherited-but-distinct identity would otherwise evade.
//
// ## Consumers
//
//   - `.minsky/hooks/dispatch-intent-write-gate.ts` (the guard — reads the
//     store, never writes it)
//   - `session.generate_prompt` (`src/adapters/shared/commands/session/
//     prompt-command.ts`) — the dispatch-time issuance surface: when called
//     with `intent: "read-only"`, writes a declaration for the resolved
//     session BEFORE the subagent is dispatched.
//
// Self-containment (per `.claude/hooks/SPEC.md` + ADR-028 "Context —
// Adjacent-but-distinct prior art"): this module imports ONLY `node:fs`,
// `node:os`, `node:path` — no `packages/domain` import, so the guard keeps
// working even when the main codebase has type errors. State-dir
// resolution mirrors `guard-grant-store.ts`'s `getStateDir()` precedent
// exactly: `MINSKY_STATE_DIR` override, else `XDG_STATE_HOME`/minsky, else
// `~/.local/state/minsky`.
//
// @see mt#2865 — this module's tracking task
// @see .minsky/hooks/guard-grant-store.ts — the pattern this module mirrors
// @see .minsky/hooks/merge-grant-store.ts — the original instance of the pattern
// @see .minsky/hooks/ask-grant-store.ts — the third instance of the pattern
// @see docs/architecture/hooks/dispatch-intent-write-gate.md

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// State-dir + store-path resolution
// ---------------------------------------------------------------------------

const DISPATCH_INTENT_STORE_FILENAME = "dispatch-intents.json";

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
export function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/** Absolute path to the shared dispatch-intent store file. */
export function getDispatchIntentStorePath(): string {
  return path.join(getStateDir(), DISPATCH_INTENT_STORE_FILENAME);
}

// ---------------------------------------------------------------------------
// Declaration record shape
// ---------------------------------------------------------------------------

/** The two dispatch intents a subagent dispatch can declare (mt#2865). */
export type DispatchIntent = "read-only" | "implementation";

/**
 * A TTL-bound dispatch-intent declaration, scoped to a SESSION id — the
 * shared resource a subagent (or a fork inheriting its context) writes
 * into. Unlike the sibling grant stores (which authorize an OVERRIDE),
 * this store records a DECLARATION that itself narrows what the declared
 * session is allowed to do — the gate denies WRITES when a live
 * `"read-only"` declaration is found, rather than requiring a grant to
 * ALLOW an otherwise-denied action.
 */
export interface DispatchIntentDeclaration {
  /** Session id this declaration is scoped to (the shared workspace resource). */
  sessionId: string;
  /** The declared intent for this session's current dispatch. */
  intent: DispatchIntent;
  /** ISO-8601 timestamp the declaration was issued. */
  issuedAt: string;
  /** Declaration lifetime in milliseconds from `issuedAt`. */
  ttlMs: number;
  /** Free-form audit note identifying the issuing orchestrator/session. */
  issuedBy?: string;
  /** Free-form human-readable justification (e.g. the bounded lookup instruction). */
  reason?: string;
}

export interface DispatchIntentMatchContext {
  /** Resolved session id for the current tool call, or null if unresolvable. */
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Session-id normalization (mirrors merge-grant-store.ts's normalizeTaskId
// convention — session ids are UUID-shaped, not `#`-prefixed, but the same
// trim+lowercase normalization is a superset-safe default)
// ---------------------------------------------------------------------------

/** Normalize a session id for comparison: lowercase + trim. */
export function normalizeSessionId(id: string): string {
  return id.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

const VALID_INTENTS: ReadonlySet<string> = new Set(["read-only", "implementation"]);

function validateDeclaration(item: unknown): DispatchIntentDeclaration | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;

  if (typeof rec.sessionId !== "string" || rec.sessionId.trim().length === 0) return null;
  if (typeof rec.intent !== "string" || !VALID_INTENTS.has(rec.intent)) return null;
  if (typeof rec.issuedAt !== "string" || Number.isNaN(Date.parse(rec.issuedAt))) return null;
  if (typeof rec.ttlMs !== "number" || !Number.isFinite(rec.ttlMs) || rec.ttlMs <= 0) return null;

  const issuedBy = typeof rec.issuedBy === "string" ? rec.issuedBy : undefined;
  const reason = typeof rec.reason === "string" ? rec.reason : undefined;

  return {
    sessionId: rec.sessionId,
    intent: rec.intent as DispatchIntent,
    issuedAt: rec.issuedAt,
    ttlMs: rec.ttlMs,
    issuedBy,
    reason,
  };
}

/**
 * Parse the raw contents of the dispatch-intent store file into a
 * validated declaration array. Malformed individual entries are silently
 * skipped (a mix of one corrupt declaration + otherwise-valid declarations
 * should not lose the valid ones).
 *
 * Returns `null` only when the top-level JSON itself is unparseable or not
 * shaped like `{ declarations: [...] }` — the caller treats `null` as a
 * genuine READ ERROR (fail-open signal), distinct from a validly-parsed
 * empty array (confirmed zero-declarations state).
 */
export function parseDispatchIntentStoreContent(raw: string): DispatchIntentDeclaration[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { declarations?: unknown }).declarations)
  ) {
    return null;
  }
  const declarations: DispatchIntentDeclaration[] = [];
  for (const item of (parsed as { declarations: unknown[] }).declarations) {
    const validated = validateDeclaration(item);
    if (validated) declarations.push(validated);
  }
  return declarations;
}

// ---------------------------------------------------------------------------
// Injectable fs dependency (mirrors guard-grant-store.ts's
// GuardGrantStoreFsDeps pattern — keeps this module's tests fs-mock-free
// per the custom/no-real-fs-in-tests ESLint rule)
// ---------------------------------------------------------------------------

export interface DispatchIntentStoreFsDeps {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string) => void;
}

const defaultFsDeps: DispatchIntentStoreFsDeps = {
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

export type DispatchIntentStoreReadResult =
  | { status: "ok"; declarations: DispatchIntentDeclaration[] }
  | { status: "error"; message: string };

/**
 * Read + parse the dispatch-intent store at `storePath`.
 *
 * - File absent (ENOENT) -> `{ status: "ok", declarations: [] }` — a
 *   CONFIRMED "zero declarations exist" state, not an error. The guard
 *   allows (does not deny) on this — see `dispatch-intent-write-gate.ts`'s
 *   default-allow posture doc comment.
 * - File present but unreadable (permissions, etc.) or malformed JSON ->
 *   `{ status: "error", ... }` — the guard FAILS OPEN on this (a broken
 *   store must not silently deny every subagent write).
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 *   Tests pass an in-memory fake instead of touching the real filesystem.
 */
export function readDispatchIntentStore(
  storePath: string,
  fsDeps: DispatchIntentStoreFsDeps = defaultFsDeps
): DispatchIntentStoreReadResult {
  let raw: string;
  try {
    raw = fsDeps.readFileSync(storePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { status: "ok", declarations: [] };
    }
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const declarations = parseDispatchIntentStoreContent(raw);
  if (declarations === null) {
    return { status: "error", message: `malformed dispatch-intent store JSON at ${storePath}` };
  }
  return { status: "ok", declarations };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * True when `declaration` is currently valid (not expired) AND matches
 * `ctx`'s session id.
 *
 * Matching requires:
 *   - not expired: `now < Date.parse(issuedAt) + ttlMs`
 *   - `ctx.sessionId` is resolvable (a declaration cannot match an
 *     unresolvable session) AND
 *     `normalizeSessionId(declaration.sessionId) === normalizeSessionId(ctx.sessionId)`
 *
 * Does NOT filter on `intent` here — callers that specifically want the
 * gating (deny-on-match) behavior use {@link findLiveReadOnlyDeclaration},
 * which additionally requires `intent === "read-only"`. This lower-level
 * predicate is intent-agnostic so a future caller could look up the
 * CURRENT declared intent (read-only or implementation) for a session
 * without assuming which one it's checking for.
 */
export function isDeclarationValid(
  declaration: DispatchIntentDeclaration,
  ctx: DispatchIntentMatchContext,
  nowMs: number
): boolean {
  const issuedMs = Date.parse(declaration.issuedAt);
  if (Number.isNaN(issuedMs)) return false;
  if (nowMs >= issuedMs + declaration.ttlMs) return false; // expired

  if (!ctx.sessionId) return false; // cannot confirm session match
  if (normalizeSessionId(declaration.sessionId) !== normalizeSessionId(ctx.sessionId)) return false;

  return true;
}

/**
 * Return the first LIVE (not expired) `"read-only"` declaration in
 * `declarations` matching `ctx`'s session id, or `null`. This is the
 * function `dispatch-intent-write-gate.ts` uses to decide whether to deny
 * a session-mutating/PR-mutating tool call.
 */
export function findLiveReadOnlyDeclaration(
  declarations: DispatchIntentDeclaration[],
  ctx: DispatchIntentMatchContext,
  nowMs: number
): DispatchIntentDeclaration | null {
  return (
    declarations.find((d) => d.intent === "read-only" && isDeclarationValid(d, ctx, nowMs)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Write path (used by the dispatch-time issuance surface only)
// ---------------------------------------------------------------------------

/**
 * Append `declaration` to the store at `storePath`, pruning already-expired
 * declarations along the way (keeps the file from growing unbounded across
 * a long-lived operator workstation). Creates the state dir and an empty
 * store if neither exists yet.
 *
 * If the existing store is unreadable/malformed, this starts fresh rather
 * than failing — issuance is an explicit dispatch-time action and should
 * not be blocked by a corrupt read; the READ side's own fail-open posture
 * is what protects guard invocations from a corrupt file, not this
 * function's tolerance.
 *
 * @param fsDeps — injectable fs functions; defaults to real `node:fs`.
 * @param nowMs — clock reading used for the expiry prune, mirroring
 *   `guard-grant-store.ts`'s `appendGuardGrant` injectable-clock pattern
 *   (mt#2839). Defaults to `Date.now()` for production callers; tests pass
 *   a fixed `nowMs` so pruning is deterministic relative to their fixture
 *   clock.
 */
export function appendDispatchIntentDeclaration(
  storePath: string,
  declaration: DispatchIntentDeclaration,
  fsDeps: DispatchIntentStoreFsDeps = defaultFsDeps,
  nowMs: number = Date.now()
): void {
  fsDeps.mkdirSync(path.dirname(storePath));

  const existing = readDispatchIntentStore(storePath, fsDeps);
  const currentDeclarations = existing.status === "ok" ? existing.declarations : [];

  const now = nowMs;
  const unexpired = currentDeclarations.filter((d) => {
    const issuedMs = Date.parse(d.issuedAt);
    return !Number.isNaN(issuedMs) && now < issuedMs + d.ttlMs;
  });

  unexpired.push(declaration);
  fsDeps.writeFileSync(storePath, `${JSON.stringify({ declarations: unexpired }, null, 2)}\n`);
}
