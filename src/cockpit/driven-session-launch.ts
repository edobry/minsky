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

import { log } from "@minsky/shared/logger";
import type { DrivenSessionRecord } from "./driven-session-host";
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
 * branch, DB row, READY → IN-PROGRESS status walk). Errors (task not found,
 * task not in a startable status, git failure) propagate to the caller — the
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
  getDb?: typeof getContextInspectorDb;
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
