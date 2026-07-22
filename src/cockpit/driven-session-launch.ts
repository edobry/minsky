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
 *   2. {@link createDrivenInitLinkObserver} — the `onHarnessSessionLinked`
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

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { killIfIdentityMatches, type ExecFileFn } from "./process-identity";
import {
  CLAUDE_BINARY,
  drivenSessionRegistry,
  resumeDrivenSession,
  buildReconnectingDrivenSessionRecord,
  type DrivenSessionRecord,
  type DrivenSessionCostSummary,
  type DrivenSessionRegistry,
  type PermissionMode,
  type SpawnFn,
} from "./driven-session-host";
import {
  getServerSessionProvider,
  getServerTaskService,
  getContextInspectorDb,
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
    throw new Error("Session service unavailable — persistence provider not ready");
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
    throw new Error("Task service unavailable — persistence provider not ready");
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
 * Test seam for {@link createDrivenInitLinkObserver} — mirrors the
 * `overrideToken`/`spawnFn` injection convention used across the cockpit.
 */
export interface DrivenInitLinkObserverDeps {
  /** Simplified test-seam signature (deliberately NOT `typeof getContextInspectorDb`
   * — that type also requires the production-only `__resetForTests` method,
   * which a plain test fake shouldn't need to implement). */
  getDb?: () => Promise<PostgresJsDatabase | null>;
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
 * Build the `onHarnessSessionLinked` observer for a task-bound launch:
 * fire-and-forget the durable `driven_spawn` link write the moment the init
 * event yields the harness session id. Never throws into the host's stdout
 * handler (the async work is detached and every failure path logs instead).
 */
export function createDrivenInitLinkObserver(
  deps: DrivenInitLinkObserverDeps = {}
): (record: DrivenSessionRecord) => void {
  return (record) => {
    const { harnessSessionId, minskySessionId } = record;
    if (!harnessSessionId || !minskySessionId) return;

    void (async () => {
      try {
        const db = await (deps.getDb ?? getContextInspectorDb)();
        if (!db) {
          log.warn(
            `[driven-session] no SQL persistence available — driven_spawn link for ${record.localId} not recorded`
          );
          return;
        }
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
 * {@link DrivenInitLinkObserverDeps}.
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
 * driven session"; unlike {@link createDrivenInitLinkObserver}, this is not
 * task-bound-only). Never throws into the host's stdout handler — mirrors
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
// "every driven session" scope as createDrivenResultObserver, unlike the
// task-bound-only createDrivenInitLinkObserver); (2) boot-time
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
}

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
 */
export async function loadPersistedDrivenSessions(
  deps: LoadPersistedDrivenSessionsDeps = {}
): Promise<number> {
  try {
    const db = await (deps.getDb ?? getContextInspectorDb)();
    if (!db) {
      log.warn("[driven-session] no SQL persistence available at boot — skipping reconciliation");
      return 0;
    }
    const listNonTerminal =
      deps.listNonTerminal ??
      (await import("@minsky/domain/transcripts/driven-session-registry-store"))
        .listNonTerminalDrivenSessions;
    const rows = await listNonTerminal(db);
    const registry = deps.registry ?? drivenSessionRegistry;

    for (const row of rows) {
      const resumable = row.harnessSessionId !== null;
      const record = buildReconnectingDrivenSessionRecord({
        localId: row.localId,
        harnessSessionId: row.harnessSessionId,
        cwd: row.cwd,
        permissionMode: row.permissionMode as PermissionMode,
        taskId: row.taskId,
        minskySessionId: row.minskySessionId,
        status: resumable ? "reconnecting" : "unrecoverable",
        unrecoverableReason: resumable
          ? null
          : "spawn-died-before-init — no harness session id was ever linked; there is no transcript to resume",
        actuatorGeneration: row.actuatorGeneration,
        startedAt: row.startedAt.toISOString(),
      });
      registry.register(record);
    }

    if (rows.length > 0) {
      log.info(
        `[driven-session] boot reconciliation: loaded ${rows.length} persisted session(s) (reconnecting/unrecoverable)`
      );
    }
    return rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[driven-session] boot reconciliation failed: ${message}`);
    return 0;
  }
}

/** Discriminated outcome of {@link orchestrateDrivenSessionResume}. */
export type DrivenSessionResumeOutcome =
  | { outcome: "resumed"; record: DrivenSessionRecord }
  | { outcome: "locked" }
  | { outcome: "unrecoverable"; reason: string }
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
    return { outcome: "unrecoverable", reason: row.unrecoverableReason ?? "unrecoverable" };
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
      onHarnessSessionLinked: createDrivenInitLinkObserver(),
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
