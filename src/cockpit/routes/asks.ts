/**
 * Cockpit ask routes (mt#2615 — extracted from server.ts, mt#1147 / mt#1916).
 *
 *   GET  /api/asks               — list pending operator-routed asks
 *   POST /api/asks/:id/defer     — INERT (mt#3491); reports state, changes nothing
 *   POST /api/asks/:id/escalate  — INERT (mt#3491); reports state, changes nothing
 *   POST /api/asks/:id/resolve   — mark an Ask as resolved
 */
import type express from "express";
import type { Ask } from "@minsky/domain/ask/types";
import type { AskRepository } from "@minsky/domain/ask/repository";
import { respondAndCloseAsk } from "@minsky/domain/ask/repository";
import { getServerAskRepository, describeServerPersistenceUnavailability } from "../db-providers";
import { resolveCockpitProjectScope } from "../project-scope";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";

/** Options accepted by {@link mountAskRoutes}. */
export interface AskRoutesOptions {
  /** Override the AskRepository used by every endpoint (used in tests). */
  askRepoOverride: AskRepository | null;
}

/**
 * The `state` value that expands to every terminal state (mt#4092).
 *
 * An operator looking for an ask they resolved does not know whether it landed
 * in `closed`, `cancelled`, or `expired` — asking them to pick is asking them
 * for the thing they came to find out. `terminal` is the value the cockpit's
 * resolved view sends.
 */
export const TERMINAL_STATE_ALIAS = "terminal";

/** Default cap on a state-filtered list, and the ceiling `?limit=` may raise it to. */
export const DEFAULT_FILTERED_LIMIT = 100;
export const MAX_FILTERED_LIMIT = 500;

export type AskStateFilterResult =
  | { ok: true; states: string[] | null }
  | { ok: false; invalid: string[] };

/**
 * Parse `GET /api/asks?state=` into the set of states to gather (mt#4092).
 *
 * `states: null` means NO filter was supplied and the caller gets the
 * historical default (pending operator asks) — the distinction that keeps
 * every existing caller on exactly its current result set.
 *
 * Accepts a repeated param (`?state=closed&state=expired`, which Express hands
 * over as an array), a comma-separated list, or the `terminal` alias. Unknown
 * tokens are collected and reported rather than silently dropped: a filter that
 * quietly returns an empty list for a typo is indistinguishable from "there is
 * nothing there", which is the failure this endpoint already had.
 *
 * Takes the valid-state lists as arguments rather than importing them, so the
 * route can keep loading domain code lazily inside the handler and this stays a
 * pure function.
 */
export function parseAskStateFilter(
  raw: unknown,
  known: { all: readonly string[]; terminal: readonly string[] }
): AskStateFilterResult {
  const tokens = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (tokens.length === 0) return { ok: true, states: null };

  const states: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (token === TERMINAL_STATE_ALIAS) {
      states.push(...known.terminal);
    } else if (known.all.includes(token)) {
      states.push(token);
    } else {
      invalid.push(token);
    }
  }

  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, states: [...new Set(states)] };
}

/**
 * Ceiling for `?summary=true` (mt#4095).
 *
 * Higher than {@link MAX_FILTERED_LIMIT} because the two ceilings bound
 * different things: a full row carries its question body, its options and its
 * metadata (~3.3 KB measured), while a summary row is a handful of scalars. The
 * command palette needs the whole operator ask set to filter over, the way it
 * already preloads the whole task list.
 */
export const MAX_SUMMARY_LIMIT = 3000;

/**
 * Parse `?limit=`, clamped to the ceiling for the requested projection.
 * Anything unparseable uses the default.
 */
export function parseFilteredLimit(raw: unknown, summary = false): number {
  const ceiling = summary ? MAX_SUMMARY_LIMIT : MAX_FILTERED_LIMIT;
  const value = Number.parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_FILTERED_LIMIT;
  return Math.min(value, ceiling);
}

/** True when the caller asked for the compact projection. */
export function wantsSummary(raw: unknown): boolean {
  return raw === "true" || raw === "1";
}

/**
 * The routing target this endpoint serves, on both paths.
 *
 * `/api/asks` is the OPERATOR's surface. Terminal asks are dominated by
 * reviewer- and policy-routed rows that were never the operator's decisions, so
 * dropping this predicate on the filtered path would bury the ones they made.
 */
const OPERATOR_ROUTING_TARGET = "operator";

/**
 * The compact projection for `?summary=true` (mt#4095).
 *
 * Drops the body — question, options, contextRefs, metadata, response — which
 * is ~3.3 KB of the ~3.5 KB a full row costs. What remains is what a search
 * result needs to rank and label itself. Mirrors the `asks_list` MCP command's
 * `summary: true` field set rather than inventing a second compact shape,
 * plus `closedAt` so a result can say when it concluded.
 */
function toAskSummaryRow(a: Ask) {
  return {
    id: a.id,
    shortId: a.shortId,
    kind: a.kind,
    state: a.state,
    title: a.title,
    routingTarget: a.routingTarget,
    parentTaskId: a.parentTaskId,
    createdAt: a.createdAt,
    closedAt: a.closedAt,
  };
}

/**
 * The list projection, shared by both branches of `GET /api/asks` (mt#4092).
 *
 * The three conclusion fields (`respondedAt`, `closedAt`, `response`) are what
 * the resolved view renders — what was decided and when. They are undefined on
 * a pending ask, and `JSON.stringify` drops undefined properties, so the
 * default branch's body is unchanged by their presence.
 */
function toAskListRow(a: Ask) {
  return {
    id: a.id,
    // ask#N short id (mt#2965) — undefined for legacy rows pre-backfill;
    // the frontend falls back to `id` (uuid) for display purposes.
    shortId: a.shortId,
    kind: a.kind,
    state: a.state,
    // Owning project's uuid (mt#4773) — the all-projects view resolves it to
    // a label client-side (`projectLabelById`); absent for unscoped asks.
    // Whether the stamped value is CORRECT for task-parented asks is mt#4772's
    // separate write-path defect; rendering what is stored is this row's job.
    projectId: a.projectId,
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
    respondedAt: a.respondedAt,
    closedAt: a.closedAt,
    response: a.response,
  };
}

/**
 * Shared defer/escalate handler (mt#2615, made inert by mt#3491).
 *
 * ## Why these no longer transition state
 *
 * Both endpoints used to call `repo.transition(askId, "routed")`, on the
 * expectation that something would re-dispatch the Ask into the operator
 * queue on the next service window. Nothing did — `ServiceWindowReaper`
 * (packages/domain/src/ask/service-window-reaper.ts) had no production
 * callsite until mt#4313 gave it one.
 *
 * Two corrections to this docblock's original wording (mt#4313). It said the
 * reaper "performs `routed -> suspended`"; the direction is the opposite —
 * the reaper's only `transition()` call targets `"routed"`, moving a windowed
 * cohort `suspended -> routed` when its window opens.
 *
 * **The reaper no longer runs (mt#4410, 2026-08-21).** This docblock claimed it
 * did, which was true for one day: mt#4313 wired it, and mt#4410 unwired it
 * when the principal retired the attention-window concept —
 * `startServiceWindowSweeper` is now deliberately uncalled by the daemon. What
 * that retirement did NOT reach is the create-time defaults, so a
 * `direction.decide` ask is still born into an `ask-hours` window nothing will
 * open; that residue is mt#4421's.
 *
 * That does not revive these two buttons. What made them harmful was never
 * `routed` itself but that they were an entrance to it with no window context
 * and nothing to bring the Ask back — a `routed` ask they created belonged to
 * no cohort, so no window-open would ever pick it up. Restoring a real defer
 * (a `snoozedUntil` column plus something that fires when it elapses) is still
 * the delivery-layer work described at the end of this docblock.
 *
 * ## The visibility half is fixed only for OPERATOR-routed asks (mt#4361)
 *
 * The unfiltered `GET /api/asks` below lists asks in `routed` as well as
 * `suspended` — but BOTH of its paths then filter on
 * `routingTarget === OPERATOR_ROUTING_TARGET`. This docblock used to conclude
 * from that widening that "an ask in `routed` is no longer invisible to the
 * operator", which is true as written and empty in practice, because the two
 * populations are disjoint: `routeResultToOutcomeWrite` sends every
 * operator-bound ask straight to `suspended`, and since mt#3491 made the
 * buttons below inert, no operator-routed ask enters `routed` at all.
 *
 * So the real `routed` population — subagent/mesh/retriever, the transports
 * that do not exist — is NOT visible here and this endpoint is not where it
 * becomes visible. mt#4361's answer is the age dimension on
 * `getAskStateCounts` (`packages/domain/src/ask/state-counts-provider.ts`),
 * surfaced on `debug_systemInfo`: deliberately a signal rather than a sweep,
 * because an ask in `routed` is one no human and no agent has ever seen, and
 * retiring it on age would discard an undelivered question.
 *
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
        res.status(503).json({
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
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
      if (await respondIfDatabaseUnavailable(res, err, "asks")) return;
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
   * GET /api/asks — list operator-routed asks (mt#1916; state filter mt#4092)
   *
   * With NO query params: all `suspended` asks routed to "operator", sorted by
   * priority — the pending decision queue, unchanged since mt#1916. Returns
   * `{ asks, total }`.
   *
   * With `?state=`: the same operator-routed scoping, but over the requested
   * states instead of `suspended`, ordered most-recently-concluded first and
   * capped (`?limit=`, default DEFAULT_FILTERED_LIMIT). Returns
   * `{ asks, total, returned, truncated }`, where `total` is the TRUE match
   * count before the cap — the same shape the `asks_list` MCP command already
   * uses, so there is one convention for a capped ask list rather than two.
   * `?state=terminal` expands to every terminal state.
   *
   * `?project=<slug>` scopes either path to one project (mt#2418); omitted or
   * `"all"` means ALL_PROJECTS, the behavior this endpoint has always had.
   *
   * ## Why the default had to stay exactly as it was (mt#4092)
   *
   * Until this endpoint took a filter there was no way to reach a resolved ask
   * from the cockpit at all: the per-id route resolves any state (mt#2669), so
   * a closed ask was reachable if — and only if — you already held its
   * deeplink. But `/asks` is an ATTENTION surface, and its value comes from
   * showing only what still needs the principal. So the filter is opt-in and
   * the resolved view is a drill-down: a caller that passes nothing sees the
   * pending queue and nothing else, which is what the home triage band and
   * every existing consumer depend on.
   *
   * The `routingTarget === "operator"` predicate is applied on BOTH paths, not
   * just the default. It is load-bearing on the filtered path: terminal asks
   * are dominated by reviewer- and policy-routed rows that were never the
   * operator's decisions, and dropping the predicate would bury the handful
   * they actually made.
   *
   * Architecture note: the cockpit server is a direct domain-layer consumer
   * (same as the mt#1147 resolve endpoint). MCP tools (asks_respond,
   * asks_reconcile) are the agent-facing interface to the same domain
   * operations — the cockpit backend does not route through MCP to itself.
   */
  app.get("/api/asks", async (req, res) => {
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const { isTerminal, ALL_ASK_STATES, TERMINAL_ASK_STATES } = await import(
        "@minsky/domain/ask/state-machine"
      );
      const { compareAskPriority } = await import("@minsky/domain/ask/pending-asks-for-window");

      const filter = parseAskStateFilter(req.query.state, {
        all: ALL_ASK_STATES,
        terminal: TERMINAL_ASK_STATES,
      });
      if (!filter.ok) {
        res.status(400).json({
          error:
            `Unknown ask state(s): ${filter.invalid.join(", ")}. ` +
            `Valid: ${[...ALL_ASK_STATES, TERMINAL_STATE_ALIAS].join(", ")}`,
        });
        return;
      }

      // `?project=` (mt#2418), on BOTH paths. Absent or `"all"` resolves to
      // ALL_PROJECTS, which the repository treats identically to passing
      // nothing — so the no-param response is unchanged, while the two views
      // can never end up scoped differently from each other. The resolver owns
      // its own db-fetch and never throws (fail-open to ALL_PROJECTS), so a
      // scoping failure cannot take this route down.
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectScope = await resolveCockpitProjectScope(projectParam);

      if (filter.states === null) {
        // Unfiltered = "what is still waiting on the operator", which spans
        // `routed` as well as `suspended` (mt#4313).
        //
        // This list was suspended-only for as long as nothing ever moved an
        // operator ask INTO `routed` — the docblock above calls `routed` a trap
        // state precisely because its only entrances were the two inert
        // defer/escalate buttons. The service-window reaper is now a third
        // entrance and a legitimate one: it transitions a cohort
        // `suspended -> routed` when its window opens. Reading only `suspended`
        // here would make the whole cohort vanish from this page at window-open
        // — the same disappearance mt#3491 removed the buttons to prevent.
        //
        // `pendingAsksForWindow` has always spanned both states, so this brings
        // the generic page in line with the window surfaces rather than
        // inventing a rule.
        const [routed, suspended] = await Promise.all([
          repo.listByState("routed", projectScope),
          repo.listByState("suspended", projectScope),
        ]);
        const operatorAsks = [...routed, ...suspended].filter(
          (a) => a.routingTarget === OPERATOR_ROUTING_TARGET && !isTerminal(a.state)
        );
        operatorAsks.sort(compareAskPriority);
        const asks = operatorAsks.map(toAskListRow);
        res.json({ asks, total: asks.length });
        return;
      }

      // One query, filtered/ordered/limited in SQL — see the repository method's
      // docblock for why the obvious `listByState`-per-state composition is not
      // usable at this set size.
      const summary = wantsSummary(req.query.summary);
      const limit = parseFilteredLimit(req.query.limit, summary);
      const { asks: page, total } = await repo.listByStatesForRoutingTarget({
        states: filter.states as Ask["state"][],
        routingTarget: OPERATOR_ROUTING_TARGET,
        limit,
        projectScope,
      });

      res.json({
        asks: page.map(summary ? toAskSummaryRow : toAskListRow),
        total,
        returned: page.length,
        truncated: total > page.length,
      });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "asks")) return;
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/asks/ids — every `(shortId, id)` pair, any state (mt#4095)
   *
   * Returns: `{ ids: { shortId, id }[] }`
   *
   * The linkifier's id-set. `use-entity-index.ts` decides SYNCHRONOUSLY at
   * render whether an `ask#N` in prose becomes a link, so the set must be
   * complete before the first render — an async per-id resolve cannot serve it.
   * Uncapped and state-agnostic for the same reason `/api/tasks/ids` is: the
   * property that makes it useful is comprehensiveness. Two columns, so being
   * uncapped is affordable.
   *
   * Before this endpoint, that alias map was built from the attention widget's
   * cohort — pending asks only — so an `ask#N` linkified while its ask was open
   * and silently stopped resolving the moment it closed.
   *
   * IMPORTANT: registered BEFORE `/api/asks/:id`, or Express's first-match-wins
   * routing captures the literal "ids" segment as an ask id (the same ordering
   * constraint `/api/tasks/ids` documents).
   */
  app.get("/api/asks/ids", async (req, res) => {
    try {
      const repo = askRepoOverride ?? (await getServerAskRepository());
      if (!repo) {
        res.status(503).json({
          error: `Ask repository unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectScope = await resolveCockpitProjectScope(projectParam);
      const ids = await repo.listShortIdsForRoutingTarget({
        routingTarget: OPERATOR_ROUTING_TARGET,
        projectScope,
      });
      res.json({ ids });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "asks")) return;
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
      if (await respondIfDatabaseUnavailable(res, err, "asks")) return;
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
      if (await respondIfDatabaseUnavailable(res, err, "asks")) return;
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
