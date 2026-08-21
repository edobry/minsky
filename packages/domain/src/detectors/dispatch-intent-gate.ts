/**
 * Decision: does a live `"read-only"` dispatch-intent declaration cover this
 * session, and so deny a session-mutating tool call? (mt#2865)
 *
 * Lifted from `.minsky/hooks/dispatch-intent-write-gate.ts` by mt#4374's first
 * extraction wave, together with the declaration matching it rests on.
 *
 * WHY THE DECLARATION TYPE AND ITS VALIDITY PREDICATE CAME ALONG. The gate's
 * verdict was already pure — `(sessionId, declarations, nowMs)`, clock injected
 * — so the move looked trivial. It was not: the verdict is computed by
 * `isDeclarationValid`, which lived in `.minsky/hooks/dispatch-intent-store.ts`,
 * a module the mt#4372 inventory classifies immovable as `no-decision: store`.
 * That classification is right about the FILE and wrong about this function:
 * expiry-and-session matching is a verdict over values, reading no clock and no
 * filesystem, while the store's actual storage concerns (paths, locking,
 * read-modify-write, parse) are what make the file immovable. Duplicating the
 * predicate here would be the exact add-here-keep-there shape mt#4330 exists to
 * flag, so it MOVED, and the store now imports it back and re-exports it — every
 * existing consumer of the store keeps its import unchanged.
 *
 * ADR-026 tier 2: no dependencies, so no `deps` parameter — nothing to inject.
 * `nowMs` is a value the caller supplies, not a clock this module reads.
 *
 * @see docs/architecture/adr-026-dependency-injection-convention.md — rule 2
 * @see docs/architecture/hooks/dispatch-intent-write-gate.md
 * @see mt#4374 — the extraction wave
 */

/** The declared intent for a session's current dispatch. */
export type DispatchIntent = "read-only" | "implementation";

/** A dispatch-intent declaration, as issued by the orchestrator. */
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

/**
 * Normalize a session id for comparison: lowercase + trim.
 *
 * Mirrors `merge-grant-store.ts`'s `normalizeTaskId` convention — session ids
 * are UUID-shaped, not `#`-prefixed, but the same trim+lowercase normalization
 * is a superset-safe default.
 */
export function normalizeSessionId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * True when `declaration` is unexpired at `nowMs` AND scoped to `ctx`'s session.
 *
 * An unresolvable session id is NOT a match: the guard cannot confirm the
 * declaration applies to this call, and a declaration that cannot be confirmed
 * must not deny.
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
 * function the dispatch-intent write gate uses to decide whether to deny
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

/**
 * True when ANY live declaration (read-only OR implementation) covers
 * `sessionId` — intentionally intent-agnostic (unlike
 * `findLiveReadOnlyDeclaration`): for the nested-fork guard, the mere presence
 * of an explicit prior declaration — of either intent — is what distinguishes a
 * dispatch the orchestrator consciously prepared for from the incident's
 * silently-undeclared one. An `"implementation"`-intent declaration does not
 * (and should not) also trigger the write gate's denial — that gate filters
 * specifically on `"read-only"` — so declaring `"implementation"` intent only
 * unblocks the DISPATCH, leaving the fork's write access exactly as
 * unrestricted as an ordinary top-level dispatch.
 */
export function hasLiveDeclaration(
  declarations: DispatchIntentDeclaration[],
  sessionId: string | null,
  nowMs: number
): boolean {
  return declarations.some((d) => isDeclarationValid(d, { sessionId }, nowMs));
}

export type DispatchIntentGateDecision =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string };

/** The denial text shown to a subagent whose write was blocked. */
export function buildDispatchIntentDenialMessage(
  sessionId: string | null,
  declaration: DispatchIntentDeclaration
): string {
  const sessionRef = sessionId ?? "this session";
  const reasonPart = declaration.reason ? ` (declared reason: "${declaration.reason}")` : "";
  return (
    `Write denied (mt#2865 dispatch-intent gate): ${sessionRef} carries a live "read-only" ` +
    `dispatch-intent declaration${reasonPart}, issued ${declaration.issuedAt}. ` +
    "This dispatch was bound to read-only work (investigation, lookup, review) — it is not " +
    "authorized to commit, edit files, or mutate a PR in this session. Report your findings " +
    "back to the parent instead; the parent decides whether to act on them. If this dispatch " +
    'genuinely needs write access, the orchestrator must issue a fresh `intent: "implementation"` ' +
    "declaration via `session.generate_prompt` (or let the read-only declaration's TTL expire) " +
    "before retrying."
  );
}

/**
 * The verdict, given the resolved session id, the declarations already read
 * from the store, and the current time.
 */
export function decideDispatchIntentGate(
  sessionId: string | null,
  declarations: DispatchIntentDeclaration[],
  nowMs: number
): DispatchIntentGateDecision {
  const match = findLiveReadOnlyDeclaration(declarations, { sessionId }, nowMs);
  if (match) {
    return { decision: "deny", reason: buildDispatchIntentDenialMessage(sessionId, match) };
  }
  return {
    decision: "allow",
    reason: `no live read-only declaration for session=${sessionId ?? "?"} — write permitted`,
  };
}
