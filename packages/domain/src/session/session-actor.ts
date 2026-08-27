/**
 * Session live-ACTOR verdict (mt#3103) — the gate primitive for destructive
 * session operations.
 *
 * Answers exactly one question: **is any actor live in this session workspace
 * right now?** It exists so the destructive-action gates (mt#3104, mt#3105,
 * mt#3106) consume ONE composed verdict instead of each re-deriving liveness a
 * third time.
 *
 * ## Not to be confused with `deriveSessionLiveness`
 *
 * `deriveSessionLiveness` (`./types.ts`) buckets a session row's
 * `lastActivityAt` into `healthy | idle | stale | orphaned`. That is a DISPLAY
 * verdict over a **sparse checkpoint** signal — `lastActivityAt` is written at
 * roughly eight discrete points (session start, commit, PR approve/close,
 * merge, delete) and NOT on ordinary `session_exec` / `session_edit_file`
 * calls. A session actively being worked without commits reads `stale` there.
 *
 * This module is a GATE verdict over the **dense** signal (presence claims
 * refresh on effectively every session-scoped MCP call) composed with a
 * ground-truth PID check. The two are not interchangeable and neither
 * subsumes the other; unifying the underlying recency signal is mt#3267.
 *
 * ## Failure semantics are INVERTED relative to the rest of the presence path
 *
 * `resolveLastPresenceActivityAtMs` (`./presence-activity.ts`) is deliberately
 * fail-OPEN and returns `null` for BOTH "no claim exists" and "the DB read
 * failed" — correct for an informational signal, wrong for a delete
 * precondition, and it cannot distinguish the two cases this module must keep
 * apart. That is why this module has its own resolution path and does not
 * reuse that helper (mt#3103 SC4).
 *
 * Here, **not knowing is never permission**: any unavailability resolves to
 * `inconclusive`, and callers treat `inconclusive` as refuse.
 *
 * @see mt#3100 (umbrella) · mt#3021 (Layer-1 gates + the shared override contract)
 * @see mt#3267 (unify the recency signal `deriveSessionLiveness` reads)
 */
import { hostname } from "node:os";
import { log } from "@minsky/shared/logger";
import type {
  PresenceClaimRepository,
  PresenceClaim,
  AnnotatedPresenceClaim,
} from "../presence/index";
import { isPidAlive as defaultIsPidAlive } from "./attachment";
import { getLoggableErrorSummary } from "../errors/index";

/**
 * Tri-state, never a bare boolean (mt#3103 SC1). A boolean would collapse
 * "nobody is here" and "I could not find out" into the same value — and the
 * second must never authorize a delete.
 */
export type SessionActorVerdict = "live" | "not-live" | "inconclusive";

/**
 * Structured discriminator for WHY a verdict is `inconclusive` (mt#3105,
 * ask#6273). The delete/cleanup gates treat the two causes differently:
 *
 * - `"store-unavailable"` — the presence store could not be consulted (no
 *   repository, read threw). Fail closed: refuse.
 * - `"no-claim"` — the store read fine and there has never been a claim for
 *   this session. Operator ruling ask#6273: the liveness gate ABSTAINS here
 *   and the git-state guard (mt#3021) decides — the claim mechanism began
 *   2026-07-16, so the claimless population is dominated by legacy sessions,
 *   which are exactly the routine deletion targets.
 *
 * An `inconclusive` result with NO cause (e.g. a claim-derived gray state:
 * wedged-alive-but-stale, unverifiable-and-stale) is refuse-class: consumers
 * may abstain ONLY on the explicit `"no-claim"` cause, so any future
 * inconclusive branch defaults to the safe treatment.
 */
export type SessionActorInconclusiveCause = "no-claim" | "store-unavailable";

export interface SessionActorResult {
  verdict: SessionActorVerdict;
  /** Human-readable basis, suitable for a refusal message. */
  reason: string;
  /** Why the verdict is `inconclusive`, when a consumer-visible cause exists (mt#3105). */
  cause?: SessionActorInconclusiveCause;
  /** The actor holding the session, when one was identified (mt#3105 SC2). */
  actorId?: string;
  /** That actor's last observed activity, ISO-8601 (mt#3105 SC2). */
  lastRefreshedAt?: string;
}

/**
 * Recency ceiling for treating a presence refresh as current activity.
 *
 * 10 minutes, from the mt#2824 heartbeat-cadence rule — the already
 * principal-approved statement of how long real work can go without a visible
 * signal before it is anomalous. Calibrated against live data before locking
 * (mt#3103 SC5): actively-worked sessions were observed refreshing
 * continuously across holds of 217 s, 1108 s and 1832 s, and the freshest
 * sampled row was ~278 s old — comfortably inside this window.
 *
 * Deliberately SHORTER than `PRESENCE_CLAIM_TTL_MS` (15 min): erring short
 * pushes borderline rows toward `inconclusive`, which refuses. For a delete
 * precondition that is the safe direction.
 */
export const DEFAULT_SESSION_ACTOR_RECENCY_MS = 10 * 60 * 1000;

export interface SessionActorDeps {
  /**
   * Resolve the presence repository. Returning null — or throwing — yields
   * `inconclusive`, never `not-live`.
   */
  getRepository: () => Promise<PresenceClaimRepository | null>;
  /** Overridable for tests; defaults to the real `kill -0` probe. */
  isPidAlive?: (pid: number) => boolean;
  localHost?: string;
  now?: () => number;
}

export interface SessionActorOptions {
  /** Overrides {@link DEFAULT_SESSION_ACTOR_RECENCY_MS} (mt#3103 SC5: a parameter, not a literal). */
  recencyThresholdMs?: number;
}

/** Ranked worst-to-best so a multi-claim session can be reduced by "strongest wins". */
const VERDICT_RANK: Record<SessionActorVerdict, number> = {
  "not-live": 0,
  inconclusive: 1,
  live: 2,
};

/**
 * Per-claim PID assessment.
 *
 * `unverifiable` is NOT `dead`: a claim from another host cannot be probed
 * from here, and treating "I can't check" as "nobody's there" is exactly the
 * inversion this module exists to prevent.
 *
 * Deliberately not `isAttachmentConfirmedLive` (`./attachment.ts`), which
 * collapses the same inputs into a BOOLEAN — it returns false for both "the
 * pid is dead" and "this row is from another host." Those two must stay apart
 * here: the first can authorize a delete, the second never can. Same host/pid
 * inputs, one bit more resolution.
 */
type PidState = "alive" | "dead" | "unverifiable";

function assessPid(
  claim: Pick<PresenceClaim, "host" | "pid">,
  localHost: string,
  isPidAlive: (pid: number) => boolean
): PidState {
  if (claim.host && claim.host !== localHost) return "unverifiable";
  if (typeof claim.pid !== "number") return "unverifiable";
  return isPidAlive(claim.pid) ? "alive" : "dead";
}

/**
 * The state table (mt#3103 SC3), one claim at a time.
 *
 * | PID           | refresh | verdict        | why |
 * | ---           | ---     | ---            | --- |
 * | alive         | recent  | `live`         | someone is here and working |
 * | alive         | stale   | `inconclusive` | a WEDGED agent is not safe to delete over |
 * | dead          | recent  | `live`         | activity outlives the pid we happened to record |
 * | unverifiable  | recent  | `live`         | remote/cross-process actor the pid check can't see |
 * | dead          | stale   | `not-live`     | the only cell that authorizes a delete |
 * | unverifiable  | stale   | `inconclusive` | no positive evidence of life AND none of death |
 *
 * The last row resolves a cell the spec's table left implicit (it pairs
 * "dead/unavailable" with `recent` but only "dead" with `stale`). Fail-closed
 * is the tiebreak: an unprobeable pid plus a cold claim means we did not learn
 * anything, and not knowing is never permission.
 */
function verdictForClaim(pid: PidState, recent: boolean): SessionActorVerdict {
  if (recent) return "live";
  if (pid === "alive") return "inconclusive";
  if (pid === "dead") return "not-live";
  return "inconclusive";
}

function describe(claim: PresenceClaim, pid: PidState, recent: boolean): string {
  const when = claim.lastRefreshedAt;
  const freshness = recent ? "refreshed recently" : "last refreshed";
  return `actor ${claim.actorId} (pid ${claim.pid ?? "unknown"}, ${pid}) ${freshness} at ${when}`;
}

/**
 * Resolve whether any actor is live in `sessionId`'s workspace right now.
 *
 * Multi-claim sessions reduce by STRONGEST verdict: one live actor makes the
 * session live regardless of how many dead rows sit beside it.
 *
 * Never throws.
 */
export async function resolveSessionActor(
  sessionId: string,
  deps: SessionActorDeps,
  options: SessionActorOptions = {}
): Promise<SessionActorResult> {
  const recencyThresholdMs = options.recencyThresholdMs ?? DEFAULT_SESSION_ACTOR_RECENCY_MS;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const localHost = deps.localHost ?? hostname();
  const now = deps.now?.() ?? Date.now();

  if (!sessionId) {
    return { verdict: "inconclusive", reason: "no sessionId supplied" };
  }

  let claims: AnnotatedPresenceClaim[];
  try {
    const repo = await deps.getRepository();
    if (!repo) {
      return {
        verdict: "inconclusive",
        cause: "store-unavailable",
        reason:
          "presence store unavailable (no repository) — cannot establish whether an actor is live",
      };
    }
    // Full history: this module applies its OWN recency math, so the
    // repository's 15-minute TTL annotation must not pre-filter rows out.
    //
    // The rows come back as `AnnotatedPresenceClaim` — `PresenceClaim` plus a
    // `stale` boolean the repository computed against THAT threshold. We
    // deliberately ignore `stale`: it answers "older than 15 min?", while this
    // gate asks "older than `recencyThresholdMs`?" (10 min by default, and
    // injectable per SC5). Reading the annotation would silently re-introduce
    // the repository's threshold and make the injectable one a no-op. The
    // timestamp is the input; the verdict is ours.
    claims = await repo.listClaims("session", sessionId, Number.MAX_SAFE_INTEGER);
  } catch (err) {
    log.warn("resolveSessionActor: presence read failed — returning inconclusive", {
      sessionId,
      error: getLoggableErrorSummary(err),
    });
    return {
      verdict: "inconclusive",
      cause: "store-unavailable",
      reason: `presence read failed (${err instanceof Error ? err.message : String(err)}) — cannot establish whether an actor is live`,
    };
  }

  if (claims.length === 0) {
    // Absence of a claim is NOT evidence of absence of an actor: a session
    // that predates the presence write path, or one whose fire-and-forget
    // write was dropped, looks identical to a genuinely empty one.
    return {
      verdict: "inconclusive",
      cause: "no-claim",
      reason:
        "no presence claim on record for this session — absence of a claim is not evidence nobody is working",
    };
  }

  let best: SessionActorResult | undefined;
  for (const claim of claims) {
    const pid = assessPid(claim, localHost, isPidAlive);
    const recent = now - Date.parse(claim.lastRefreshedAt) <= recencyThresholdMs;
    const verdict = verdictForClaim(pid, recent);
    const candidate: SessionActorResult = {
      verdict,
      reason: describe(claim, pid, recent),
      actorId: claim.actorId,
      lastRefreshedAt: claim.lastRefreshedAt,
    };
    if (!best || VERDICT_RANK[verdict] > VERDICT_RANK[best.verdict]) best = candidate;
  }

  return best as SessionActorResult;
}

/**
 * Adapter from an optional persistence provider to this module's
 * `getRepository` dependency shape — the standard way a destructive-gate call
 * site (mt#3105 delete, mt#3104 cleanup) supplies presence access from the
 * `persistenceProvider` it already carries for the audit sink.
 *
 * Mirrors `session ps`'s repository construction
 * (`src/adapters/shared/commands/session/ps-command.ts`) and
 * `presence-activity.ts`'s provider shape. Resolving to null — no provider,
 * no `getDatabaseConnection`, no connection, or a throw — yields the
 * primitive's `store-unavailable` refusal upstream; this helper never throws.
 */
export async function presenceRepositoryFromProvider(
  provider: { getDatabaseConnection?: () => Promise<unknown> } | undefined | null
): Promise<PresenceClaimRepository | null> {
  try {
    if (!provider?.getDatabaseConnection) return null;
    const db = await provider.getDatabaseConnection();
    if (!db) return null;
    const { buildPresenceClaimRepository } = await import("../presence/index");
    return buildPresenceClaimRepository(db);
  } catch (err) {
    log.debug("presenceRepositoryFromProvider: failed to build repository", {
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}
