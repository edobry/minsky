/**
 * Cockpit ask routes (mt#2615 — extracted from server.ts, mt#1147 / mt#1916).
 *
 *   GET  /api/asks               — list pending operator-routed asks
 *   POST /api/asks/:id/defer     — INERT (mt#3491); reports state, changes nothing
 *   POST /api/asks/:id/escalate  — INERT (mt#3491); reports state, changes nothing
 *   POST /api/asks/:id/resolve   — mark an Ask as resolved
 */
import type express from "express";
import type { AskRepository } from "@minsky/domain/ask/repository";
import { respondAndCloseAsk } from "@minsky/domain/ask/repository";
import { getServerAskRepository, describeServerPersistenceUnavailability } from "../db-providers";

/** Options accepted by {@link mountAskRoutes}. */
export interface AskRoutesOptions {
  /** Override the AskRepository used by every endpoint (used in tests). */
  askRepoOverride: AskRepository | null;
}

/**
 * Shared defer/escalate handler (mt#2615, made inert by mt#3491).
 *
 * ## Why these no longer transition state
 *
 * Both endpoints used to call `repo.transition(askId, "routed")`, on the
 * expectation that something would re-dispatch the Ask into the operator
 * queue on the next service window. Nothing does: `ServiceWindowReaper`
 * (packages/domain/src/ask/service-window-reaper.ts) — the only component
 * that performs `routed -> suspended` — has no production callsite.
 *
 * Meanwhile an operator-bound Ask never legitimately reaches `routed` at all.
 * `routeResultToOutcomeWrite` maps the inbox/elicitation transports straight
 * to `suspended` ("'Dispatch' for the inbox transport IS landing on the
 * operator surface" — ask/advancement.ts); only subagent/mesh/retriever
 * persist as `routed`, awaiting transports that do not exist yet.
 *
 * So for an operator Ask, `routed` was a TRAP STATE whose only entrances were
 * these two buttons, and `GET /api/asks` lists `suspended` only — pressing
 * either one silently removed the Ask from the operator's queue forever. That
 * is not a hypothetical: a `direction.decide` Ask asking the principal to
 * commit to a public brand name was lost this way for 23 days.
 *
 * These handlers are therefore INERT: they report the Ask's current state and
 * change nothing. The routes and response shapes are preserved so no caller
 * breaks. Restoring a real defer (a `snoozedUntil` column plus something that
 * fires when it elapses) and a real escalate (set `forceImmediate`, page the
 * principal out-of-band, keep the Ask visible throughout) belongs to the
 * delivery-layer work, not to this fix — an affordance that silently deletes
 * a decision is worse than no affordance at all.
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
      // Read-only: report current state, never transition. See docblock.
      const ask = await repo.getById(askId);
      if (!ask) {
        res.status(404).json({ error: `Ask ${askId} not found` });
        return;
      }
      res.json({
        ok: true,
        id: ask.id,
        state: ask.state,
        inert: true,
        // ADOPTED BEHAVIOR CHANGE (PR #2509 R1): the escalate path previously
        // returned `escalated: true`. Nothing is escalated any more, so
        // reporting `true` would be a false claim about what the call did —
        // exactly the class of silent misreport this PR exists to remove. The
        // field is kept (rather than dropped) so the response shape is stable,
        // and its value is now honest. Verified adoptable: no consumer reads
        // it — a repo-wide grep for `.escalated` / `escalated:` across `src`,
        // `packages`, and `services` returns only this file and the unrelated
        // `escalatedCount` in service-window-reaper.test.ts. Pinned by
        // asks.test.ts so the value cannot drift back silently.
        ...(mode === "escalate" ? { escalated: false } : {}),
      });
    } catch (err) {
      // No transition happens here any more, so the former "Invalid
      // transition" -> 409 branch is unreachable and was removed (R1
      // non-blocking). `repo.getById` can still fail for unrelated reasons;
      // those surface as 500. The 404 for a missing Ask is returned above
      // from the null check, not from this handler.
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
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
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
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
        // ask#N short id (mt#2965) — undefined for legacy rows pre-backfill;
        // the frontend falls back to `id` (uuid) for display purposes.
        shortId: a.shortId,
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
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
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
          // ask#N short id (mt#2965) — undefined for legacy rows pre-backfill.
          shortId: a.shortId,
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
   * POST /api/asks/:id/defer — INERT since mt#3491 (was: mt#1916)
   *
   * Formerly transitioned the ask back to "routed" so it would re-enter the
   * routing queue in the next window's cohort. Nothing re-dispatches a `routed`
   * ask, so that was a one-way trip out of the operator's queue. Now a no-op
   * that reports current state. See makeDeferOrEscalateHandler's docblock.
   */
  app.post("/api/asks/:id/defer", makeDeferOrEscalateHandler("defer", askRepoOverride));

  /**
   * POST /api/asks/:id/escalate — INERT since mt#3491 (was: mt#1916)
   *
   * Formerly transitioned the ask back to "routed" "with escalation
   * semantics", deferring the real metadata (priority bump, visibility flag)
   * to mt#1528 — which closed as "Inbox data model + lifecycle diagram"
   * without ever supplying them. So this endpoint's only observable effect was
   * to remove the ask from the operator surface. Now a no-op that reports
   * current state; the response's `escalated` field is `false` accordingly.
   *
   * A real escalate belongs to the delivery layer: set `forceImmediate`, page
   * the principal out-of-band, and keep the ask visible throughout.
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
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
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
