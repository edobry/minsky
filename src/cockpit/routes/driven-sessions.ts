/**
 * Cockpit driven-session routes (mt#2750, Rung 2A).
 *
 *   POST /api/driven-session            — spawn a new driven session (genuine
 *                                          `claude` binary — see ../driven-session-host.ts)
 *   POST /api/driven-session/:id/stop   — graceful stop (close stdin, SIGTERM after grace)
 *   GET  /api/driven-session            — list app-started sessions (registry
 *                                          snapshot; minimal — the full cockpit
 *                                          view is Rung 2B/2C)
 *   GET  /api/driven-session/turn-active — cheap "is any driven session
 *                                          actively mid-turn" signal (mt#3048).
 *                                          The cockpit-tray watcher's
 *                                          pre-restart gate
 *                                          (watcher_backend.rs) queries this
 *                                          before a hot-reload daemon restart.
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
 * Project scope (mt#4746): `GET /api/driven-session`'s `?project=<slug>`
 * filters directly on each registry record's `projectId` (mt#4732 already
 * resolves and stamps this at spawn time on the task-bound launch path — no
 * new resolution step needed, just a read of an already-present field). A
 * record with `projectId: null` (explicit-cwd or scratch launch — nothing to
 * resolve, per the spawn handler's own mt#4732 comments) is EXCLUDED from a
 * scoped read, the same strict `eq()`-only semantics `widgets/agents.ts`'s
 * `spliceDrivenSessions` already applies to a driven session with no
 * matching workspace row. The mutation endpoints (create/attach/stop) and
 * `GET .../turn-active` are UNSCOPED — see `scope-census.ts`'s allowlist for
 * why (they act on one already-identified session id, or are a
 * daemon-wide liveness signal).
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
  isDrivenSessionMidTurn,
  DEFAULT_PERMISSION_MODE,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type DrivenSessionCostSummary,
  type PermissionMode,
  type SpawnFn,
} from "../driven-session-host";
import { drivenSessionMcpServerNames } from "../driven-session-mcp-servers";
import {
  resolveTaskWorkspace as prodResolveTaskWorkspace,
  createDrivenInitObserver,
  createDrivenResultObserver,
  createDrivenSessionPersistObserver,
  orchestrateDrivenSessionAttach as prodOrchestrateDrivenSessionAttach,
  type ResolvedTaskWorkspace,
  type DrivenSessionAttachOutcome,
  type OrchestrateDrivenSessionAttachDeps,
} from "../driven-session-launch";
import { isDispatchModelId, resolveDispatchModelArg } from "@minsky/domain/ai/dispatch-models";
import { looksLikeConversationId } from "../conversation-id-space";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";

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
  /**
   * Override the attach orchestration (mt#3095). Tests inject an outcome
   * directly rather than standing up a database, a `~/.claude` tree, and a
   * presence row — the orchestration's own decisions are covered in
   * ../driven-session-launch-persistence.test.ts; what this route owns is the
   * outcome→status-code mapping.
   */
  attachDrivenSession?: (
    conversationId: string,
    deps: OrchestrateDrivenSessionAttachDeps
  ) => Promise<DrivenSessionAttachOutcome>;
  /** Override the init-event link observer (tests capture instead of writing to Postgres). */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /**
   * Override the per-turn cost/usage observer (mt#2753 — tests capture
   * instead of writing to Postgres). Unlike `onHarnessSessionLinked`, this
   * defaults for EVERY launch shape (task-bound, explicit-cwd, and scratch
   * alike) — see the `createDrivenResultObserver` docblock.
   */
  onResultSummary?: (record: DrivenSessionRecord, summary: DrivenSessionCostSummary) => void;
  /**
   * Override the durable-persistence observer (mt#3038 — tests capture
   * instead of writing to Postgres). Like `onResultSummary`, defaults for
   * EVERY launch shape — task-bound, explicit-cwd, AND untasked "scratch"
   * sessions alike (RFC minimal-first-slice step 5: extending durable
   * binding to scratch sessions falls out of this default, not a separate
   * code path) — see `createDrivenSessionPersistObserver`'s docblock.
   */
  onStateChange?: (record: DrivenSessionRecord) => void;
  /** Override the scratch-session default cwd (defaults to the daemon's cwd). */
  scratchCwd?: string;
  /**
   * Test seam (mt#4746, mirrors `routes/tasks.ts`'s `getProjectScopeDb`):
   * overrides `resolveCockpitProjectScope`'s own db-fetch for `GET
   * /api/driven-session`'s `?project=` resolution. Production callers never
   * set this.
   */
  getProjectScopeDb?: () => Promise<
    import("@minsky/domain/project/scope-resolver").ScopeResolverDb | null
  >;
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

    // mt#3040: optional principal-selected model. Reject a present-but-unknown
    // model id rather than silently launching on the default (mirrors the
    // cwd/taskId malformed-field rejections above). The wire value is a
    // registry id (e.g. "fable"); resolve it to the `--model` alias.
    const modelRaw = body["model"];
    let model: string | undefined;
    if (modelRaw !== undefined) {
      if (!isDispatchModelId(modelRaw)) {
        res
          .status(400)
          .json({ error: "model must be one of the known dispatch models when provided" });
        return;
      }
      model = resolveDispatchModelArg(modelRaw);
    }

    try {
      let cwd: string;
      let taskId: string | null = null;
      let minskySessionId: string | null = null;
      // mt#4732: project attribution, resolved only on the task-bound branch
      // below (the only branch with a workspace to read one from).
      let projectId: string | null = null;
      let onHarnessSessionLinked = opts.onHarnessSessionLinked;
      // mt#2753: cost capture applies to every driven session regardless of
      // launch shape — success criterion 1 is "every driven session", not
      // "every task-bound driven session" (unlike onHarnessSessionLinked's
      // task-bound-only default below).
      const onResultSummary = opts.onResultSummary ?? createDrivenResultObserver();
      // mt#3038: same "every driven session" scope as onResultSummary above —
      // durable driven_sessions persistence is not task-bound-only.
      const onStateChange = opts.onStateChange ?? createDrivenSessionPersistObserver();

      // mt#4323: wired for EVERY driven session, not only the task-bound ones.
      // This used to sit inside the `hasTaskId` arm below, because its only job
      // was the `driven_spawn` link — which genuinely needs a workspace session.
      // The observer now ALSO records the conversation adoption, which every
      // driven session has, so a scratch or cwd-launched session would
      // otherwise have had no record of the conversations it adopted. The link
      // half still self-gates on `minskySessionId` (null on those paths), so
      // hoisting it adds the adoption without adding a spurious link.
      onHarnessSessionLinked =
        onHarnessSessionLinked ?? createDrivenInitObserver({ adoptionReason: "initial" });

      if (hasTaskId) {
        taskId = taskIdRaw as string;
        const resolve = opts.resolveTaskWorkspace ?? prodResolveTaskWorkspace;
        const workspace = await resolve(taskId);
        cwd = workspace.sessionDir;
        minskySessionId = workspace.minskySessionId;
        projectId = workspace.projectId;
      } else if (hasCwd) {
        cwd = cwdRaw as string;
        // mt#4732: `projectId` stays at its `null` initial value here —
        // deliberately, not an oversight. An explicit-cwd launch has no
        // Minsky workspace to read a projectId from, so there is nothing to
        // resolve. The agents widget treats this the same as any other
        // unresolvable driven-session attribution (folded into the
        // unattributed-summary aggregate under a specific project filter).
      } else {
        cwd = opts.scratchCwd ?? process.cwd();
        // mt#4732: same "nothing to resolve" reasoning as the `hasCwd`
        // branch above — a scratch launch has no bound workspace either.
      }

      const { record } = startDrivenSession({
        mcpServerNames: drivenSessionMcpServerNames(),
        cwd,
        permissionMode,
        model,
        taskId,
        minskySessionId,
        projectId,
        onHarnessSessionLinked,
        onResultSummary,
        onStateChange,
        spawnFn: opts.spawnFn,
        command: opts.command,
        registry,
      });
      res.status(201).json(toSessionSummary(record));
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "driven-sessions")) return;
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[driven-session] spawn failed: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: `Failed to start driven session: ${message}` });
    }
  });

  /**
   * POST /api/driven-session/attach — put a session driver on a conversation Minsky
   * did NOT spawn (mt#3095), e.g. one the operator started in their terminal.
   *
   * Body: `{ conversationId }`.
   *
   * Status codes carry the distinction that matters to a caller deciding what
   * to show:
   *   - **201** attached — body is the same session summary a spawn returns, so
   *     an attached conversation is indistinguishable downstream.
   *   - **409** refused — a writer is (or may be) holding the conversation.
   *     Carries `{ refused: true, presence, reason, message }`; the `message` is
   *     operator-facing prose explaining the risk, not a status name.
   *   - **423** locked — another COCKPIT session driver won the advisory lock. Distinct
   *     from 409: nothing is wrong with the conversation, this caller simply
   *     lost a race and a retry may succeed.
   *   - **404** no transcript, or one with no recoverable cwd — nothing to
   *     attach to.
   *
   * Route ordering note: this is registered BEFORE `/api/driven-session/:id/stop`
   * but shares no shape with it (`attach` is a literal segment on a different
   * path depth), so no `:id` capture can shadow it.
   */
  app.post("/api/driven-session/attach", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conversationIdRaw = body["conversationId"];
    if (typeof conversationIdRaw !== "string" || conversationIdRaw.length === 0) {
      res.status(400).json({ error: "conversationId must be a non-empty string" });
      return;
    }
    // A syntactically-impossible id can never resolve to a transcript, and
    // finding that out otherwise costs a walk of the whole `~/.claude/projects`
    // tree. Rejected with zero I/O, reusing the same shared predicate the
    // presence route applies (mt#3131) so the two surfaces agree on what an id
    // even looks like. (PR #2466 R1, non-blocking.)
    if (!looksLikeConversationId(conversationIdRaw)) {
      res.status(400).json({ error: `"${conversationIdRaw}" is not a valid conversation id.` });
      return;
    }

    try {
      const attach = opts.attachDrivenSession ?? prodOrchestrateDrivenSessionAttach;
      const outcome = await attach(conversationIdRaw, {
        registry,
        spawnFn: opts.spawnFn,
        command: opts.command,
      });

      switch (outcome.outcome) {
        case "attached":
          res.status(201).json(toSessionSummary(outcome.record));
          return;
        case "refused":
          res.status(409).json({
            refused: true,
            presence: outcome.presence,
            reason: outcome.reason,
            message: outcome.message,
          });
          return;
        case "locked":
          res.status(423).json({
            error: "Another cockpit session driver is attaching to this conversation right now.",
          });
          return;
        case "no-transcript":
          res.status(404).json({ error: "No on-disk transcript found for that conversation id." });
          return;
      }
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "driven-sessions")) return;
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[driven-session] attach failed for ${conversationIdRaw}: ${getLoggableErrorSummary(err)}`
      );
      res.status(500).json({ error: `Failed to attach driven session: ${message}` });
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
   *
   * Project scope (mt#4746): `?project=<slug>` filters directly on each
   * record's `projectId` (mt#4732) — see the module docblock. Fail-open to
   * ALL_PROJECTS on any resolution failure (PR #2056 R1), same as every
   * other cockpit project-scoped read.
   */
  app.get("/api/driven-session", async (req, res) => {
    const { resolveCockpitProjectScope } = await import("../project-scope");
    const { isAllProjects } = await import("@minsky/domain/project/scope");
    const projectParam =
      typeof req.query["project"] === "string" ? req.query["project"] : undefined;
    const projectScope = await resolveCockpitProjectScope(projectParam, {
      getDb: opts.getProjectScopeDb,
    });

    const all = registry.list();
    const scoped = isAllProjects(projectScope)
      ? all
      : all.filter((record) => record.projectId === projectScope);

    res.status(200).json({ sessions: scoped.map(toSessionSummary) });
  });

  /**
   * GET /api/driven-session/turn-active — cheap "is any driven session
   * actively mid-turn" signal (mt#3048, RFC "Conversation-first drive" Phase
   * 1 slice 6). Consumed by the cockpit-tray watcher
   * (cockpit-tray/src-tauri/src/watcher_backend.rs) as a pre-restart gate: a
   * hot-reload daemon restart is deferred (bounded grace period, never
   * indefinitely) while `active` is true, rather than interrupting a turn
   * that is actively streaming. "Mid-turn" = a driven session's latest
   * observed event is not yet a terminal `result`/`minsky_exit` event — see
   * `isDrivenSessionMidTurn` in ../driven-session-host.ts.
   *
   * Deliberately a plain in-memory registry scan — O(number of driven
   * sessions, normally single digits) with no I/O — so this stays cheap
   * enough to poll on every restart-triggering source change with no
   * perceptible latency added to the common (no active turn) case.
   *
   * Unauthenticated read-only GET, same posture as `GET /api/driven-session`
   * above: mutation auth in ../server.ts is scoped to non-GET/HEAD/OPTIONS
   * requests (loopback bind already covers the LAN read surface; the tray's
   * own `/api/health` poll is the documented precedent for an unauthenticated
   * GET consumer at this tier).
   */
  app.get("/api/driven-session/turn-active", (_req, res) => {
    const activeSessionIds = registry
      .list()
      .filter(isDrivenSessionMidTurn)
      .map((record) => record.localId);
    res.status(200).json({ active: activeSessionIds.length > 0, activeSessionIds });
  });
}
