/**
 * tasks.claims MCP command — mt#2562.
 *
 * Surfaces who is actively working on a given task right now, independent
 * of whether a Minsky workspace session exists.
 *
 * Tools registered:
 *   tasks_claims_list     — list active presence claims for a task.
 *   tasks_claims_release  — release the CALLER's own claim (mt#4568).
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  buildPresenceClaimRepository,
  normalizeTaskSubjectId,
  PRESENCE_CLAIM_TTL_MS,
} from "@minsky/domain/presence/index";
import { resolveCallerActorId } from "@minsky/domain/agent-identity/index";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Parameter map
// ---------------------------------------------------------------------------

const tasksClaimsListParams = {
  taskId: {
    schema: z.string(),
    description: 'Task identifier (e.g. "mt#2562" or "2562")',
    required: true,
  },
  staleThresholdMs: {
    schema: z.number().optional(),
    description: `Age in milliseconds past which a claim is considered stale (default: ${PRESENCE_CLAIM_TTL_MS} = 15 min)`,
    required: false,
  },
  includeStale: {
    schema: z.boolean().default(false),
    description: "Include stale claims in the result (default: false)",
    required: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build and return the `tasks_claims_list` command definition.
 *
 * The command is best-effort: when the persistence provider or DB connection
 * is unavailable it returns an empty result rather than throwing.
 */
export function createTasksClaimsListCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.claims.list",
    category: CommandCategory.TASKS,
    name: "list",
    description:
      "List active presence claims for a task — who is actively working on it right now.",
    // mt#3889/mt#3903: this tool READS presence, so invoking it must not WRITE
    // one. Without this the probe refreshes the `lastRefreshedAt` it is about
    // to report, and a long-stale claim reads back fresh. Declared here rather
    // than in a list inside `src/mcp/server.ts` so the fact travels with the
    // tool — a sibling presence-reading tool added later needs this line and
    // nothing else.
    readsPresence: true,
    parameters: tasksClaimsListParams,

    async execute(params) {
      const { taskId, staleThresholdMs = PRESENCE_CLAIM_TTL_MS, includeStale = false } = params;

      // Canonicalize to the SAME key the write path stores (PR #1755 R1) so
      // `mt#2562`, `2562`, and `MT-2562` all resolve the same claim set.
      const subjectId = normalizeTaskSubjectId(taskId);
      if (!subjectId) {
        return { claims: [], taskId: subjectId };
      }

      try {
        const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
        if (!provider?.getDatabaseConnection) {
          log.debug("[tasks.claims.list] No SQL persistence provider available");
          return { claims: [], taskId: subjectId };
        }

        const db = await provider.getDatabaseConnection();
        const repo = buildPresenceClaimRepository(db);
        if (!repo) {
          log.debug("[tasks.claims.list] Could not build PresenceClaimRepository");
          return { claims: [], taskId: subjectId };
        }

        const threshold = staleThresholdMs ?? PRESENCE_CLAIM_TTL_MS;
        const annotated = await repo.listClaims("task", subjectId, threshold);
        const claims = includeStale ? annotated : annotated.filter((c) => !c.stale);

        return {
          claims,
          taskId: subjectId,
          total: annotated.length,
          fresh: annotated.filter((c) => !c.stale).length,
          stale: annotated.filter((c) => c.stale).length,
        };
      } catch (err: unknown) {
        log.warn("[tasks.claims.list] Presence claim list failed", {
          taskId: subjectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { claims: [], taskId: subjectId, error: String(err) };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Release (mt#4568)
// ---------------------------------------------------------------------------

const tasksClaimsReleaseParams = {
  taskId: {
    schema: z.string(),
    description: 'Task identifier (e.g. "mt#4568" or "4568")',
    required: true,
  },
  callerActorId: {
    schema: z.string(),
    description:
      "The caller's resolved agentId (ADR-006), used to scope the release to the caller's OWN " +
      "claim. Server-injected from the resolved MCP identity (src/mcp/server.ts) — not supplied " +
      "by hand, and any hand-supplied value is overwritten there. Absent on the CLI path, which " +
      "resolves identity from the harness environment instead.",
    required: false,
    // Server-injected only — hide it from the CLI surface so it is not
    // advertised as a hand-passable flag (mirrors observability.calibration-review).
    cliHidden: true,
  },
} as const;

/** The subset of a claim this module needs to decide ownership and to report it. */
interface OwnableClaim {
  id: string;
  actorId: string;
  claimedAt: string;
  lastRefreshedAt: string;
}

/**
 * The claims `actorId` holds, among all claims on a subject (mt#4568).
 *
 * Extracted as a pure function because it IS the decision this command makes —
 * everything around it (provider → connection → repository → delete) is
 * imperative shell. Testing it directly means the ownership rule is covered
 * without patching a module the command reaches for itself
 * (`testing-standards.mdc §Testable Design`).
 *
 * Exact match on `actorId`, deliberately: there is no prefix or fuzzy matching
 * that would let one conversation release another's claim, and a caller whose
 * id is a stale conversation (mt#4440) simply matches nothing here rather than
 * matching approximately.
 */
export function selectOwnClaims<T extends OwnableClaim>(
  claims: readonly T[],
  actorId: string
): T[] {
  return claims.filter((c) => c.actorId === actorId);
}

/**
 * Build and return the `tasks_claims_release` command definition (mt#4568).
 *
 * Presence claims refresh on any mutating call carrying a task id, so an agent
 * handing a task off re-stakes the claim it is trying to give up — the more
 * carefully it writes handoff notes, the longer it holds. Before this, the only
 * exit was waiting out `PRESENCE_CLAIM_TTL_MS`.
 *
 * **This does not make presence a lock.** It makes the advisory signal able to
 * express a fact it previously could not: "I am done here." A task with no claim
 * was never, and still is not, a task that is safe to act on — see
 * `docs/architecture/presence-claims.md` §"What it is (and is not)".
 */
export function createTasksClaimsReleaseCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.claims.release",
    category: CommandCategory.TASKS,
    name: "release",
    description:
      "Release this caller's presence claim on a task — record that you are done with it " +
      "instead of waiting out the 15-minute TTL. Advisory only: a task with no claim is NOT " +
      "thereby safe to act on, and nothing may gate a destructive action on a claim's absence.",
    // mt#4568: this tool WRITES presence (it deletes a row), and the flag is
    // still the right one. `readsPresence` does not classify reads vs writes —
    // its docblock disclaims that reading explicitly — it names ONE interaction
    // with ONE subsystem: the ambient `writeTaskClaim` must not fire for this
    // tool.
    //
    // Without it, release is a NO-OP THAT REPORTS SUCCESS. `writeTaskClaim` runs
    // AFTER the handler returns (`src/mcp/server.ts`), fire-and-forget, for any
    // call carrying `task`/`taskId` — so it re-INSERTs the row this call just
    // deleted, with a fresh `claimedAt`. The CLI path never calls
    // `writeTaskClaim`, so that failure is invisible to a CLI-only test; the
    // round-trip test asserts the flag survives registration for exactly this
    // reason.
    readsPresence: true,
    parameters: tasksClaimsReleaseParams,

    async execute(params) {
      const { taskId, callerActorId } = params;

      // Same canonicalization as the write path and the read path, so `mt#4568`,
      // `4568` and `MT-4568` all address the same rows.
      const subjectId = normalizeTaskSubjectId(taskId);
      if (!subjectId) {
        return { released: 0, claims: [], taskId: subjectId };
      }

      const actorId = resolveCallerActorId(callerActorId);
      if (!actorId) {
        // Fail open, and SAY SO rather than returning a bare zero. Deleting rows
        // we cannot attribute to this caller would clear a peer's claim, which
        // is the one thing this command must never do as an ordinary operation.
        return {
          released: 0,
          claims: [],
          taskId: subjectId,
          actorUnavailable: true,
          message:
            "Caller identity could not be resolved — nothing released. Over MCP this means the " +
            "tool is missing from CALLER_ACTOR_ID_TOOL_NAMES in src/mcp/server.ts.",
        };
      }

      try {
        const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
        if (!provider?.getDatabaseConnection) {
          log.debug("[tasks.claims.release] No SQL persistence provider available");
          return { released: 0, claims: [], taskId: subjectId, actorId };
        }

        const db = await provider.getDatabaseConnection();
        const repo = buildPresenceClaimRepository(db);
        if (!repo) {
          log.debug("[tasks.claims.release] Could not build PresenceClaimRepository");
          return { released: 0, claims: [], taskId: subjectId, actorId };
        }

        // Read the caller's rows BEFORE deleting them: the result has to NAME
        // what it removed, so a caller can notice it deleted a claim it does not
        // recognize. That is the observable that makes an actor-misattribution
        // (mt#4440) visible here instead of silent.
        const claims = await repo.listClaims("task", subjectId);
        const own = selectOwnClaims(claims, actorId);

        if (own.length === 0) {
          return {
            released: 0,
            claims: [],
            taskId: subjectId,
            actorId,
            message: `No claim held by ${actorId} on ${subjectId}.`,
          };
        }

        const released = await repo.deleteByIds(own.map((c) => c.id));
        log.debug("presence claim released", { taskId: subjectId, actorId, released });

        return {
          released,
          taskId: subjectId,
          actorId,
          claims: own.map((c) => ({
            actorId: c.actorId,
            claimedAt: c.claimedAt,
            lastRefreshedAt: c.lastRefreshedAt,
          })),
        };
      } catch (err: unknown) {
        log.warn("[tasks.claims.release] Presence claim release failed", {
          taskId: subjectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { released: 0, claims: [], taskId: subjectId, actorId, error: String(err) };
      }
    },
  });
}
