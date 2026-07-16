/**
 * POST /api/agents/:id/focus (mt#2286).
 *
 * The Agents-view "go to" action for an EXTERNALLY-attached session: the
 * browser cannot raise an OS terminal directly, so this cockpit-server route
 * resolves the workspace session's live mt#2284 attachment(s) and delegates
 * to the mt#2285 focus-adapter orchestration (`focusAttachment`) in-process.
 *
 * Local-only (v0): an attachment recorded on a non-local host is reported as
 * `remote-host-unsupported` rather than attempted — the mt#2285 focus
 * adapters only make sense against a process on the SAME machine as this
 * cockpit daemon. Cross-host ("mesh") focus is out of scope for this task —
 * see the task spec's `## Scope`.
 *
 * HARD sandbox constraint (mirrors mt#2285's `executor.ts` docblock): this
 * module must never invoke a REAL focus action (AppleScript/tmux/wezterm/
 * kitty) from the implementation/test sandbox. Every test injects a mock
 * `CommandExecutor` via the `executor` option; production wires the real
 * `defaultCommandExecutor` (mt#2285) by omitting the option entirely (see
 * `focusAttachment`'s own default in `packages/domain/src/session/focus/registry.ts`).
 */
import type express from "express";
import { hostname as osHostname } from "node:os";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import type { CommandExecutor } from "@minsky/domain/session/index";

export interface AgentFocusRouteOptions {
  /** Test seam — overrides the cockpit-wide SQL connection getter. */
  getDb?: () => Promise<PostgresJsDatabase | null>;
  /**
   * Test seam — overrides the real (mt#2285) focus executor. Production
   * MUST omit this so `focusAttachment` falls through to its own
   * `defaultCommandExecutor`; every test MUST supply a mock (sandbox rule
   * above).
   */
  executor?: CommandExecutor;
  /** Test seam — overrides `os.hostname()` for remote-host-rejection tests. */
  hostname?: () => string;
}

/** Mount POST /api/agents/:id/focus on `app`. */
export function mountAgentFocusRoutes(
  app: express.Express,
  opts: AgentFocusRouteOptions = {}
): void {
  const getHostname = opts.hostname ?? osHostname;

  app.post("/api/agents/:id/focus", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Session ID required" });
      return;
    }
    const sessionId = decodeURIComponent(rawId);

    try {
      const getDb = opts.getDb ?? (await import("../db-providers")).getContextInspectorDb;
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: "Presence service unavailable — cannot resolve stored attachments.",
        });
        return;
      }

      const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
      const repo = buildPresenceClaimRepository(db);
      if (!repo) {
        res.status(503).json({
          error: "Presence service unavailable — cannot resolve stored attachments.",
        });
        return;
      }

      const { listSessionAttachments, isAttachmentConfirmedLive, focusAttachment } = await import(
        "@minsky/domain/session/index"
      );

      // Raw (not liveness-filtered) so a remote-host attachment can be
      // distinguished from "nothing attached at all" — isAttachmentConfirmedLive
      // already excludes non-local-host rows, which would otherwise collapse
      // both cases into the same generic "nothing attached" message.
      const raw = await listSessionAttachments(repo, sessionId);
      const localHost = getHostname();
      const liveLocal = raw.filter((a) => isAttachmentConfirmedLive(a, localHost));

      if (liveLocal.length === 0) {
        const remoteOnly = raw.some((a) => a.host && a.host !== localHost);
        if (remoteOnly) {
          res.json({
            success: false,
            outcomeKind: "remote-host-unsupported",
            message:
              `Session ${sessionId}'s attachment is on a different host — focusing a ` +
              "remote terminal is not supported yet (v0, local-only).",
          });
          return;
        }
        res.json({
          success: false,
          outcomeKind: "nothing-attached",
          message: `Nothing attached to session ${sessionId} — no live terminal to go to.`,
        });
        return;
      }

      // Most-recently-registered live attachment wins when several are
      // present — a single button has no room for a CLI-style `--attachment`
      // selector prompt (contrast `session focus`'s ambiguity handling,
      // src/adapters/shared/commands/session/focus-command.ts).
      const sorted = [...liveLocal].sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
      const target = sorted[0];
      if (!target) {
        // Unreachable given liveLocal.length > 0 above; keeps TS control-flow
        // analysis happy without a non-null assertion.
        res.status(500).json({ error: "Could not resolve an attachment to focus." });
        return;
      }

      const result = await focusAttachment(
        target,
        opts.executor ? { executor: opts.executor } : {}
      );

      res.json({
        success: result.kind === "focused" || result.kind.startsWith("degraded"),
        outcomeKind: result.kind,
        message: result.message,
        adapter: result.adapter,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[agent-focus] POST /api/agents/:id/focus — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while focusing the session." });
    }
  });
}
