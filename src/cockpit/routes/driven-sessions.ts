/**
 * Cockpit driven-session routes (mt#2750, Rung 2A).
 *
 *   POST /api/driven-session            — spawn a new driven session (genuine
 *                                          `claude` binary — see ../driven-session-host.ts)
 *   POST /api/driven-session/:id/stop   — graceful stop (close stdin, SIGTERM after grace)
 *   GET  /api/driven-session            — list app-started sessions (registry
 *                                          snapshot; minimal — the full cockpit
 *                                          view is Rung 2B/2C)
 *
 * LOCAL-DAEMON ONLY: never mounted for the Railway `isPublicDeployment`
 * entrypoint (see ../server.ts's mount call) — spawning a genuine `claude`
 * binary with the operator's own credentials only makes sense on the
 * operator's own machine (mt#2750 spec's load-bearing invariant: "genuine
 * binary + user's own creds + user's own machine").
 *
 * These are ordinary Express mutation routes — `POST` already goes through
 * `mutationAuthMiddleware` in ../server.ts (bearer token / cookie required).
 * The per-session WebSocket channel (`/api/driven-session/:id/ws`) is a
 * SEPARATE attach point on the underlying `http.Server` — see
 * ../driven-session-ws.ts — because WS upgrades bypass Express's request
 * pipeline entirely; it is wired from
 * src/commands/cockpit/start-command.ts once the server is listening.
 *
 * @see mt#2750 — this module
 * @see ../driven-session-host.ts — spawn/parse/registry/input-forwarding logic
 * @see ../driven-session-ws.ts — the WS channel this session id addresses
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import {
  startDrivenSession,
  stopDrivenSession,
  drivenSessionRegistry,
  DEFAULT_PERMISSION_MODE,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type PermissionMode,
  type SpawnFn,
} from "../driven-session-host";
import {
  resolveTaskWorkspace as prodResolveTaskWorkspace,
  createDrivenInitLinkObserver,
  type ResolvedTaskWorkspace,
} from "../driven-session-launch";

/**
 * Options accepted by {@link mountDrivenSessionRoutes}. Every field here is a
 * test-only injection seam (mirrors the `overrideConversationLiveTail`
 * convention in ../server.ts) — production never sets any of these;
 * `startDrivenSession` falls back to its real-spawn/shared-registry defaults
 * when omitted.
 */
export interface DrivenSessionRoutesOptions {
  /** Override the registry (tests use a hermetic instance, not the shared singleton). */
  registry?: DrivenSessionRegistry;
  /** Override the spawn function (tests inject a fake process — see ../driven-session-host.ts). */
  spawnFn?: SpawnFn;
  /** Override the claude binary command (tests point at a fake binary path/script). */
  command?: string;
  /** Override task→workspace resolution (tests avoid real session_start machinery). */
  resolveTaskWorkspace?: (taskId: string) => Promise<ResolvedTaskWorkspace>;
  /** Override the init-event link observer (tests capture instead of writing to Postgres). */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /** Override the scratch-session default cwd (defaults to the daemon's cwd). */
  scratchCwd?: string;
}

/** Serialize one registry record for the create/list responses (mt#2752).
 * ONE row shape for both endpoints — docs/cockpit-ui.md §Operator endpoints
 * documents them as identical (PR #1943 R1 finding: they had drifted). */
function toSessionSummary(record: DrivenSessionRecord) {
  return {
    sessionId: record.localId,
    harnessSessionId: record.harnessSessionId,
    cwd: record.cwd,
    taskId: record.taskId,
    minskySessionId: record.minskySessionId,
    permissionMode: record.permissionMode,
    status: record.status,
    pid: record.pid,
    startedAt: record.startedAt,
    exitCode: record.exitCode,
    argv: record.argv,
  };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "bypassPermissions" || value === "default";
}

/** Mount the driven-session routes on `app`. */
export function mountDrivenSessionRoutes(
  app: express.Express,
  opts: DrivenSessionRoutesOptions = {}
): void {
  const registry = opts.registry ?? drivenSessionRegistry;

  /**
   * POST /api/driven-session — spawn a new driven session (mt#2750; task
   * binding mt#2752).
   *
   * Body (all fields optional, `taskId`/`cwd` mutually exclusive):
   *   - `{ taskId }` — task-bound launch: bind-or-create the task's
   *     workspace via the real session_start machinery
   *     (../driven-session-launch.ts) and spawn with cwd = the workspace
   *     directory. Spawn-time identity registration (the `driven_spawn`
   *     link) is wired via the init-event observer.
   *   - `{ cwd }` — explicit-directory launch (the original mt#2750 shape).
   *   - `{}` — untasked "scratch" session (mt#2752 SC3): cwd defaults to the
   *     daemon's own working directory (the repo it was started from).
   *   - `permissionMode?: "bypassPermissions" | "default"` on any of the above.
   *
   * Returns 201 with the session's local id (see ../driven-session-host.ts's
   * `DrivenSessionRecord.localId` doc comment for why this — not the harness
   * `init` session id, unknown at this point — is what addresses the WS
   * route) immediately; does NOT wait for the child's `init` event. The
   * task-bound branch DOES await workspace bind/create before spawning —
   * the workspace directory must exist to be the child's cwd.
   */
  app.post("/api/driven-session", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cwdRaw = body["cwd"];
    const taskIdRaw = body["taskId"];
    const hasCwd = typeof cwdRaw === "string" && cwdRaw.length > 0;
    const hasTaskId = typeof taskIdRaw === "string" && taskIdRaw.length > 0;

    if (hasCwd && hasTaskId) {
      res
        .status(400)
        .json({ error: "taskId and cwd are mutually exclusive — pass one or neither" });
      return;
    }
    // Reject present-but-malformed fields rather than silently falling back
    // to a scratch session in the wrong directory.
    if (cwdRaw !== undefined && !hasCwd) {
      res.status(400).json({ error: "cwd must be a non-empty string when provided" });
      return;
    }
    if (taskIdRaw !== undefined && !hasTaskId) {
      res.status(400).json({ error: "taskId must be a non-empty string when provided" });
      return;
    }

    const permissionModeRaw = body["permissionMode"];
    const permissionMode: PermissionMode = isPermissionMode(permissionModeRaw)
      ? permissionModeRaw
      : DEFAULT_PERMISSION_MODE;

    try {
      let cwd: string;
      let taskId: string | null = null;
      let minskySessionId: string | null = null;
      let onHarnessSessionLinked = opts.onHarnessSessionLinked;

      if (hasTaskId) {
        taskId = taskIdRaw as string;
        const resolve = opts.resolveTaskWorkspace ?? prodResolveTaskWorkspace;
        const workspace = await resolve(taskId);
        cwd = workspace.sessionDir;
        minskySessionId = workspace.minskySessionId;
        onHarnessSessionLinked = onHarnessSessionLinked ?? createDrivenInitLinkObserver();
      } else if (hasCwd) {
        cwd = cwdRaw as string;
      } else {
        cwd = opts.scratchCwd ?? process.cwd();
      }

      const { record } = startDrivenSession({
        cwd,
        permissionMode,
        taskId,
        minskySessionId,
        onHarnessSessionLinked,
        spawnFn: opts.spawnFn,
        command: opts.command,
        registry,
      });
      res.status(201).json(toSessionSummary(record));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[driven-session] spawn failed: ${message}`);
      res.status(500).json({ error: `Failed to start driven session: ${message}` });
    }
  });

  /** POST /api/driven-session/:id/stop — graceful stop (SC5 lifecycle). */
  app.post("/api/driven-session/:id/stop", (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: "Unknown driven session id" });
      return;
    }
    stopDrivenSession(record);
    res.status(200).json({ sessionId: record.localId, status: record.status });
  });

  /**
   * GET /api/driven-session — list app-started sessions. Minimal snapshot;
   * a full cockpit `session ps`-style view is Rung 2B/2C (out of scope here
   * per the mt#2750 spec's Scope section).
   */
  app.get("/api/driven-session", (_req, res) => {
    const sessions = registry.list().map(toSessionSummary);
    res.status(200).json({ sessions });
  });
}
