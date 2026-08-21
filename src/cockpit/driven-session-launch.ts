/**
 * Driven-session launch orchestration (mt#2752, Rung 2C).
 *
 * The domain-facing half of task-bound driven-session launch. The host
 * (./driven-session-host.ts) deliberately imports NOTHING from
 * `@minsky/domain` — its invariant is spawn/parse/registry mechanics only —
 * so everything that touches the domain layer lives here instead:
 *
 *   1. {@link resolveTaskWorkspace} — bind-or-create the task's workspace via
 *      the REAL `session_start` machinery (`SessionService.start` →
 *      `startSessionImpl`; no duplicated clone/branch logic), reusing an
 *      existing non-terminal workspace when one exists (the "binds or
 *      creates" semantics from the mt#2752 spec).
 *   2. {@link createDrivenInitObserver} — the `onHarnessSessionLinked`
 *      observer that performs spawn-time identity registration: a durable
 *      `driven_spawn` row in `minsky_session_links` (plus the
 *      `agent_transcripts` FK stub) the moment the child's `system/init`
 *      event yields its harness session id. This is what makes the
 *      workspace detail page resolve the live conversation with ZERO
 *      reliance on cwd matching (spec SC2/AT2) — the link is a first-party
 *      fact recorded at spawn, not an ingest-time inference.
 *
 * Domain access follows the established cockpit conventions: session lookup
 * through `getServerSessionProvider` / task service through
 * `getServerTaskService` (../db-providers.ts, shared connection pool), and
 * heavyweight domain modules via dynamic import at call time (the same
 * pattern as ../widgets/agents.ts's default factories).
 *
 * @see mt#2752 — this module
 * @see ./routes/driven-sessions.ts — the POST route that drives this
 * @see packages/domain/src/transcripts/driven-link-writer.ts — the link write
 * @see src/adapters/shared/commands/tasks/dispatch-command.ts — the sibling
 *   direct-construction consumer of SessionService.start this mirrors
 */

import { randomUUID } from "crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import type { AttachRefusalReason } from "@minsky/domain/conversation-run-state/attach-admissibility";
import type { ConversationId } from "@minsky/domain/ids";
import type { AdoptionReason } from "@minsky/domain/storage/schemas/driven-sessions-schema";
import {
  killIfIdentityMatches,
  probeProcessIdentity,
  type ExecFileFn,
  type ProcessIdentityVerdict,
} from "./process-identity";
import {
  CLAUDE_BINARY,
  DEFAULT_PERMISSION_MODE,
  drivenSessionRegistry,
  resumeDrivenSession,
  buildReconnectingDrivenSessionRecord,
  missingCwdReason,
  probeSpawnCwdAsync,
  type DrivenSessionRecord,
  type DrivenSessionCostSummary,
  type DrivenSessionRegistry,
  type PermissionMode,
  type SpawnFn,
} from "./driven-session-host";
import { drivenSessionMcpServerNames } from "./driven-session-mcp-servers";
import { raceAgainstTimeout } from "@minsky/shared/timeout";
import {
  getServerSessionProvider,
  getServerTaskService,
  getContextInspectorDb,
  createCachedSqlDbGetter,
  describeServerPersistenceUnavailability,
} from "./db-providers";

/** Resolution result: the workspace a task-bound driven session will run in. */
export interface ResolvedTaskWorkspace {
  minskySessionId: string;
  /** Absolute path to the workspace working directory (the child's cwd). */
  sessionDir: string;
  /** True when an existing workspace was reused; false when freshly created. */
  reused: boolean;
}

/**
 * Bind-or-create the workspace for a task (mt#2752 SC1).
 *
 * Reuse branch: an existing session record for the task — whatever its
 * liveness — is reused as-is; driving an existing workspace is exactly the
 * point of the launch surface, and calling `SessionService.start` against it
 * would hard-throw on the healthy-liveness collision check
 * (start-session-operations.ts's precondition; see tasks_dispatch's
 * resume-detection for the sibling workaround).
 *
 * Create branch: no record → the real `session_start` machinery runs (clone,
 * branch, DB row, status walk). The launch declares `launchIntent:
 * "principal-driven"` (mt#2986): a cockpit driven session is the PRINCIPAL
 * live-driving (mt#2750's invariant), so the kind-aware planning gate — which
 * exists to stop unplanned AUTONOMOUS implementation — is exempted. Status
 * side-effects are stage-honest: TODO walks to PLANNING (planning is what's
 * now happening); READY keeps the READY → IN-PROGRESS walk. Errors (task not
 * found, terminal status, git failure) still propagate to the caller — the
 * route surfaces them as an HTTP error body rather than spawning against a
 * guessed directory.
 */
export async function resolveTaskWorkspace(taskId: string): Promise<ResolvedTaskWorkspace> {
  const sessionProvider = await getServerSessionProvider();
  if (!sessionProvider) {
    throw new Error(
      `Session service unavailable — ${await describeServerPersistenceUnavailability()}`
    );
  }

  const existing = await sessionProvider.getSessionByTaskId(taskId);
  if (existing) {
    const { resolveSessionDirectory } = await import(
      "@minsky/domain/session/resolve-session-directory"
    );
    const sessionDir = await resolveSessionDirectory(existing.sessionId, sessionProvider);
    log.info(
      `[driven-session] reusing existing workspace ${existing.sessionId} for ${taskId} (${sessionDir})`
    );
    return { minskySessionId: existing.sessionId, sessionDir, reused: true };
  }

  const taskService = await getServerTaskService();
  if (!taskService) {
    throw new Error(
      `Task service unavailable — ${await describeServerPersistenceUnavailability()}`
    );
  }

  // Mirror tasks_dispatch's direct SessionService construction (the
  // established non-command consumer of session_start machinery) — dynamic
  // imports keep these heavyweight modules off the daemon's boot path.
  const { SessionService } = await import("@minsky/domain/session/session-service");
  const { createGitService } = await import("@minsky/domain/git");
  const { createWorkspaceUtils } = await import("@minsky/domain/workspace");
  const { getRepositoryBackendFromConfig } = await import(
    "@minsky/domain/session/repository-backend-detection"
  );
  const { getCurrentSession } = await import("@minsky/domain/workspace");
  const { execAsync } = await import("@minsky/shared/exec");
  const { resolveSessionDirectory } = await import(
    "@minsky/domain/session/resolve-session-directory"
  );

  const service = new SessionService({
    sessionProvider,
    gitService: createGitService(),
    taskService,
    workspaceUtils: createWorkspaceUtils(sessionProvider),
    getCurrentSession: async (repoPath: string) =>
      (await getCurrentSession(repoPath, execAsync, sessionProvider)) ?? null,
    getRepositoryBackend: getRepositoryBackendFromConfig,
  });

  const session = await service.start({
    task: taskId,
    quiet: true,
    skipInstall: false,
    noStatusUpdate: false,
    launchIntent: "principal-driven",
  });
  if (!session?.sessionId) {
    throw new Error(`session_start returned no sessionId for ${taskId}`);
  }

  const sessionDir = await resolveSessionDirectory(session.sessionId, sessionProvider);
  log.info(`[driven-session] created workspace ${session.sessionId} for ${taskId} (${sessionDir})`);
  return { minskySessionId: session.sessionId, sessionDir, reused: false };
}

/**
 * The harness that owns the conversation id space every driven session runs in.
 *
 * A literal today because the daemon spawns exactly one binary — see
 * `driven-session-host.ts`, which builds a `claude` command line. Recorded as a
 * COLUMN rather than assumed, so a second harness does not silently inherit the
 * first one's id space (mt#4323).
 */
export const DRIVEN_SESSION_HARNESS = "claude_code";

/**
 * Test seam for {@link createDrivenInitObserver} — mirrors the
 * `overrideToken`/`spawnFn` injection convention used across the cockpit.
 */
export interface DrivenInitObserverDeps {
  /**
   * Why this session is adopting this conversation — REQUIRED, and required
   * rather than defaulted on purpose (mt#4323).
   *
   * A default would be wrong at most call sites and silently so: `"initial"`
   * would mislabel every resume, `"resumed"` every fresh spawn. The value is
   * known for certain at construction — a `startDrivenSession` caller is
   * spawning fresh, a `resumeDrivenSession` caller is resuming, and an entity
   * thread additionally knows WHICH {@link FreshSpawnReason} applies — so the
   * type asks each site to say which, and no site has to remember to.
   */
  adoptionReason: AdoptionReason;
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  recordAdoption?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
    input: {
      localId: string;
      harnessSessionId: string;
      harness: string;
      actuatorGeneration?: number;
      adoptionReason: AdoptionReason;
    }
  ) => Promise<unknown>;
  writeLink?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
    input: {
      agentSessionId: string;
      minskySessionId: string;
      cwd: string;
      startedAt: string;
    }
  ) => Promise<unknown>;
}

/**
 * Build the `onHarnessSessionLinked` observer — everything that must be
 * recorded the moment the child's init event yields a conversation id.
 *
 * TWO writes, with DIFFERENT preconditions, and the difference is the whole
 * reason this function was renamed from `createDrivenInitLinkObserver` in
 * mt#4323:
 *
 * 1. **The conversation adoption** (`driven_session_conversations`) — for
 *    EVERY driven session, unconditionally. This is the durable record that a
 *    session adopted this conversation at this instant, and it is what makes a
 *    session's full span survive the `driven_sessions` upsert that overwrites
 *    `harness_session_id` on the next spawn.
 * 2. **The `driven_spawn` link** (`minsky_session_links`) — only when the
 *    record also carries a `minskySessionId`, because that row links a
 *    conversation to a WORKSPACE session and there is nothing to link without
 *    one.
 *
 * **Why the rename mattered rather than being cosmetic.** Under the old name
 * the function was understood as "the link observer", and entity threads
 * therefore did not wire it — correctly, with a documented reason: the
 * `minskySessionId` gate made it a permanent no-op for a thread, which is
 * bound to an entity rather than a workspace. Putting the adoption write
 * behind that same gate would have silently excluded entity threads, which are
 * the exact caller ADR-044 is about. Hoisting the adoption above the gate, and
 * naming the function for both writes, is what lets every driven caller wire
 * ONE observer and get correct coverage — instead of an enumeration of spawn
 * sites that a future fifth caller would have to remember to join.
 *
 * Never throws into the host's stdout handler: the async work is detached and
 * every failure path logs instead.
 */
export function createDrivenInitObserver(
  deps: DrivenInitObserverDeps
): (record: DrivenSessionRecord) => void {
  return (record) => {
    const { harnessSessionId, minskySessionId } = record;
    if (!harnessSessionId) return;

    void (async () => {
      // Resolving the db is itself a failure path, and it MUST stay inside the
      // error boundary (mt#4323). Before the adoption write was hoisted above
      // the `minskySessionId` gate, this call sat inside the link write's own
      // try; hoisting it left it uncovered, which turns any resolution failure
      // into an unhandled rejection on a detached promise — on the host's
      // stdout `init` frame, for every driven session. That is precisely what
      // this function's contract and the spec's `## Invocation path` forbid:
      // a spawn must not fail because its recovery-state write could not.
      //
      // Not hypothetical: the configured provider throws rather than returning
      // null whenever persistence failed to initialize at boot (ADR-035's
      // memoized-failed-initializer class, mt#4383), and under `bun test` it
      // throws by design (mt#3254).
      let db: Awaited<ReturnType<typeof getContextInspectorDb>>;
      try {
        db = await (deps.getDb ?? getContextInspectorDb)();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] could not resolve SQL persistence for ${record.localId}: ${message} ` +
            `— neither the conversation adoption nor the driven_spawn link was recorded`
        );
        return;
      }
      if (!db) {
        log.warn(
          `[driven-session] no SQL persistence available — neither the conversation adoption ` +
            `nor the driven_spawn link for ${record.localId} was recorded`
        );
        return;
      }

      // (1) Adoption — every driven session, no gate.
      try {
        const recordAdoption =
          deps.recordAdoption ??
          (await import("@minsky/domain/transcripts/driven-session-registry-store"))
            .recordConversationAdoption;
        await recordAdoption(db, {
          localId: record.localId,
          harnessSessionId,
          harness: DRIVEN_SESSION_HARNESS,
          actuatorGeneration: record.actuatorGeneration,
          adoptionReason: deps.adoptionReason,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] conversation adoption write failed for ${record.localId}: ${message}`
        );
      }

      // (2) Link — only when there is a workspace session to link to.
      if (!minskySessionId) return;
      try {
        const writeLink =
          deps.writeLink ??
          (await import("@minsky/domain/transcripts/driven-link-writer")).writeDrivenSpawnLink;
        await writeLink(db, {
          agentSessionId: harnessSessionId,
          minskySessionId,
          cwd: record.cwd,
          startedAt: record.startedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] driven_spawn link write failed for ${record.localId}: ${message}`
        );
      }
    })();
  };
}

/**
 * Test seam for {@link createDrivenResultObserver} — mirrors
 * {@link DrivenInitObserverDeps}.
 */
export interface DrivenResultObserverDeps {
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  writeCost?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
    input: import("@minsky/domain/transcripts/driven-session-cost-writer").DrivenSessionCostWriteInput
  ) => Promise<unknown>;
}

/**
 * Build the `onResultSummary` observer (mt#2753, Rung 2D): fire-and-forget
 * persist a per-turn cost/usage row the moment a terminal `result` event
 * yields a summary. Wired for EVERY driven session (task-bound, explicit-cwd,
 * AND untasked "scratch" sessions alike — success criterion 1 says "every
 * driven session"). Never throws into the host's stdout handler — mirrors
 * the init-link observer's error-swallowing convention.
 */
export function createDrivenResultObserver(
  deps: DrivenResultObserverDeps = {}
): (record: DrivenSessionRecord, summary: DrivenSessionCostSummary) => void {
  return (record, summary) => {
    void (async () => {
      try {
        const db = await (deps.getDb ?? getContextInspectorDb)();
        if (!db) {
          log.warn(
            `[driven-session] no SQL persistence available — cost record for ${record.localId} turn ${summary.turnIndex} not recorded`
          );
          return;
        }
        const writeCost =
          deps.writeCost ??
          (await import("@minsky/domain/transcripts/driven-session-cost-writer"))
            .writeDrivenSessionCost;
        await writeCost(db, {
          localId: record.localId,
          harnessSessionId: record.harnessSessionId,
          taskId: record.taskId,
          minskySessionId: record.minskySessionId,
          turnIndex: summary.turnIndex,
          subtype: summary.subtype,
          isError: summary.isError,
          totalCostUsd: summary.totalCostUsd,
          inputTokens: summary.usage?.inputTokens ?? null,
          outputTokens: summary.usage?.outputTokens ?? null,
          cacheCreationInputTokens: summary.usage?.cacheCreationInputTokens ?? null,
          cacheReadInputTokens: summary.usage?.cacheReadInputTokens ?? null,
          durationMs: summary.durationMs,
          durationApiMs: summary.durationApiMs,
          numTurns: summary.numTurns,
          modelUsage: summary.modelUsage,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] cost record write failed for ${record.localId} turn ${summary.turnIndex}: ${message}`
        );
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// Durable driven-session persistence (mt#3038, RFC "Conversation-first drive"
// Phase 1). Three pieces, all fire-and-forget / never-throw (matching the
// two observers above): (1) the onStateChange persist observer, wired into
// EVERY launch shape (task-bound, explicit-cwd, and scratch alike — same
// "every driven session" scope as createDrivenResultObserver — which since
// mt#4323 is also createDrivenInitObserver's scope for its adoption half);
// (2) boot-time
// reconciliation; (3) the restart-recovery resume orchestration the WS route
// (./driven-session-ws.ts) calls on a registry miss.
// ---------------------------------------------------------------------------

/** Test seam for {@link createDrivenSessionPersistObserver} — mirrors the sibling observers' deps convention. */
export interface DrivenSessionPersistObserverDeps {
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  upsert?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
    input: import("@minsky/domain/transcripts/driven-session-registry-store").UpsertDrivenSessionInput
  ) => Promise<unknown>;
}

/**
 * Recover the `--model <alias>` value (mt#3040) from a record's `argv`, if
 * present. `DrivenSessionRecord` has no separate `model` field — the model
 * choice is baked directly into `argv` at spawn time
 * (`buildDrivenSessionArgs`) — so this is the only way to read it back for
 * persistence without adding a redundant field to the host's record shape.
 */
function extractModelFromArgv(argv: readonly string[]): string | null {
  const i = argv.indexOf("--model");
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/**
 * Build the `onStateChange` observer: fire-and-forget upsert the
 * `driven_sessions` row every time the host reports a meaningful transition
 * (spawn, harness-link, exit/crash/error, resume-respawn). This is what
 * makes the in-memory registry a REHYDRATABLE record (RFC minimal-first-slice
 * step 1) — without this wired, a daemon restart has nothing to reconcile
 * from at boot.
 */
export function createDrivenSessionPersistObserver(
  deps: DrivenSessionPersistObserverDeps = {}
): (record: DrivenSessionRecord) => void {
  return (record) => {
    void (async () => {
      try {
        const db = await (deps.getDb ?? getContextInspectorDb)();
        if (!db) {
          log.warn(
            `[driven-session] no SQL persistence available — driven_sessions row for ${record.localId} not recorded`
          );
          return;
        }
        const upsert =
          deps.upsert ??
          (await import("@minsky/domain/transcripts/driven-session-registry-store"))
            .upsertDrivenSessionRecord;
        await upsert(db, {
          localId: record.localId,
          harnessSessionId: record.harnessSessionId,
          cwd: record.cwd,
          permissionMode: record.permissionMode,
          taskId: record.taskId,
          minskySessionId: record.minskySessionId,
          status: record.status,
          unrecoverableReason: record.unrecoverableReason,
          pid: record.pid ?? null,
          // R1 delta #4 — the orphan-cleanup identity pair. Recorded as
          // "<binary> <argv...>" so process-identity.ts's substring check
          // against the live `ps` command line has something meaningful to
          // compare (the live command line always begins with the binary
          // name/path, never the raw argv alone).
          pidCmdline: record.pid ? `${CLAUDE_BINARY} ${record.argv.join(" ")}` : null,
          model: extractModelFromArgv(record.argv),
          actuatorGeneration: record.actuatorGeneration,
          startedAt: record.startedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] driven_sessions persist failed for ${record.localId}: ${message}`
        );
      }
    })();
  };
}

/** Test seam for {@link loadPersistedDrivenSessions}. */
export interface LoadPersistedDrivenSessionsDeps {
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  listNonTerminal?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>
  ) => Promise<import("@minsky/domain/storage/schemas/driven-sessions-schema").DrivenSessionRow[]>;
  registry?: DrivenSessionRegistry;
  /**
   * Write back a terminal verdict this boot determined (mt#3269). Test seam;
   * defaults to the store's `upsertDrivenSessionRecord`.
   */
  persistTerminalVerdict?: typeof import("@minsky/domain/transcripts/driven-session-registry-store").upsertDrivenSessionRecord;
  /**
   * Probe whether a row's workspace still exists. Test seam (mt#4103);
   * defaults to `probeSpawnCwdAsync`. Exists so the "wedged filesystem path"
   * branch is exercisable with a never-resolving promise instead of an actual
   * hung mount.
   */
  probeCwd?: typeof probeSpawnCwdAsync;
  /**
   * Probe whether a row's recorded actuator process is still the one we
   * spawned. Test seam (mt#4255); defaults to `probeProcessIdentity`.
   *
   * Injected as a whole rather than exposing `process-identity.ts`'s own two
   * seams here, so a test drives the VERDICT — which is what this loop
   * branches on — instead of assembling one out of a fake `ps` and a fake
   * `kill`.
   */
  probeActuator?: (pid: number, expectedCmdSubstring: string) => Promise<ProcessIdentityVerdict>;
  /** Override the whole-run stage bound (mt#4103). Tests pass a small value. */
  stageTimeoutMs?: number;
  /** Override the per-row bound (mt#4103). Tests pass a small value. */
  rowTimeoutMs?: number;
  /**
   * Injected timeout signal (mt#4103) — `raceAgainstTimeout`'s own seam.
   *
   * Lets a test drive the "timed out" branch deterministically in well under a
   * millisecond, with no real wall-clock wait and no fake clock: pair a signal
   * that resolves immediately with an operation that never resolves. Without
   * it, asserting a 15s bound would cost 15s.
   */
  timeoutSignal?: (ms: number) => Promise<{ timedOut: true }>;
}

/**
 * Persist a boot-determined `unrecoverable` verdict (mt#3269).
 *
 * Writes back ONLY `status` and `unrecoverableReason`; every other column is
 * carried through from the row as read. The store upserts with
 * `onConflictDoUpdate({ set: values })`, so any field omitted or defaulted here
 * would OVERWRITE the stored one — this function is recording a verdict, not
 * rewriting the record (PR #2383 R1: an earlier draft passed `model: null` and
 * silently destroyed it).
 *
 * That includes `pid`/`pidCmdline`. An earlier draft cleared them on the theory
 * that a stale pid could mislead orphan cleanup; that rationale was wrong.
 * `orchestrateDrivenSessionResume` returns early on both `!harnessSessionId`
 * and `status === "unrecoverable"` BEFORE it takes the lock or touches the pid,
 * so an unrecoverable row never reaches orphan cleanup at all. Nulling them
 * would have destroyed a real record of what ran, for a hazard that cannot occur.
 *
 * Best-effort by design, matching the rest of boot reconciliation: a
 * persistence hiccup must leave the daemon booting with what it did read, not
 * abort startup. The cost of a miss is one more re-read next boot — the exact
 * status quo this fixes — which is strictly better than a daemon that will not
 * start.
 */
async function persistUnrecoverableVerdict(
  db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
  row: import("@minsky/domain/storage/schemas/driven-sessions-schema").DrivenSessionRow,
  reason: string,
  deps: LoadPersistedDrivenSessionsDeps
): Promise<boolean> {
  return persistBootTerminalVerdict(
    db,
    row,
    { status: "unrecoverable", unrecoverableReason: reason, describedAs: "unrecoverable verdict" },
    deps
  );
}

/**
 * Persist a boot-determined `exited` verdict for a row whose ACTUATOR is gone
 * (mt#4255).
 *
 * This is a strictly narrower claim than {@link persistUnrecoverableVerdict}'s,
 * and the distinction is the whole point. `unrecoverable` says the
 * CONVERSATION can never come back; `exited` says only that the PROCESS we
 * recorded is no longer running — which is the ordinary end state of every
 * actuator, and says nothing about the conversation. So `unrecoverableReason`
 * is carried through untouched rather than given a value: that column is the
 * conversation-layer fact, and writing an actuator-layer reason into it would
 * make the next reader think this conversation was condemned.
 *
 * Retiring a row this way costs NOTHING in resumability, which is what makes it
 * safe to do without a staleness policy. `orchestrateDrivenSessionResume` reads
 * the row by `localId` and refuses only on `!harnessSessionId`, `status ===
 * "unrecoverable"`, and a missing cwd — it never inspects `exited`/`crashed`.
 * Its three callers all consult it unconditionally rather than requiring the
 * registry to hold a record first (../cockpit/entity-thread-launch.ts's mt#4093
 * comment names a terminal-status row as the case it fixes;
 * ./principal-channel-actuator.ts resumes by its deterministic id and already
 * treats a terminal record as absent; ./driven-session-ws.ts consults it
 * whenever the registry has no live record). So `principal-channel-standing`
 * retired here resumes on the principal's next message exactly as before.
 *
 * What the write DOES change is boot: `listNonTerminalDrivenSessions` is the
 * only reader of the non-terminal predicate, so an `exited` row stops being
 * registered as `reconnecting` — which is the phantom this exists to end.
 */
async function persistActuatorGoneVerdict(
  db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
  row: import("@minsky/domain/storage/schemas/driven-sessions-schema").DrivenSessionRow,
  verdict: Extract<ProcessIdentityVerdict, "gone" | "not-ours">,
  deps: LoadPersistedDrivenSessionsDeps
): Promise<boolean> {
  const because =
    verdict === "gone"
      ? `no process at recorded pid ${row.pid}`
      : `pid ${row.pid} was reused by an unrelated process`;
  return persistBootTerminalVerdict(
    db,
    row,
    {
      status: "exited",
      unrecoverableReason: row.unrecoverableReason,
      describedAs: `actuator-gone verdict (${because})`,
    },
    deps
  );
}

/** The two columns a boot verdict writes, plus how to name it in the log. */
interface BootTerminalVerdict {
  status: "unrecoverable" | "exited";
  unrecoverableReason: string | null;
  describedAs: string;
}

/**
 * Shared write for both boot-determined terminal verdicts (mt#3269, mt#4255).
 *
 * Writes back ONLY `status` and `unrecoverableReason`; every other column is
 * carried through from the row as read. The store upserts with
 * `onConflictDoUpdate({ set: values })`, so any field omitted or defaulted here
 * would OVERWRITE the stored one — this function is recording a verdict, not
 * rewriting the record (PR #2383 R1: an earlier draft passed `model: null` and
 * silently destroyed it).
 *
 * That includes `pid`/`pidCmdline`. An earlier draft cleared them on the theory
 * that a stale pid could mislead orphan cleanup; that rationale was wrong.
 * `orchestrateDrivenSessionResume` returns early on both `!harnessSessionId`
 * and `status === "unrecoverable"` BEFORE it takes the lock or touches the pid,
 * so an unrecoverable row never reaches orphan cleanup at all. Nulling them
 * would have destroyed a real record of what ran, for a hazard that cannot occur.
 * mt#4255 adds a second reason to keep them: the pair is the EVIDENCE for the
 * `exited` verdict, and a future reader asking "why was this retired?" has
 * nothing to check if the write erases its own basis.
 *
 * Best-effort by design, matching the rest of boot reconciliation: a
 * persistence hiccup must leave the daemon booting with what it did read, not
 * abort startup. The cost of a miss is one more re-read next boot — the exact
 * status quo this fixes — which is strictly better than a daemon that will not
 * start.
 *
 * **Returns whether the write actually LANDED (PR #3126 R1, BLOCKING).**
 * Non-throwing and best-effort are properties of the CONTROL FLOW; they are not
 * a licence to keep the outcome from the caller. This used to return `void`
 * while catching its own failure, so a caller could only assume success — and
 * `reconcilePersistedDrivenSessions` did exactly that, counting a row as
 * `retired` and rendering "retired N" in the operator's one boot line when the
 * upsert had timed out and the row would be re-read on the very next boot. A
 * swallowed error plus a `void` return is how a report comes to assert
 * something nobody checked.
 */
async function persistBootTerminalVerdict(
  db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
  row: import("@minsky/domain/storage/schemas/driven-sessions-schema").DrivenSessionRow,
  verdict: BootTerminalVerdict,
  deps: LoadPersistedDrivenSessionsDeps
): Promise<boolean> {
  try {
    const upsert =
      deps.persistTerminalVerdict ??
      (await import("@minsky/domain/transcripts/driven-session-registry-store"))
        .upsertDrivenSessionRecord;
    await upsert(db, {
      localId: row.localId,
      harnessSessionId: row.harnessSessionId,
      cwd: row.cwd,
      permissionMode: row.permissionMode,
      taskId: row.taskId,
      minskySessionId: row.minskySessionId,
      // The two fields this write exists to change.
      status: verdict.status,
      unrecoverableReason: verdict.unrecoverableReason,
      // Preserved verbatim — see the docblock.
      pid: row.pid,
      pidCmdline: row.pidCmdline,
      model: row.model,
      actuatorGeneration: row.actuatorGeneration,
      startedAt: row.startedAt.toISOString(),
    });
    log.info(
      `[driven-session] boot reconciliation: persisted ${verdict.describedAs} for ${row.localId} ` +
        `(it will no longer be re-read at boot)`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[driven-session] could not persist the ${verdict.describedAs} for ${row.localId}: ${message}`
    );
    return false;
  }
}

/**
 * The stage of boot reconciliation a wall-clock bound applies to (mt#4103).
 *
 * Named per stage rather than bounding the whole function once, because the
 * stages fail for different reasons and the operator's next move differs: a
 * stalled `resolve-db` points at the pool, a stalled `cwd-probe` at a wedged
 * filesystem path. A single "reconciliation timed out" line would say neither.
 */
export type ReconcileStage =
  | "resolve-db"
  | "list-rows"
  | "cwd-probe"
  | "actuator-probe"
  | "persist-verdict";

/**
 * What one boot reconciliation actually did (mt#4103).
 *
 * A VALUE rather than a set of log statements scattered through the function,
 * so the "what do we say about this?" decision is a pure function of it — see
 * {@link describeReconciliationOutcome} — and is testable without a database,
 * a clock, or a captured logger.
 */
export type ReconciliationOutcome =
  | {
      kind: "loaded";
      /**
       * Rows REGISTERED — not rows read (mt#4255).
       *
       * These differ once retirement exists, and the field keeps the meaning
       * its name and its log line always had ("loaded N persisted session(s)").
       * `count + retired` is the number of rows read. A run that reads rows and
       * retires all of them is `loaded` with `count: 0`, which is deliberately
       * NOT `empty` — "there was nothing to load" and "there was something and
       * it is now gone" are different facts, and mt#4103 exists because they
       * once rendered identically.
       */
      count: number;
      /**
       * Rows CONFIRMED persisted `exited` because their actuator was gone
       * (mt#4255).
       *
       * Confirmed, not attempted (PR #3126 R1): a row whose write timed out or
       * failed is counted in neither `retired` nor a silent gap — it is
       * registered normally and its stage appears in `degraded`, because the
       * database still holds it non-terminal and the next boot will re-read it.
       */
      retired: number;
      degraded: ReconcileStage[];
    }
  | { kind: "empty" }
  | { kind: "no-persistence" }
  | { kind: "timed-out"; stage: ReconcileStage; timeoutMs: number }
  | { kind: "failed"; message: string };

/**
 * The single line one boot reconciliation emits, and at what level (mt#4103).
 *
 * EXACTLY one line per boot, on EVERY path — including the zero-rows path,
 * which previously logged nothing at all. That silence is the defect this
 * exists to end: an empty registry because there was nothing to load and an
 * empty registry because the reconciliation never finished rendered
 * identically in the log, so the 2026-08-12 incident could only be diagnosed
 * by noticing an ABSENCE across ten boots. An absence is not a signal.
 *
 * Pure, and deliberately so: it is the one part of this subsystem whose
 * correctness is "does the operator learn the right thing?", which no
 * integration test answers better than a direct assertion on the string.
 */
export function describeReconciliationOutcome(outcome: ReconciliationOutcome): {
  level: "info" | "warn";
  message: string;
} {
  const prefix = "[driven-session] boot reconciliation:";
  switch (outcome.kind) {
    case "loaded": {
      // The retired clause is appended rather than replacing anything, and it
      // is omitted at zero (mt#4255) — retirement is the exceptional event, so
      // a run that retires nothing should read exactly as it did before.
      const retiredClause =
        outcome.retired > 0 ? `, retired ${outcome.retired} whose recorded actuator was gone` : "";
      const base = `${prefix} loaded ${outcome.count} persisted session(s) (reconnecting/unrecoverable)${retiredClause}`;
      if (outcome.degraded.length === 0) return { level: "info", message: base };
      // Loaded, but not cleanly — some rows hit a per-row bound. Reported at
      // WARN because the registry is INCOMPLETE in a way the count alone hides.
      return {
        level: "warn",
        message: `${base} — ${outcome.degraded.length} row(s) degraded (${[...new Set(outcome.degraded)].join(", ")})`,
      };
    }
    case "empty":
      return {
        level: "info",
        message: `${prefix} no non-terminal sessions to load — registry starts empty`,
      };
    case "no-persistence":
      return {
        level: "warn",
        message: `${prefix} no SQL persistence available at boot — skipped, registry starts empty`,
      };
    case "timed-out":
      return {
        level: "warn",
        message: `${prefix} timed out after ${outcome.timeoutMs}ms at stage "${outcome.stage}" — registry starts empty`,
      };
    case "failed":
      return { level: "warn", message: `${prefix} failed: ${outcome.message}` };
  }
}

/**
 * Wall-clock bound for the two whole-run stages — resolving the handle and
 * reading the rows (mt#4103).
 *
 * Grounded in the observed cadence rather than a round number: a healthy
 * reconciliation completed 0.6s after `PersistenceService initialized` on the
 * boots that logged one (measured across 2026-08-12's ten boots). 15s is ~25x
 * that, so it cannot fire on a merely-slow-but-working database, while still
 * bounding a stall to well inside the window in which an operator posts a
 * message and gets a fresh agent instead of their conversation.
 */
const RECONCILE_STAGE_TIMEOUT_MS = 15_000;

/**
 * Wall-clock bound for the PER-ROW stages (mt#4103).
 *
 * Much tighter, and it has to be: these run once per row, so a shared budget
 * would let twenty slow rows consume the whole run. A `stat` on a local path
 * answers in single-digit milliseconds; 2s is generous for that and short
 * enough that even every row timing out keeps the run bounded.
 */
const RECONCILE_ROW_TIMEOUT_MS = 2_000;

/**
 * Boot reconciliation's own database handle (mt#4103).
 *
 * `cacheNegative: false`, unlike the shared `getContextInspectorDb` this used
 * to borrow. That getter LATCHES a null probe for the process lifetime, so a
 * database blip at boot — exactly the condition present during the 2026-08-12
 * incident — disables reconciliation for as long as the daemon runs, with no
 * later call able to recover it.
 *
 * A CALLER-SCOPED getter rather than flipping the shared one: that singleton
 * has ~25 call sites across cockpit routes and widgets, and at least one of
 * them documents the latching as a deliberate contrast
 * (`routes/conversation-run-state.ts`). Changing it here would change all of
 * them as a side effect. `getEntityThreadDb` (`routes/entity-threads.ts`) is
 * the established precedent for exactly this move, with the same reasoning.
 *
 * Cheap: `createCachedSqlDbGetter` resolves through the shared
 * `getCachedPersistenceProvider`, so this is a second CACHE over one pool, not
 * a second pool.
 */
export const getBootReconciliationDb = createCachedSqlDbGetter({ cacheNegative: false });

/**
 * Boot-time reconciliation (RFC minimal-first-slice step 2): load every
 * non-terminal persisted `driven_sessions` row and register it in the
 * in-memory registry as `"reconnecting"` (or `"unrecoverable"` for a row that
 * never got a harness session id linked — spawn-died-before-init, R1 delta
 * #2) — WITHOUT spawning anything (R1 delta #6, lazy-resume-only: a respawn
 * only happens later, via {@link orchestrateDrivenSessionResume} on an
 * operator action or client reconnect). Call once at daemon startup, after
 * persistence is confirmed ready. Never throws; a failure here means the
 * daemon boots with an empty registry (the pre-mt#3038 behavior), not a
 * crashed boot.
 *
 * ## Every await is bounded, and every boot says what happened (mt#4103)
 *
 * This is fire-and-forget from `start-command.ts` — nothing awaits it, and
 * nothing times it out. So an await that never settles here does not fail; it
 * simply never finishes, leaving the registry empty for the daemon's whole
 * life while every one of this function's log lines stays unwritten. That is
 * not hypothetical: on 2026-08-12 two of ten boots produced NONE of the four
 * outcomes this function could emit, and the resulting empty registry is what
 * let an entity thread silently swap its agent (mt#4093).
 *
 * There were four unbounded awaits, two of them per-row — the handle, the
 * SELECT, a bare `stat` per row, and a verdict write per row. Each is now
 * raced against a bound via `raceAgainstTimeout`, and the per-row ones degrade
 * that ROW rather than the run, so one wedged workspace path cannot cost the
 * registry.
 */
export async function loadPersistedDrivenSessions(
  deps: LoadPersistedDrivenSessionsDeps = {}
): Promise<number> {
  const outcome = await reconcilePersistedDrivenSessions(deps);
  const { level, message } = describeReconciliationOutcome(outcome);
  // The one line, on every path. `log[level]` rather than a branch so a future
  // outcome kind cannot be added with no line at all — the describer owns the
  // level, and this call site owns nothing it could forget.
  log[level](message);
  return outcome.kind === "loaded" ? outcome.count : 0;
}

/**
 * The IO half of {@link loadPersistedDrivenSessions}; returns what happened
 * rather than logging it.
 *
 * Exported for tests, and the split is what makes them possible: every outcome
 * this subsystem can reach is now a RETURN VALUE, so the stall branches are
 * assertable without capturing the logger or waiting out a real 15s bound.
 */
export async function reconcilePersistedDrivenSessions(
  deps: LoadPersistedDrivenSessionsDeps
): Promise<ReconciliationOutcome> {
  try {
    const dbResult = await raceAgainstTimeout(
      (deps.getDb ?? getBootReconciliationDb)(),
      deps.stageTimeoutMs ?? RECONCILE_STAGE_TIMEOUT_MS,
      deps.timeoutSignal
    );
    if (dbResult.timedOut) {
      return {
        kind: "timed-out",
        stage: "resolve-db",
        timeoutMs: deps.stageTimeoutMs ?? RECONCILE_STAGE_TIMEOUT_MS,
      };
    }
    const db = dbResult.value;
    if (!db) {
      return { kind: "no-persistence" };
    }
    const listNonTerminal =
      deps.listNonTerminal ??
      (await import("@minsky/domain/transcripts/driven-session-registry-store"))
        .listNonTerminalDrivenSessions;
    const stageTimeoutMs = deps.stageTimeoutMs ?? RECONCILE_STAGE_TIMEOUT_MS;
    const rowTimeoutMs = deps.rowTimeoutMs ?? RECONCILE_ROW_TIMEOUT_MS;
    const rowsResult = await raceAgainstTimeout(
      listNonTerminal(db),
      stageTimeoutMs,
      deps.timeoutSignal
    );
    if (rowsResult.timedOut) {
      return { kind: "timed-out", stage: "list-rows", timeoutMs: stageTimeoutMs };
    }
    const rows = rowsResult.value;
    const registry = deps.registry ?? drivenSessionRegistry;
    // Which per-row stages degraded, if any. Collected rather than logged
    // per-row: twenty wedged rows should produce one honest summary line, not
    // twenty lines an operator scrolls past.
    const degraded: ReconcileStage[] = [];
    /** Rows persisted `exited` and skipped rather than registered (mt#4255). */
    let retired = 0;

    for (const row of rows) {
      // Two independent reasons a persisted row can never be resumed. The
      // first shipped with mt#3038; the second (mt#3397) was named in the
      // `unrecoverable` docblock from the start but checked by nothing, so a
      // row whose workspace had been deleted stayed `reconnecting` and
      // re-crashed on every resume attempt, forever.
      const noTranscript = row.harnessSessionId === null;
      // Async probe (PR #2452 R1): this loop runs over every non-terminal row at
      // daemon boot, so a synchronous stat here would hold the event loop for as
      // long as the slowest workspace path takes to answer.
      // Bounded (mt#4103). This is a bare `await stat(cwd)`; its own error
      // classifier anticipates "a hung mount's ETIMEDOUT", so a stalling
      // filesystem was a known case — but nothing bounded the WAIT, only the
      // error, and a `stat` on a wedged mount can block without ever erroring.
      // A timeout degrades to the SAME verdict a permission/IO error already
      // produces: not-missing, so the row stays `reconnecting` rather than
      // being retired on a transient fault. Failing open is the established
      // direction here, and a timeout is exactly the "cannot tell" case.
      const cwdProbe = await raceAgainstTimeout(
        (deps.probeCwd ?? probeSpawnCwdAsync)(row.cwd),
        rowTimeoutMs,
        deps.timeoutSignal
      );
      if (cwdProbe.timedOut) degraded.push("cwd-probe");
      const cwdGone = !cwdProbe.timedOut && cwdProbe.value === "missing";
      const unrecoverableReason = noTranscript
        ? "spawn-died-before-init — no harness session id was ever linked; there is no transcript to resume"
        : cwdGone
          ? missingCwdReason(row.cwd)
          : null;
      const resumable = unrecoverableReason === null;

      // mt#4255 — the THIRD retirement test, and the only one that can fire on
      // an ordinary row.
      //
      // The two above ask whether the CONVERSATION is recoverable; both are
      // properties a row either has from birth (no transcript) or acquires once
      // (deleted workspace), so neither can ever fire on a row whose transcript
      // and workspace are intact. Measured against prod on 2026-08-18, that was
      // ALL 23 non-terminal rows — 21 of them in the main repo, a cwd that by
      // construction never disappears. They were not escaping a sweep; they were
      // outside the reach of both tests by construction, and no number of
      // reboots would ever have retired one.
      //
      // This test asks a different question — is the ACTUATOR still there? —
      // and its answer is already recorded on every row: `pid` + `pidCmdline`,
      // the orphan-cleanup identity pair (RFC "Conversation-first drive" R1
      // delta #4). Identity, not bare liveness, and the difference is not
      // academic: of those 23 rows, 22 pids were dead and the 23rd was ALIVE as
      // an unrelated desktop app that had inherited the number over an 18-day
      // gap. A `kill(pid, 0)` check alone would have called that row live
      // forever.
      //
      // The same property makes the sanctioned dual-daemon dev loop safe (the
      // RFC records that running a dev cockpit beside the tray daemon is
      // routine): a second daemon booting while the first holds live children
      // finds their pids alive AND matching, and leaves every row alone.
      //
      // Fail-open on both no-pid and `unknown`, matching what `probeSpawnCwd`
      // does one branch up: a row is retired only on a DEFINITIVE answer, never
      // on the probe's own failure to produce one.
      let actuatorVerdict: ProcessIdentityVerdict | "not-probed" = "not-probed";
      if (resumable && row.pid !== null) {
        // Bounded like its sibling probe (mt#4103): `ps` on a loaded machine is
        // not guaranteed to be fast, and this runs per row at boot.
        const probe = await raceAgainstTimeout(
          (deps.probeActuator ?? probeProcessIdentity)(row.pid, row.pidCmdline ?? CLAUDE_BINARY),
          rowTimeoutMs,
          deps.timeoutSignal
        );
        if (probe.timedOut) degraded.push("actuator-probe");
        else actuatorVerdict = probe.value;
      }
      // Narrowed by the condition itself rather than via a boolean plus a cast,
      // so `persistActuatorGoneVerdict`'s two-verdict parameter type stays
      // checked at the call site.
      if (actuatorVerdict === "gone" || actuatorVerdict === "not-ours") {
        // Retired, and deliberately NOT registered — unlike the `unrecoverable`
        // branch below, which registers so the WS route can render the
        // transcript read-only with its reason. There is no such thing to show
        // here: the conversation is fine and simply has no actuator, which is
        // the same state as the 55 rows already sitting terminal in this table.
        // Skipping registration is what makes the phantom disappear on THIS
        // boot rather than the next one.
        //
        // BOTH of those depend on the write actually LANDING (PR #3126 R1,
        // BLOCKING), so neither happens until it is confirmed. An unconfirmed
        // write leaves the row non-terminal in the database, which means the
        // next boot re-reads it — so counting it `retired` would put a claim in
        // the operator's one boot line ("retired N") that the durable state
        // contradicts, and skipping registration would additionally hide a row
        // that is still live as far as persistence is concerned. On a failure
        // this falls through to the ordinary registration below, leaving the
        // registry consistent with what is actually stored and recording the
        // stage in `degraded`.
        const verdict = await raceAgainstTimeout(
          persistActuatorGoneVerdict(db, row, actuatorVerdict, deps),
          rowTimeoutMs,
          deps.timeoutSignal
        );
        if (verdict.timedOut || !verdict.value) {
          degraded.push("persist-verdict");
        } else {
          retired += 1;
          continue;
        }
      }
      const record = buildReconnectingDrivenSessionRecord({
        localId: row.localId,
        harnessSessionId: row.harnessSessionId,
        cwd: row.cwd,
        permissionMode: row.permissionMode as PermissionMode,
        taskId: row.taskId,
        minskySessionId: row.minskySessionId,
        status: resumable ? "reconnecting" : "unrecoverable",
        unrecoverableReason,
        actuatorGeneration: row.actuatorGeneration,
        startedAt: row.startedAt.toISOString(),
      });
      registry.register(record);

      // mt#3269 — WRITE THE VERDICT BACK, for the unrecoverable case only.
      //
      // Without this the classification above is computed and discarded: the
      // row keeps its non-terminal status, so the next boot re-reads it,
      // re-derives the identical verdict, and re-registers it — forever. The
      // table grows without bound, and the cockpit's session list shows
      // phantom sessions that can never resolve.
      //
      // Only the `unrecoverable` branch is persisted, and deliberately so: a
      // null `harnessSessionId` means there is no transcript and never will be,
      // so the verdict provably cannot change on a later boot. A `reconnecting`
      // row is a DIFFERENT question — "is this still worth offering to
      // resume?" — which depends on a staleness policy nobody has decided
      // (spec §Scope). Guessing a timeout here would silently reap
      // conversations the principal may still want.
      //
      // mt#3397 extends this to the deleted-cwd verdict, which meets the same
      // bar for a different reason: it is an OBSERVED FACT about the
      // filesystem, not a policy judgment, and a Minsky workspace path is a
      // session id — once deleted, nothing recreates that exact directory. The
      // precision that makes this safe lives in `probeSpawnCwd`, which returns
      // "missing" ONLY on a definitive ENOENT/ENOTDIR; a permission or I/O
      // error reads as "unknown" and leaves the row `reconnecting` rather than
      // retiring a conversation over a transient fault.
      if (!resumable) {
        // Bounded (mt#4103), and AFTER `registry.register` above deliberately:
        // the row is already in the registry, so a stalled write costs the
        // durable verdict — which the next boot simply re-derives — and not
        // the registration, which is what the whole reconciliation is for.
        const verdict = await raceAgainstTimeout(
          persistUnrecoverableVerdict(db, row, record.unrecoverableReason ?? "unrecoverable", deps),
          rowTimeoutMs,
          deps.timeoutSignal
        );
        if (verdict.timedOut) degraded.push("persist-verdict");
      }
    }

    // `empty` is a DISTINCT outcome, not a zero-count `loaded` (mt#4103). It
    // used to log nothing at all, which made "nothing to load" and "never
    // finished" the same observation.
    if (rows.length === 0) return { kind: "empty" };
    // `count` is rows REGISTERED, so a retired row is not counted as loaded
    // (mt#4255) — see the field's own docblock for why an all-retired run is
    // still `loaded` with `count: 0` rather than `empty`.
    return { kind: "loaded", count: rows.length - retired, retired, degraded };
  } catch (err) {
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Discriminated outcome of {@link orchestrateDrivenSessionResume}. */
export type DrivenSessionResumeOutcome =
  | { outcome: "resumed"; record: DrivenSessionRecord }
  | { outcome: "locked" }
  | {
      outcome: "unrecoverable";
      reason: string;
      /**
       * The conversation that cannot be resumed, when the row names one
       * (mt#4093). Absent for the spawn-died-before-init case, where the row
       * never linked a conversation at all — the distinction matters to a
       * caller that has to tell the operator WHICH conversation it is about to
       * replace, because there is nothing to name in that case and a fresh
       * spawn replaces nothing the operator ever saw.
       */
      harnessSessionId?: string;
    }
  | { outcome: "not-found" };

/** Test seam for {@link orchestrateDrivenSessionResume}. */
export interface OrchestrateDrivenSessionResumeDeps {
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  getPersisted?: (
    db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>,
    localId: string
  ) => Promise<
    import("@minsky/domain/storage/schemas/driven-sessions-schema").DrivenSessionRow | null
  >;
  withResumeLock?: typeof import("@minsky/domain/transcripts/driven-session-registry-store").withDrivenSessionResumeLock;
  registry?: DrivenSessionRegistry;
  spawnFn?: SpawnFn;
  command?: string;
  /** Test seam for the orphan-cleanup identity check (R1 delta #4) — overrides `ps`. */
  execFileFn?: ExecFileFn;
  /** Test seam — overrides the orphan-cleanup kill call itself (bypasses `killIfIdentityMatches`
   * entirely; asserts call args instead of shelling out to a fake `ps`). */
  killOrphan?: typeof killIfIdentityMatches;
  /** Write back a terminal verdict this resume attempt determined (mt#3397 —
   * the deleted-cwd case). Test seam; same contract as the boot-reconciliation
   * dep of the same name. */
  persistTerminalVerdict?: LoadPersistedDrivenSessionsDeps["persistTerminalVerdict"];
}

/**
 * The restart-recovery orchestration (RFC minimal-first-slice step 3): given
 * a `localId` the in-memory registry has no LIVE record for (a boot-loaded
 * `"reconnecting"` placeholder, or a genuinely unknown id the WS route
 * checks persistence for), look up the persisted row and — if resumable —
 * acquire the cross-process resume lock (R1 delta #1, BINDING) before
 * calling `resumeDrivenSession`. The lock is what makes this SAFE to call
 * from two daemons racing the same conversation id (routine in this
 * project's dev loop — see src/cockpit/CLAUDE.md §Operator dev loop).
 *
 * Wires the SAME init-link/result/persist observers a fresh task-bound
 * launch would (../routes/driven-sessions.ts) so a resumed session keeps
 * recording driven_spawn links, cost rows, and its own driven_sessions row
 * exactly like an original spawn.
 */
export async function orchestrateDrivenSessionResume(
  localId: string,
  deps: OrchestrateDrivenSessionResumeDeps = {}
): Promise<DrivenSessionResumeOutcome> {
  const db = await (deps.getDb ?? getContextInspectorDb)();
  if (!db) return { outcome: "not-found" };

  const getPersisted =
    deps.getPersisted ??
    (await import("@minsky/domain/transcripts/driven-session-registry-store"))
      .getDrivenSessionRecord;
  const row = await getPersisted(db, localId);
  if (!row) return { outcome: "not-found" };

  if (!row.harnessSessionId) {
    return {
      outcome: "unrecoverable",
      reason:
        "spawn-died-before-init — no harness session id was ever linked; there is no transcript to resume",
    };
  }
  if (row.status === "unrecoverable") {
    return {
      outcome: "unrecoverable",
      reason: row.unrecoverableReason ?? "unrecoverable",
      harnessSessionId: row.harnessSessionId,
    };
  }
  // mt#3397 — the workspace this conversation ran in is gone, so there is
  // nothing to resume INTO. Checked here, before the resume lock and the
  // orphan-cleanup kill, because both are wasted work for a session that
  // cannot come back; `resumeDrivenSession` carries the same preflight as the
  // chokepoint for its other callers. The verdict is written back so the next
  // attempt short-circuits on the `row.status` check just above rather than
  // re-probing the filesystem forever.
  if ((await probeSpawnCwdAsync(row.cwd)) === "missing") {
    const reason = missingCwdReason(row.cwd);
    await persistUnrecoverableVerdict(db, row, reason, {
      persistTerminalVerdict: deps.persistTerminalVerdict,
    });
    return { outcome: "unrecoverable", reason, harnessSessionId: row.harnessSessionId };
  }

  const withResumeLock =
    deps.withResumeLock ??
    (await import("@minsky/domain/transcripts/driven-session-registry-store"))
      .withDrivenSessionResumeLock;
  const registry = deps.registry ?? drivenSessionRegistry;
  const harnessSessionId = row.harnessSessionId;

  const lockOutcome = await withResumeLock(db, harnessSessionId, async () => {
    // R1 expert-review delta #4 (BINDING) — orphan cleanup: the persisted
    // `pid` may belong to a process from the PRIOR daemon lifetime that is
    // somehow still alive (e.g. a detached-but-not-yet-reaped child) at the
    // exact moment of this resume. Verify PID+command-line IDENTITY before
    // ever killing it — never a bare `kill(pid)` (PID reuse over a
    // multi-day idle gap). Best-effort: a failed/skipped kill does NOT
    // block the resume itself — `--resume` against a still-live prior
    // actuator races the SAME transcript file, which is exactly the
    // scenario this cleanup exists to prevent, but a kill that can't be
    // confirmed safe must still let a genuinely-dead PID's resume proceed.
    if (row.pid) {
      const killOrphan = deps.killOrphan ?? killIfIdentityMatches;
      // Reviewer round 2 (PR #2179) non-blocking — prefer the FULL
      // persisted command line over the bare binary name when available;
      // it's a strictly tighter identity check (the persisted argv is
      // basically never going to coincidentally match an unrelated
      // process). Failing to match only ever means "skip the kill" (the
      // fail-SAFE direction per killIfIdentityMatches's own contract), so
      // being stricter here never makes cleanup less safe — at worst it
      // skips a cleanup that would have been legitimate.
      const identitySubstring = row.pidCmdline ?? CLAUDE_BINARY;
      try {
        await killOrphan(row.pid, identitySubstring, "SIGKILL", deps.execFileFn);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          `[driven-session] orphan-cleanup kill attempt failed for pid ${row.pid} (localId=${row.localId}): ${message}`
        );
      }
    }

    const { record } = resumeDrivenSession({
      // mt#4239: a resume must re-resolve the SAME server set a start would, or
      // the conversation silently loses tools at the first daemon restart.
      mcpServerNames: drivenSessionMcpServerNames(),
      previous: {
        localId: row.localId,
        cwd: row.cwd,
        permissionMode: row.permissionMode as PermissionMode,
        harnessSessionId,
        taskId: row.taskId,
        minskySessionId: row.minskySessionId,
        startedAt: row.startedAt.toISOString(),
        actuatorGeneration: row.actuatorGeneration,
        model: row.model,
      },
      // mt#4323: a `resumeDrivenSession` call — by construction the session is
      // re-adopting a conversation it already had, not spawning a fresh one.
      onHarnessSessionLinked: createDrivenInitObserver({ adoptionReason: "resumed" }),
      onResultSummary: createDrivenResultObserver(),
      onStateChange: createDrivenSessionPersistObserver(),
      registry,
      spawnFn: deps.spawnFn,
      command: deps.command,
    });
    return record;
  });

  if (!lockOutcome.acquired) return { outcome: "locked" };
  return { outcome: "resumed", record: lockOutcome.result };
}

/** Discriminated outcome of {@link orchestrateDrivenSessionAttach} (mt#3095). */
export type DrivenSessionAttachOutcome =
  | { outcome: "attached"; record: DrivenSessionRecord }
  | { outcome: "locked" }
  | { outcome: "refused"; reason: AttachRefusalReason; message: string; presence: string }
  | { outcome: "no-transcript" };

/** Test seam for {@link orchestrateDrivenSessionAttach}. */
export interface OrchestrateDrivenSessionAttachDeps {
  getDb?: () => Promise<PostgresJsDatabase | null>;
  withResumeLock?: typeof import("@minsky/domain/transcripts/driven-session-registry-store").withDrivenSessionResumeLock;
  registry?: DrivenSessionRegistry;
  spawnFn?: SpawnFn;
  command?: string;
  /** Resolve the conversation's on-disk location. Overridden in tests to avoid touching `~/.claude`. */
  locateConversation?: (
    conversationId: string
  ) => Promise<{ jsonlPath: string; cwd: string | undefined } | null>;
  /** Read the conversation's current presence. Overridden in tests. */
  readPresence?: (
    db: PostgresJsDatabase,
    conversationId: string
  ) => Promise<import("@minsky/domain/conversation-run-state/presence").ConversationPresence>;
  /** Mint the actuator's local id. Overridden in tests for a deterministic id. */
  newLocalId?: () => string;
}

/**
 * Attach an input actuator to a conversation Minsky did NOT spawn (mt#3095) —
 * the Phase 2 capability: an operator's terminal-started `claude` becomes
 * drivable from the cockpit.
 *
 * ## This is deliberately {@link orchestrateDrivenSessionResume} with two substitutions
 *
 * Resume and attach are the same operation on different inputs — "put an
 * actuator on this conversation id in this cwd". So this reuses that path's
 * machinery verbatim (the cross-process lock, `resumeDrivenSession`, and the
 * same three observers, so an attached conversation records driven_spawn links,
 * cost rows, and its own `driven_sessions` row exactly like a spawned one). The
 * two differences:
 *
 * 1. **Where `{cwd, harnessSessionId}` comes from.** Resume reads a persisted
 *    `driven_sessions` row; a foreign conversation has none, so this reads the
 *    on-disk transcript — the same `~/.claude/projects/**` tree the observe rung
 *    already tails.
 * 2. **The presence gate.** Resume owns its record and knows no other actuator
 *    holds it. Attach cannot assume that, so it refuses unless
 *    {@link attachAdmissibility} admits. See that module for why refusing on
 *    absent telemetry is the safe direction.
 *
 * ## Two writer classes, two mechanisms
 *
 * The advisory lock (mt#3038) and the presence gate guard DIFFERENT writers and
 * neither subsumes the other. The lock is Minsky-internal: it stops two cockpit
 * actuators racing. It cannot see a `claude` the operator started in a terminal,
 * because that process never takes it. The presence gate covers exactly that
 * blind spot, using hook telemetry the terminal process emits without knowing
 * anyone is watching. Both are required; dropping either reopens a fork path.
 *
 * The gate is checked BEFORE the lock deliberately: a refusal is the common
 * case for a live conversation, and it costs one read rather than a lock
 * acquisition. The ordering is safe because the lock still guards the
 * Minsky-internal race independently — a second cockpit attach that slips past
 * the same presence read still loses the lock.
 *
 * @see packages/domain/src/conversation-run-state/attach-admissibility.ts
 * @see mt#3095 — this function
 */
export async function orchestrateDrivenSessionAttach(
  conversationId: string,
  deps: OrchestrateDrivenSessionAttachDeps = {}
): Promise<DrivenSessionAttachOutcome> {
  // Transcript existence is settled FIRST, before anything touches the database
  // (PR #2466 R1). "There is no such conversation" is a different answer from
  // "there is one and you may not have it right now", and which one a caller
  // gets should not depend on database availability — previously an unknown id
  // during a DB outage reported `refused` (409), naming a risk that cannot
  // exist for a conversation with no transcript.
  const locate = deps.locateConversation ?? locateConversationTranscript;
  const located = await locate(conversationId);
  if (!located) return { outcome: "no-transcript" };
  if (!located.cwd) {
    // A transcript with no recoverable cwd cannot be resumed — `claude --resume`
    // has nowhere to run. Reported as no-transcript rather than refused: this is
    // "cannot attach at all", not "not right now".
    log.warn(
      `[driven-session] attach: transcript for ${conversationId} has no recoverable cwd (${located.jsonlPath})`
    );
    return { outcome: "no-transcript" };
  }

  const db = await (deps.getDb ?? getContextInspectorDb)();
  // No DB means no presence telemetry, and no telemetry is a REFUSAL, not a
  // pass — the same direction attachAdmissibility takes for `UNKNOWN`. Failing
  // open here would make a transient DB outage silently license the fork this
  // whole path exists to prevent. Reached only for a conversation that DOES
  // exist on disk, so the refusal is about a real attach target.
  if (!db) {
    const { attachAdmissibility } = await import(
      "@minsky/domain/conversation-run-state/attach-admissibility"
    );
    const verdict = attachAdmissibility("UNKNOWN");
    if (verdict.admit) throw new Error("unreachable — UNKNOWN never admits");
    return {
      outcome: "refused",
      reason: verdict.reason,
      message: verdict.message,
      presence: "UNKNOWN",
    };
  }

  const readPresence = deps.readPresence ?? defaultReadPresence;
  const presence = await readPresence(db, conversationId);
  const { attachAdmissibility } = await import(
    "@minsky/domain/conversation-run-state/attach-admissibility"
  );
  const verdict = attachAdmissibility(presence);
  if (!verdict.admit) {
    log.info(
      `[driven-session] attach refused for ${conversationId}: presence=${presence} reason=${verdict.reason}`
    );
    return { outcome: "refused", reason: verdict.reason, message: verdict.message, presence };
  }

  const withResumeLock =
    deps.withResumeLock ??
    (await import("@minsky/domain/transcripts/driven-session-registry-store"))
      .withDrivenSessionResumeLock;
  const registry = deps.registry ?? drivenSessionRegistry;
  const cwd = located.cwd;

  // Keyed on the CONVERSATION id, matching the resume path — that is what makes
  // the two mutually exclusive rather than each locking its own namespace.
  const lockOutcome = await withResumeLock(db, conversationId, async () => {
    const { record } = resumeDrivenSession({
      // mt#4239: a resume must re-resolve the SAME server set a start would, or
      // the conversation silently loses tools at the first daemon restart.
      mcpServerNames: drivenSessionMcpServerNames(),
      previous: {
        // A fresh actuator id. The conversation id is the durable key; the
        // localId is this process's handle on it, and an attached conversation
        // has never had one. Passing `harnessSessionId` up front (unlike a
        // spawn, which learns it at `init`) is what puts the record into the
        // registry's `byHarnessId` map immediately — so `registry.get(<uuid>)`
        // resolves it with no id-space change anywhere else (mt#3095 SC2).
        localId: (deps.newLocalId ?? randomUUID)(),
        cwd,
        permissionMode: DEFAULT_PERMISSION_MODE,
        harnessSessionId: conversationId,
        // A foreign conversation carries no Minsky task/workspace binding. Left
        // null rather than guessed — a wrong binding would mis-attribute cost
        // rows and driven_spawn links to a task that never ran this work.
        taskId: null,
        minskySessionId: null,
        startedAt: new Date().toISOString(),
        actuatorGeneration: 0,
        model: null,
      },
      // mt#4323: a `resumeDrivenSession` call — by construction the session is
      // re-adopting a conversation it already had, not spawning a fresh one.
      onHarnessSessionLinked: createDrivenInitObserver({ adoptionReason: "resumed" }),
      onResultSummary: createDrivenResultObserver(),
      onStateChange: createDrivenSessionPersistObserver(),
      registry,
      spawnFn: deps.spawnFn,
      command: deps.command,
    });
    return record;
  });

  if (!lockOutcome.acquired) return { outcome: "locked" };
  return { outcome: "attached", record: lockOutcome.result };
}

/**
 * Production conversation locator — the observe rung's own transcript source.
 *
 * Exported (mt#3453) so the WS channel's history replay resolves a
 * conversation's transcript through the SAME lookup the attach path uses,
 * rather than growing a second one that could disagree about where a
 * conversation lives.
 */
export async function locateConversationTranscript(
  conversationId: string
): Promise<{ jsonlPath: string; cwd: string | undefined } | null> {
  const { ClaudeCodeTranscriptSource } = await import(
    "@minsky/domain/transcripts/claude-code-transcript-source"
  );
  const source = new ClaudeCodeTranscriptSource();
  // Re-mint at the boundary, per `packages/domain/src/ids.ts`'s "wire format:
  // plain string; re-mint on inbound parse" contract and the same cast
  // `routes/conversations.ts:165` uses on its inbound id.
  const session = await source.locateSession(conversationId as ConversationId);
  if (!session) return null;
  return { jsonlPath: session.jsonlPath, cwd: session.cwd };
}

/** Production presence reader — mt#3201's derivation over the hook-fed run-state row. */
async function defaultReadPresence(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<import("@minsky/domain/conversation-run-state/presence").ConversationPresence> {
  const [{ getConversationRunState }, { derivePresence }] = await Promise.all([
    import("@minsky/domain/conversation-run-state/read"),
    import("@minsky/domain/conversation-run-state/presence"),
  ]);
  const row = await getConversationRunState(db, conversationId);
  return derivePresence(row, new Date()).presence;
}
