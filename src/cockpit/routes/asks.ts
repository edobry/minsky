/**
 * Cockpit ask routes (mt#2615 — extracted from server.ts, mt#1147 / mt#1916).
 *
 *   GET  /api/asks               — list pending operator-routed asks
 *   POST /api/asks/:id/defer     — defer an ask to the next service window
 *   POST /api/asks/:id/escalate  — mark an ask as principal-critical
 *   POST /api/asks/:id/resolve   — mark an Ask as resolved
 */
import type express from "express";
import type { AskRepository } from "@minsky/domain/ask/repository";
import { respondAndCloseAsk } from "@minsky/domain/ask/repository";
import { getServerAskRepository } from "../db-providers";

/** Options accepted by {@link mountAskRoutes}. */
export interface AskRoutesOptions {
  /** Override the AskRepository used by every endpoint (used in tests). */
  askRepoOverride: AskRepository | null;
}

/**
 * Shared defer/escalate handler (mt#2615) — both endpoints transition the Ask
 * back to "routed" via the identical repository call; they differ only in
 * the response shape (`escalated: true` on the escalate path) and log/error
 * framing. Collapsing them into one parameterized handler removes the
 * copy-pasted duplicate that server.ts previously carried (lines 2012-2069
 * pre-split).
 */
function makeDeferOrEscalateHandler(
  mode: "defer" | "escalate",
  askRepoOverride: AskRepository | null
): express.RequestHandler {
  return async (req, res) => {
    const askId = req.params.id;
    if (!askId) {
      res.status(400).json({ error: "Ask ID required" });
      return;
    }
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({ error: "Ask repository unavailable" });
        return;
      }
      const ask = await repo.transition(askId, "routed");
      res.json({
        ok: true,
        id: ask.id,
        state: ask.state,
        ...(mode === "escalate" ? { escalated: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (message.includes("Invalid transition")) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  };
}

/** Mount the /api/asks* routes on `app`. */
export function mountAskRoutes(app: express.Express, opts: AskRoutesOptions): void {
  const { askRepoOverride } = opts;

  /**
   * GET /api/asks — list all pending operator-routed asks (mt#1916)
   *
   * Returns: { asks: Ask[], total: number }
   *
   * Lists all suspended asks routed to "operator", sorted by priority.
   * Used by the /asks management page for the full list view.
   *
   * Architecture note: the cockpit server is a direct domain-layer consumer
   * (same as the mt#1147 resolve endpoint). MCP tools (asks_respond,
   * asks_reconcile) are the agent-facing interface to the same domain
   * operations — the cockpit backend does not route through MCP to itself.
   */
  app.get("/api/asks", async (_req, res) => {
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: "Ask repository unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { isTerminal } = await import("@minsky/domain/ask/state-machine");
      const { compareAskPriority } = await import("@minsky/domain/ask/pending-asks-for-window");

      const suspended = await repo.listByState("suspended");
      const operatorAsks = suspended.filter(
        (a) => a.routingTarget === "operator" && !isTerminal(a.state)
      );
      operatorAsks.sort(compareAskPriority);

      const asks = operatorAsks.map((a) => ({
        id: a.id,
        kind: a.kind,
        state: a.state,
        title: a.title,
        question: a.question,
        requestor: a.requestor,
        routingTarget: a.routingTarget,
        parentTaskId: a.parentTaskId,
        parentSessionId: a.parentSessionId,
        options: a.options,
        contextRefs: a.contextRefs,
        deadline: a.deadline,
        createdAt: a.createdAt,
        suspendedAt: a.suspendedAt,
        windowKey: a.windowKey,
        windowMissedCount: a.windowMissedCount ?? 0,
        serviceStrategy: a.serviceStrategy,
        metadata: a.metadata,
      }));

      res.json({ asks, total: asks.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/asks/:id — fetch a single ask by id, regardless of state (mt#2669)
   *
   * The pending-list endpoint only returns live suspended operator asks, so a
   * deeplink resolved through it cannot distinguish "not in the pending
   * snapshot" from "actually terminal". This per-id endpoint is the deeplink
   * resolution path: it returns terminal asks too — including the recorded
   * response — so the detail page can say what actually happened. 404 only
   * for an id that does not exist at all.
   */
  app.get("/api/asks/:id", async (req, res) => {
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: "Ask repository unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const a = await repo.getById(req.params.id);
      if (!a) {
        res.status(404).json({ error: "Ask not found" });
        return;
      }

      res.json({
        ask: {
          id: a.id,
          kind: a.kind,
          state: a.state,
          title: a.title,
          question: a.question,
          requestor: a.requestor,
          routingTarget: a.routingTarget,
          parentTaskId: a.parentTaskId,
          parentSessionId: a.parentSessionId,
          options: a.options,
          contextRefs: a.contextRefs,
          deadline: a.deadline,
          createdAt: a.createdAt,
          suspendedAt: a.suspendedAt,
          windowKey: a.windowKey,
          windowMissedCount: a.windowMissedCount ?? 0,
          serviceStrategy: a.serviceStrategy,
          metadata: a.metadata,
          response: a.response,
          respondedAt: a.respondedAt,
          closedAt: a.closedAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/asks/:id/defer — defer an ask to the next service window (mt#1916)
   *
   * Transitions the ask back to "routed" state so it re-enters the routing
   * queue and appears in the next window's cohort.
   */
  app.post("/api/asks/:id/defer", makeDeferOrEscalateHandler("defer", askRepoOverride));

  /**
   * POST /api/asks/:id/escalate — mark an ask as principal-critical (mt#1916)
   *
   * Transitions the ask back to "routed" state with escalation semantics.
   * Full escalation metadata (priority bump, visibility flag) is tracked
   * in mt#1528; this endpoint provides the operator affordance now.
   */
  app.post("/api/asks/:id/escalate", makeDeferOrEscalateHandler("escalate", askRepoOverride));

  /**
   * POST /api/asks/:id/resolve — mark an Ask as resolved (mt#1147)
   *
   * Body: { responder?: string, payload?: unknown }
   *
   * Routes through the shared `respondAndCloseAsk` domain function (mt#2615)
   * — the same suspended-state precondition check, responder trimming, and
   * `ConcurrentTransitionError` handling as the CLI/MCP `respondToAsk`
   * surface. `attentionCost` is ALWAYS computed server-side as the fixed
   * `{ transport: "inbox", resolvedIn: "inbox" }` value (matching what the
   * real cockpit UI already sends and what `respondToAsk` computes for the
   * same transport) — client-supplied `attentionCost` is never trusted or
   * read from the request body.
   *
   * Returns 200 on success, 400 if askId is missing, 403 if Ask is not
   * operator-routed (algedonic selection — see mt#1147 PR #1125 R1), 404 if
   * Ask not found, 409 if the Ask is not in "suspended" state (including a
   * concurrent transition detected at the atomic update), 500 on unexpected
   * errors, 503 if the Ask repository is unavailable.
   */
  app.post("/api/asks/:id/resolve", async (req, res) => {
    const askId = req.params.id;
    if (!askId) {
      res.status(400).json({ error: "Ask ID required" });
      return;
    }

    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: "Ask repository unavailable — persistence provider does not support SQL",
        });
        return;
      }

      // Algedonic selection (mt#1147): only operator-routed asks may be resolved
      // via this endpoint. Asks resolved by policy / peers / reviewer subagents
      // must not be short-circuited through the operator's resolution surface.
      // PR #1125 R1 BLOCKING finding. This is endpoint-specific defense-in-depth
      // — NOT part of the shared respondAndCloseAsk domain contract (mt#2615);
      // respondToAsk (asks.ts) has no equivalent gate.
      const existing = await repo.getById(askId);
      if (!existing) {
        res.status(404).json({ error: `Ask ${askId} not found` });
        return;
      }
      if (existing.routingTarget !== "operator") {
        res.status(403).json({
          error: `Ask ${askId} is not operator-routed (routingTarget=${existing.routingTarget}); refusing to resolve`,
        });
        return;
      }

      // Trust-boundary guard: only `responder` and `payload` are read from the
      // request body. `attentionCost` is deliberately NOT read here — it is
      // always the fixed server-computed value below, closing the
      // unvalidated-attentionCost-passthrough finding (mt#2607 audit #3).
      const body = req.body as {
        responder?: string;
        payload?: unknown;
      };

      const { ask } = await respondAndCloseAsk(repo, {
        id: askId,
        responder: body.responder,
        payload: body.payload ?? {},
        attentionCost: { transport: "inbox", resolvedIn: "inbox" },
      });

      res.json({ ok: true, id: ask.id, state: ask.state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (
        message.includes("Concurrent transition") ||
        message.includes("ConcurrentTransitionError") ||
        message.includes('only "suspended" Asks can be responded to')
      ) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });
}
