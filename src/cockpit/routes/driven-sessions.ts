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
  type DrivenSessionRegistry,
  type PermissionMode,
  type SpawnFn,
} from "../driven-session-host";

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
   * POST /api/driven-session — spawn a new driven session.
   *
   * Body: `{ cwd: string, permissionMode?: "bypassPermissions" | "default" }`.
   * Returns 201 with the session's local id (see ../driven-session-host.ts's
   * `DrivenSessionRecord.localId` doc comment for why this — not the harness
   * `init` session id, unknown at this point — is what addresses the WS
   * route) immediately; does NOT wait for the child's `init` event.
   */
  app.post("/api/driven-session", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cwd = body["cwd"];
    if (typeof cwd !== "string" || cwd.length === 0) {
      res.status(400).json({ error: "cwd (string) is required" });
      return;
    }
    const permissionModeRaw = body["permissionMode"];
    const permissionMode: PermissionMode = isPermissionMode(permissionModeRaw)
      ? permissionModeRaw
      : DEFAULT_PERMISSION_MODE;

    try {
      const { record } = startDrivenSession({
        cwd,
        permissionMode,
        spawnFn: opts.spawnFn,
        command: opts.command,
        registry,
      });
      res.status(201).json({
        sessionId: record.localId,
        pid: record.pid,
        cwd: record.cwd,
        permissionMode: record.permissionMode,
        argv: record.argv,
        status: record.status,
      });
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
    const sessions = registry.list().map((record) => ({
      sessionId: record.localId,
      harnessSessionId: record.harnessSessionId,
      cwd: record.cwd,
      permissionMode: record.permissionMode,
      status: record.status,
      pid: record.pid,
      startedAt: record.startedAt,
      exitCode: record.exitCode,
    }));
    res.status(200).json({ sessions });
  });
}
