/**
 * Shared Asks Commands
 *
 * Surfaces the Ask subsystem (mt#1034 / ADR-008) at the CLI/MCP layer.
 *
 * - `asks.list` — read-only inspection of Asks with optional state/kind filters.
 *   Supports a `summary` projection mode (mt#2748) that returns lightweight
 *   rows (id/kind/state/title/routingTarget/parentTaskId/createdAt/routedAt)
 *   instead of full records — default stays full-body for back-compat (see
 *   `asks.get` below for the ergonomic single-record path).
 * - `asks.get` — read-only fetch of a single full Ask record by id or
 *   unambiguous UUID prefix (mt#2696 convention). Wired as mt#2748 — the
 *   ergonomic complement to `asks.list summary:true` (list to browse/filter,
 *   get to inspect one record without pulling a whole page).
 * - `asks.reconcile` — runs one reconcile pass over open quality.review Asks.
 *   Uses a production GithubReviewClient backed by `listReviews` infrastructure
 *   and routed through the project's TokenProvider. Wired as mt#1292.
 * - `asks.create` — agent-facing producer surface. Persists a new Ask via
 *   `AskRepository` and computes routing via mt#1069's `policyFirstRoute`.
 *   The capability-aware extension (sync kinds → elicitation when host
 *   advertises capability) lands in mt#1457. Wired as mt#1456.
 * - `asks.respond` — operator-facing response surface. Walks a suspended
 *   Ask through `responded → closed` with the operator's message as the
 *   response payload. Wired as mt#1458 (per mt#454 slim research: v1 verb
 *   set is `list` + `respond` only).
 * - `asks.edit` — content-update surface (mt#2668). Updates a non-terminal
 *   Ask's question/title/options/contextRefs/metadata in place WITHOUT
 *   consuming it — a suspended Ask stays suspended and stays in the operator
 *   queue. Appends an editHistory provenance note on every edit.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandExecutionContext,
} from "../command-registry";
import { ValidationError } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import { APPROVAL_TOKEN_EXAMPLES, isApproveShapedToken } from "@minsky/shared/ask-approval";
import { emitAnsweredAskWakeBestEffort } from "./asks-answered-wake";
import {
  DrizzleAskRepository,
  type AskRepository,
  type CreateAskInput,
} from "@minsky/domain/ask/repository";
import { respondAndCloseAsk } from "@minsky/domain/ask/repository";
import {
  isAutomatedClosureResponder,
  closeAskAsResolved,
} from "@minsky/domain/ask/close-as-resolved";
import {
  editAskContent,
  providedEditableFields,
  FORBIDDEN_METADATA_KEYS,
  type EditAskContentParams,
} from "@minsky/domain/ask/edit";
import type { Ask, AskKind, AskState, AskOption, ContextRef } from "@minsky/domain/ask/types";
import { reconcile, type ReconcileResult } from "@minsky/domain/ask/reconciler";
import { getOpenIncidentAsks } from "@minsky/domain/ask/queries";
import {
  CompositeWakeSignalSink,
  LoggingWakeSignalSink,
  PersistentWakeSignalSink,
  type WakeSignalSink,
} from "@minsky/domain/ask/wake-on-respond";
import { DrizzleWakePendingRepository } from "@minsky/domain/ask/wake-pending-repository";
import {
  policyFirstRoute,
  buildPolicyClosedEvent,
  type RoutedAsk,
  type SuspendedAsk,
  type PolicyFirstRouteOptions,
  isSuspendedAsk,
} from "@minsky/domain/ask/router";
import {
  dispatchToElicitation,
  type ElicitationClosedAsk,
} from "@minsky/domain/ask/transports/elicitation";
import { routeResultToOutcomeWrite } from "@minsky/domain/ask/advancement";
import { repairAskGraph } from "@minsky/domain/ask/repair";
import { asksRepairParams, buildRepairDeps } from "./asks-repair";
import {
  askWaitForResponse,
  type AskWaitForResponseResult,
} from "@minsky/domain/ask/wait-for-response";
import { SystemOperatorNotify } from "@minsky/domain/notify/operator-notify";
// Severity transport binding (mt#3595)
import {
  notifyPrincipal,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
import { emitSystemEventFromProvider } from "@minsky/domain/events/emit-best-effort";
import {
  PAGE_RATE_LIMIT_MAX,
  PAGE_RATE_LIMIT_WINDOW_MS,
  pagePrincipalForAsk,
  type PrincipalPageDeps,
} from "@minsky/domain/ask/principal-page";
import type { AskSeverity } from "@minsky/domain/ask/types";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { describeContainerPersistenceUnavailability } from "./persistence-unavailability";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import type { ClientCapabilityRegistry } from "../../../mcp/client-capabilities";
import { makeProductionGithubReviewClient } from "./asks-github-client";
import { emitSystemEventBestEffort } from "./system-event-emit";
import { getServiceWindowDefault } from "@minsky/domain/ask/service-window-defaults";
import { createEventEmitter } from "@minsky/domain/events/emitter";
import { asksTable } from "@minsky/domain/storage/schemas/ask-schema";
import {
  resolveEntityIdPrefixOrThrow,
  classifyIdInput,
} from "@minsky/domain/utils/id-prefix-resolver";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  computeFormLintMatches,
  findSerializedParameterArtifact,
  type FormLintMatch,
} from "@minsky/domain/ask/form-lint";
import { linkifyExternalRefs } from "@minsky/domain/ask/external-refs";
import { appendAskFormLintCalibrationRecord } from "./ask-form-lint-calibration";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_STATES: AskState[] = [
  "detected",
  "classified",
  "routed",
  "suspended",
  "responded",
  "closed",
  "cancelled",
  "expired",
];

const ALL_KINDS: AskKind[] = [
  "capability.escalate",
  "information.retrieve",
  "authorization.approve",
  "direction.decide",
  "coordination.notify",
  "quality.review",
  "stuck.unblock",
];

// ---------------------------------------------------------------------------
// Repository factory
// ---------------------------------------------------------------------------

/**
 * Build a `CompositeWakeSignalSink` for `reconcile()` that fans out wake events
 * to both the logging sink (operator stdout — mt#1481) and the persistent sink
 * (wake_pending table — mt#1661 v0). When the persistence provider is
 * unavailable, falls back to logging-only so reconcile keeps working.
 *
 * mt#1519 §5 / mt#1661 v0 — pull-on-tool-call delivery via wake-enrichment
 * middleware drains the persistent sink at subsequent MCP tool calls.
 */
async function buildCompositeWakeSink(
  container: AppContainerInterface | undefined
): Promise<WakeSignalSink> {
  const sinks: WakeSignalSink[] = [new LoggingWakeSignalSink()];

  if (container?.has("persistence")) {
    try {
      const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
      if (persistenceProvider.getDatabaseConnection) {
        const db = await persistenceProvider.getDatabaseConnection();
        if (db) {
          sinks.push(new PersistentWakeSignalSink(new DrizzleWakePendingRepository(db)));
        }
      }
    } catch (err: unknown) {
      log.warn("asks.reconcile: could not initialize PersistentWakeSignalSink", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new CompositeWakeSignalSink(sinks);
}

/**
 * Resolve the raw Postgres connection from the DI container's persistence
 * provider. Shared by `buildAskRepository` (below) and the mt#2696
 * id-prefix-resolution helper so both use the same connection-resolution
 * logic instead of two independently maintained copies.
 *
 * Returns null on any resolution problem (no container, no SQL capability,
 * no connection) — never throws. Callers surface their own clear error.
 */
async function getAskDb(
  container: AppContainerInterface | undefined
): Promise<PostgresJsDatabase | null> {
  if (!container?.has("persistence")) return null;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return null;
    const db = await persistenceProvider.getDatabaseConnection();
    return db ?? null;
  } catch (err: unknown) {
    log.warn("asks: could not resolve database connection", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build a `DrizzleAskRepository` from the persistence provider's DB connection.
 *
 * Returns null when the provider does not support SQL capability or when no
 * DB connection is available; callers should surface a clear error in that case.
 */
export async function buildAskRepository(
  container: AppContainerInterface | undefined
): Promise<AskRepository | null> {
  const db = await getAskDb(container);
  return db ? new DrizzleAskRepository(db) : null;
}

/**
 * Build the repository or throw an error that NAMES why it is unavailable
 * (mt#3636).
 *
 * The eight ask commands previously each threw
 * "AskRepository unavailable — persistence provider does not support SQL".
 * That is loud — which is already better than the task read path, which
 * answered empty — but it does not distinguish "Postgres was never configured"
 * from "Postgres is configured and the boot connection failed", and those need
 * opposite responses from the operator. The discriminating detail lives on
 * `UnconfiguredPersistenceProvider`; this surfaces it.
 */
export async function requireAskRepository(
  container: AppContainerInterface | undefined,
  operation: string
): Promise<AskRepository> {
  const repo = await buildAskRepository(container);
  if (repo) return repo;

  // Extracted to ./persistence-unavailability (mt#3661) so the six other
  // adapter-side callers of the same pattern share one implementation. Behavior
  // is unchanged, including the never-throw fallback.
  const cause = await describeContainerPersistenceUnavailability(container, "asks");

  throw new Error(`${operation}: AskRepository unavailable — ${cause}`);
}

/**
 * Resolve a caller-supplied ask id — a full UUID, an unambiguous 8-char hex
 * prefix (mt#2696), or an `ask#N` short id (mt#2965/mt#2963) — to the full
 * UUID `asks.id` before it reaches any `eq(asksTable.id, ...)` comparison in
 * the repository. A full UUID passes through unchanged with no query. A
 * short/no-match/ambiguous prefix, or an `ask#N` with no matching row, throws
 * a clean tool-level error (never a raw Postgres "invalid input syntax for
 * type uuid" error).
 *
 * When no DB connection is resolvable here, the raw input passes through —
 * the immediately-following `buildAskRepository` call in every command
 * surfaces the "AskRepository unavailable" error instead.
 *
 * Exported for unit testing (asks.test.ts) — not part of the public command
 * surface.
 */
export async function resolveAskIdInput(
  id: string,
  container: AppContainerInterface | undefined
): Promise<string> {
  const db = await getAskDb(container);
  if (!db) return id;

  return resolveEntityIdPrefixOrThrow({
    db,
    table: asksTable,
    idColumn: asksTable.id,
    labelColumn: asksTable.title,
    input: id,
    entityName: "ask",
    shortIdColumn: asksTable.shortId,
    shortIdPrefix: "ask",
  });
}

/**
 * Fetch a single Ask by its already-resolved id, or throw a clean not-found
 * error naming how the caller's input was interpreted (mt#2748, reusing the
 * mt#2696 R1 message-shaping convention from `memory.get`).
 *
 * Split out from the `asks.get` command's `execute` closure specifically so
 * it's unit-testable against a `FakeAskRepository` without needing to wire a
 * DI container (the prefix-resolution DB lookup that produces `resolvedId`
 * is already covered by `id-prefix-resolver.test.ts` and the existing
 * `asks.respond`/`asks.edit`/`asks.wait-for-response` usages of the same
 * `resolveAskIdInput` helper).
 */
export async function getAskByResolvedId(
  repo: AskRepository,
  rawId: string,
  resolvedId: string
): Promise<Ask> {
  const ask = await repo.getById(resolvedId);
  if (!ask) {
    // mt#2696 R1: name both what the caller passed AND how it was
    // interpreted (full UUID vs prefix) rather than echoing the raw input
    // unconditionally.
    const classification = classifyIdInput(rawId);
    const message =
      classification.kind === "prefix"
        ? resolvedId !== rawId
          ? `Ask not found for id prefix "${rawId}" (resolved to "${resolvedId}")`
          : `Ask not found for id prefix "${rawId}"`
        : `Ask not found with id "${resolvedId}"`;
    throw new Error(message);
  }
  return ask;
}

// ---------------------------------------------------------------------------
// asks.list
// ---------------------------------------------------------------------------

const asksListParams = {
  id: {
    schema: z.string().trim().min(1).optional(),
    description:
      "Filter to a single Ask by id — accepts a full UUID, an unambiguous prefix " +
      "(>=8 hex chars, mt#2696), or an `ask#N` short id (mt#2965). Resolved via the " +
      "same generalized resolver used by asks.respond/edit/wait-for-response; throws " +
      "if the id does not resolve to exactly one Ask.",
    required: false,
  },
  state: {
    schema: z.enum(ALL_STATES as [AskState, ...AskState[]]).optional(),
    description: "Filter by Ask state (detected | classified | routed | ...)",
    required: false,
  },
  kind: {
    schema: z.enum(ALL_KINDS as [AskKind, ...AskKind[]]).optional(),
    description: "Filter by Ask kind (quality.review | direction.decide | ...)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results",
    required: false,
    defaultValue: 50,
  },
  allProjects: {
    schema: z.boolean().optional(),
    description:
      "Return asks from all projects (disable project-scope filtering; ADR-021, mt#2416)",
    required: false,
  },
  summary: {
    schema: z.boolean().optional(),
    description:
      "When true, return compact rows (id, kind, state, title, routingTarget, " +
      "parentTaskId, createdAt, routedAt) with no question/options/contextRefs/metadata " +
      "body (mt#2748). Default false preserves full ask records for back-compat — pass " +
      "`summary: true` to browse/filter cheaply, or use `asks_get` to fetch one full " +
      "record by id. The result echoes `summary` (mt#2748 R1 review) so callers can " +
      "branch safely: `summary: true` on the result means `asks` is `AskSummaryRow[]`; " +
      "absent/false means `asks` is the full `Ask[]`.",
    required: false,
  },
};

/** Compact projection of an `Ask` for `asks.list summary:true` (mt#2748). */
export interface AskSummaryRow {
  id: string;
  kind: AskKind;
  state: AskState;
  title: string;
  routingTarget?: Ask["routingTarget"];
  parentTaskId?: string;
  createdAt: string;
  routedAt?: string;
}

/**
 * Project a full `Ask` record down to the summary column set (mt#2748).
 * Deliberately omits `question`, `options`, `contextRefs`, `response`, and
 * `metadata` (including `metadata.editHistory`) — the multi-KB "body"
 * fields that made `asks.list` unsafe to page through at the store's
 * current size (see the mt#2748 spec's originating incident).
 */
export function toAskSummary(ask: Ask): AskSummaryRow {
  return {
    id: ask.id,
    kind: ask.kind,
    state: ask.state,
    title: ask.title,
    routingTarget: ask.routingTarget,
    parentTaskId: ask.parentTaskId,
    createdAt: ask.createdAt,
    routedAt: ask.routedAt,
  };
}

interface AsksListResultBase {
  /** True count of everything matching the filters, before the `limit` slice. */
  total: number;
  limit: number;
  /** Number of asks actually returned in `asks` (mt#2817). */
  returned: number;
  /** `returned < total` — true when this payload does NOT contain every match (mt#2817). */
  truncated: boolean;
}

/** Full-record `asks.list` result — the default (no `summary` requested). */
export interface AsksListFullResult extends AsksListResultBase {
  /** Discriminator (mt#2748 R1 review) — absent/false when full records were returned. */
  summary?: false;
  asks: Ask[];
}

/** Compact-projection `asks.list` result — returned when `summary: true` was requested. */
export interface AsksListSummaryResult extends AsksListResultBase {
  summary: true;
  asks: AskSummaryRow[];
}

/**
 * Discriminated union (mt#2748 R1 review): `asks.list`'s `execute` returns either
 * variant depending on the caller's `summary` param. Branch on `result.summary` to
 * safely narrow `result.asks` to `Ask[]` vs `AskSummaryRow[]` — no unsafe cast needed.
 */
export type AsksListResult = AsksListFullResult | AsksListSummaryResult;

async function gatherAsks(
  repo: AskRepository,
  state: AskState | undefined,
  kind: AskKind | undefined,
  projectScope?: import("@minsky/domain/project/scope").ProjectScope
): Promise<Ask[]> {
  if (state) {
    const subset = await repo.listByState(state, projectScope);
    return kind ? subset.filter((a) => a.kind === kind) : subset;
  }
  // No state filter — gather across all states.
  const all: Ask[] = [];
  for (const s of ALL_STATES) {
    const subset = await repo.listByState(s, projectScope);
    all.push(...subset);
  }
  return kind ? all.filter((a) => a.kind === kind) : all;
}

/**
 * Filter params accepted by `listAsksFiltered` — mirrors `asks.list`'s
 * `asksListParams` shape (already-narrowed types, not raw MCP params).
 */
export interface ListAsksFilters {
  /** Raw id/prefix/short-id input — resolved via the injected `resolveId`. */
  id?: string;
  state?: AskState;
  kind?: AskKind;
  limit?: number;
  projectScope?: import("@minsky/domain/project/scope").ProjectScope;
}

/**
 * Core `asks.list` filtering logic (mt#2965 R1 — PR #2110), extracted from
 * the command's `execute` handler so it's directly unit-testable without a
 * live DB. `resolveId` is injected: production wires the real
 * `resolveAskIdInput` (uuid / 8-char hex prefix / `ask#N` short id, all
 * resolved via the SAME generalized resolver `asks.respond`/`edit`/
 * `wait-for-response` use — mt#2696 / mt#2965); tests can supply a trivial
 * stand-in since `resolveAskIdInput`'s own resolution correctness is
 * covered separately (see the `resolveAskIdInput` describe block).
 *
 * When `params.id` is supplied, the resolved uuid is applied as an
 * additional AND-filter on top of any `state`/`kind`/`projectScope`
 * filters — an id that resolves successfully but whose Ask does not match
 * the other filters yields an empty result, not an error.
 */
export async function listAsksFiltered(
  repo: AskRepository,
  resolveId: (id: string) => Promise<string>,
  params: ListAsksFilters
): Promise<AsksListFullResult> {
  const resolvedId = params.id ? await resolveId(params.id) : undefined;
  const gathered = await gatherAsks(repo, params.state, params.kind, params.projectScope);
  const asks = resolvedId ? gathered.filter((a) => a.id === resolvedId) : gathered;
  const limit = params.limit ?? 50;
  const returnedAsks = asks.slice(0, limit);
  return {
    asks: returnedAsks,
    total: asks.length,
    limit,
    returned: returnedAsks.length,
    truncated: returnedAsks.length < asks.length,
  };
}

// ---------------------------------------------------------------------------
// asks.get (mt#2748)
// ---------------------------------------------------------------------------

const asksGetParams = {
  id: {
    schema: z.string().trim().min(1),
    description:
      "Ask ID to fetch. Accepts a full UUID, an unambiguous prefix (>=8 hex chars, " +
      "mt#2696), or an `ask#N` short id (mt#2965) — resolved via the same generalized " +
      "resolver asks.list/respond/edit/wait-for-response use.",
    required: true,
  },
};

// ---------------------------------------------------------------------------
// asks.reconcile
// ---------------------------------------------------------------------------

const asksReconcileParams = {};

// ---------------------------------------------------------------------------
// asks.respond — schemas + helper (mt#1458)
// ---------------------------------------------------------------------------

const asksRespondParams = {
  id: {
    schema: z.string().trim().min(1),
    description: "Ask ID (UUID) to respond to",
    required: true,
  },
  message: {
    schema: z.string().trim().min(1),
    description: "Operator response message — becomes response.payload.message",
    required: true,
  },
  responder: {
    schema: z.string().trim().min(1),
    description: "AgentId or 'operator' identifier; defaults to 'operator'",
    required: false,
    defaultValue: "operator",
  },
};

/**
 * Default responder for `asks.cancel` when the caller names none.
 *
 * Deliberately NOT `"operator"`, unlike `asksRespondParams.responder` above
 * (mt#3353). `respondAndCloseAsk` falls back to `"operator"` on an omitted
 * responder (`repository.ts`), so with no cancel verb the live practice became
 * retiring an ask by ANSWERING it as its own author — which records the
 * PRINCIPAL as having decided something they never saw. Withholding the verb did
 * not protect the audit trail; it laundered agent withdrawals into the
 * principal's answered record (mem#1122, mem#1007). A cancel path that inherited
 * that default would reproduce the defect it exists to remove.
 */
const DEFAULT_CANCEL_RESPONDER = "system:agent-cancelled";

const asksCancelParams = {
  id: {
    schema: z.string().trim().min(1),
    description:
      "Ask ID to cancel. Accepts a full UUID, an unambiguous prefix (>=8 hex chars), or an `ask#N` short id.",
    required: true,
  },
  reason: {
    schema: z.string().trim().min(1),
    description:
      "Why this Ask is being retired — persisted as the cancellation disposition. Required: a cancellation with no reason is indistinguishable from the unattributed cancellations this command exists to replace.",
    required: true,
  },
  responder: {
    schema: z.string().trim().min(1),
    description: `Who is cancelling — conventionally \`system:<event>\`. Defaults to \`${DEFAULT_CANCEL_RESPONDER}\`. The literal \`operator\` is REJECTED: cancelling is not answering, and recording the principal as the responder is the provenance laundering this command exists to end.`,
    required: false,
    defaultValue: DEFAULT_CANCEL_RESPONDER,
  },
};

/** Result of `asks.cancel`. */
export interface CancelAskResult {
  askId: string;
  outcome: "closed" | "cancelled" | "already-terminal" | "not-found" | "skipped";
  responder: string;
  reason: string;
}

/**
 * Terminally cancel an Ask that no transport ever dispatched (mt#3353).
 *
 * Extracted from the `asks.cancel` handler rather than written inline so the
 * decision it makes — chiefly the `operator` rejection — is observable from a
 * test without standing up the command registry, matching the `respondToAsk`
 * helper beside it. `id` is expected ALREADY RESOLVED to a full uuid; short-id
 * resolution needs the container and stays at the handler boundary.
 */
export async function cancelAsk(
  repo: AskRepository,
  params: { id: string; reason: string; responder?: string }
): Promise<CancelAskResult> {
  const responder =
    (params.responder ?? DEFAULT_CANCEL_RESPONDER).trim() || DEFAULT_CANCEL_RESPONDER;
  const reason = params.reason.trim();

  // The one hard rule this command carries. Cancelling is not answering, and an
  // ask recorded against `operator` reads as a decision the principal made —
  // see DEFAULT_CANCEL_RESPONDER above for why that is the exact failure this
  // command exists to end. Rejected rather than silently rewritten, so a caller
  // that meant to ANSWER is told to use `asks.respond` instead of having its
  // intent quietly changed.
  if (responder.toLowerCase() === "operator") {
    throw new ValidationError(
      'asks.cancel: `responder` may not be "operator" — cancelling is not answering, ' +
        "and recording the principal as the responder would misreport an agent " +
        "withdrawal as a principal decision. Use `asks.respond` to record a real " +
        `answer, or pass a \`system:<event>\` responder (default: ${DEFAULT_CANCEL_RESPONDER}).`
    );
  }

  const outcome = await closeAskAsResolved(repo, params.id, {
    responder,
    payload: { reason, cancelledVia: "asks.cancel" },
  });

  return { askId: params.id, outcome: outcome.kind, responder, reason };
}

/**
 * Typed input for `respondToAsk` — the internal helper exposed for testing.
 *
 * NOT a handler annotation type (mt#2779): the `asks.respond` execute handler
 * derives its params from the map by inference; this type only covers direct
 * programmatic callers of the helper.
 */
// eslint-disable-next-line custom/no-hand-rolled-command-params -- internal-helper input type for direct programmatic callers, not a handler annotation (mt#2779)
export interface RespondToAskParams {
  id: string;
  message: string;
  responder?: string;
}

/**
 * Result shape returned by `respondToAsk`. Always reflects the closed Ask
 * (post `responded → closed` walk) so callers see the final state, not the
 * intermediate `responded`.
 */
export type RespondToAskResult = {
  ask: Ask;
};

/**
 * Validate inputs to `respondToAsk`. Mirrors the zod schema on the
 * `asks.respond` shared command. The schema applies trim() at the surface;
 * this helper applies the same enforcement so direct programmatic callers
 * see the same validation behavior.
 */
function validateRespondParams(params: RespondToAskParams): void {
  if (!params.id || params.id.trim() === "") {
    throw new Error("asks.respond: id is required and must not be empty");
  }
  if (!params.message || params.message.trim() === "") {
    throw new Error("asks.respond: message is required and must not be empty");
  }
  if (params.responder !== undefined && params.responder.trim() === "") {
    throw new Error("asks.respond: responder, if provided, must not be empty");
  }
}

/**
 * Respond to a suspended Ask via the operator surface.
 *
 * Walks the persisted Ask atomically from `"suspended"` to `"closed"` via
 * `repo.respondAndClose`, recording the operator's message as the response
 * payload and `attentionCost` on the closed row (per the `Ask.response`
 * contract in `types.ts` — "`attentionCost` is filled on close").
 *
 * Atomicity (concurrency safety): the underlying `respondAndClose` uses
 * optimistic-concurrency in the Drizzle backend (`WHERE state = 'suspended'`),
 * so a concurrent cancel/expire/close between read and write surfaces a
 * `ConcurrentTransitionError` rather than leaving the Ask stuck in a
 * partially-updated state. The Fake backend mirrors the same precondition.
 *
 * Pre-conditions (validated up front; throw clear errors on violation):
 *   - `params.id` is a non-empty string.
 *   - `params.message` is a non-empty (post-trim) string.
 *   - Ask exists (`repo.getById` returns non-null).
 *   - Ask is in `"suspended"` state. Earlier states (detected/classified/routed)
 *     mean no transport has dispatched yet; terminal states
 *     (closed/cancelled/expired) cannot be responded to.
 *
 * Note: at v1, `routingTarget === "operator"` is NOT enforced. The router
 * (`policyFirstRoute`) does not persist `routingTarget`, so the persisted
 * row keeps `routingTarget = undefined`. By elimination at v1, every Ask
 * that legitimately reaches `"suspended"` is operator-bound. When a non-
 * operator transport starts using `"suspended"`, re-introduce a gate here.
 *
 * Per mt#454 slim research output (Q3): v1 verb set is `list` + `respond`
 * only. `claim` / `release` / `close` / `reopen` are deferred to mt#454-impl.
 */
export async function respondToAsk(
  repo: AskRepository,
  params: RespondToAskParams
): Promise<RespondToAskResult> {
  validateRespondParams(params);

  // Trim before constructing the payload so direct programmatic callers
  // see the same normalized message that CLI/MCP callers do (the schema
  // applies trim() at the surface).
  const message = params.message.trim();

  // Delegates the suspended-state precondition check, responder trimming,
  // and ConcurrentTransitionError handling to the shared domain function
  // (mt#2615) — this surface's only job is to shape the plain-message
  // payload and the fixed inbox/CLI attentionCost.
  const { ask } = await respondAndCloseAsk(repo, {
    id: params.id,
    responder: params.responder,
    payload: { message },
    attentionCost: {
      // The operator responded via the inbox/CLI surface. The original
      // transport is preserved on the Ask record; the attentionCost.transport
      // here records the surface that *resolved* it.
      transport: "inbox",
      resolvedIn: "inbox",
      // operatorCost is intentionally absent at v1 — deferred to mt#454-impl
      // along with claim/release semantics.
    },
  });

  return { ask };
}

// ---------------------------------------------------------------------------
// asks.create — schemas
// ---------------------------------------------------------------------------

/**
 * Decision-frame option accepted at the CLI/MCP boundary.
 *
 * `value` is declared OPTIONAL here and normalized to `label` when absent
 * (mt#3181). It was previously `z.unknown()`, which Zod treats as optional
 * inside `z.object` — so `{label, description}` (the shape
 * `humility.mdc §Escalation packaging` describes, and the shape agents
 * naturally write) validated cleanly and stored an option with NO `value`.
 * Every response writer records the SELECTION by stringifying `option.value`,
 * so answering such an Ask persisted an empty selection and silently lost the
 * operator's choice — the Ask still reported `closed` with `respondedAt` set.
 * Observed on ask#5769 (`{"chosen": "", "option": ""}`).
 *
 * Defaulting beats rejecting here: `{label, description}` is the documented
 * calling convention across many agent callsites, so rejecting it would break
 * working callers to fix a bug none of them caused. `label` is a meaningful
 * machine value.
 *
 * The transform is load-bearing at BOTH boundaries: `convertMcpArgsToParameters`
 * (`src/adapters/mcp/shared-command-integration.ts`) assigns `schema.parse(value)`
 * — the parse OUTPUT — since mt#3155, and `normalizeCliParameters`
 * (`src/adapters/shared/bridges/parameter-mapper.ts`) has always done the same.
 */
export const askOptionSchema = z
  .object({
    label: z.string(),
    value: z.unknown().optional(),
    description: z.string().optional(),
  })
  .transform((option) => ({
    ...option,
    value: option.value === undefined ? option.label : option.value,
  }));

const contextRefSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  description: z.string().optional(),
});

// Exported (not just used internally) so tests can run raw CLI/MCP-shaped
// input through the REAL production normalization functions
// (`normalizeCliParameters` / `convertMcpArgsToParameters`) using the actual
// parameter map `asks.create` is registered with — see the
// "validate receives parsed params" pinning test in asks.test.ts (mt#3203
// review R1) — rather than a hand-rolled duplicate parameter map that could
// drift from the real one.
export const asksCreateParams = {
  kind: {
    schema: z.enum(ALL_KINDS as [AskKind, ...AskKind[]]),
    description: "Ask kind (one of the 7 ADR-008 taxonomy values)",
    required: true,
  },
  title: {
    schema: z.string().min(1),
    description: "Short summary line used for list rendering and notifications",
    required: true,
  },
  question: {
    schema: z.string().min(1),
    description: "Full ask body — what the requestor needs resolved",
    required: true,
  },
  options: {
    schema: z.array(askOptionSchema).optional(),
    description: "Decision frame: array of {label, value, description?}; for decision-like kinds",
    required: false,
  },
  contextRefs: {
    schema: z.array(contextRefSchema).optional(),
    description: "Pointers to artifacts the responder may need",
    required: false,
  },
  parentTaskId: {
    schema: z.string().optional(),
    description: "Parent task ID (e.g. mt#123)",
    required: false,
  },
  parentSessionId: {
    schema: z.string().optional(),
    description: "Parent session UUID when the Ask originates in an active session",
    required: false,
  },
  deadline: {
    schema: z.string().optional(),
    description: "ISO-8601 soft deadline; when exceeded the Ask transitions to expired",
    required: false,
  },
  metadata: {
    schema: z.record(z.string(), z.unknown()).optional(),
    description: "Arbitrary metadata for transport adapters and future extensions",
    required: false,
  },
  classifierVersion: {
    schema: z.string(),
    description: "Classifier version (caller-provided; v1 is agent self-declaration)",
    required: false,
    defaultValue: "v1.0.0",
  },
  requestor: {
    schema: z.string().min(1),
    description: "AgentId of the requestor; defaults to a session-unknown marker",
    required: false,
  },
  callerActorId: {
    schema: z.string(),
    description:
      "mt#4476: the caller's resolved conversation-grain agentId (ADR-006), persisted as " +
      "`Ask.filedByAgentId` so an answer to this ask can be delivered back to the " +
      "conversation that filed it on its next tool call. Server-injected from the resolved " +
      "MCP identity (src/mcp/server.ts) — never supplied by hand, and any hand-supplied " +
      "value is overwritten there. That overwrite is the point: `requestor` above is the " +
      "same nominal thing accepted from the caller, and is why it cannot be used as a " +
      "delivery key. Absent on the CLI path and whenever identity falls back to ADR-006 " +
      "Layer 1 (a process hash, which is not conversation-scoped); an ask filed without it " +
      "still works, it just cannot be woken on the tool-call seam.",
    required: false,
    // Server-injected only — hide from the CLI surface so it is not advertised as a
    // hand-passable flag (mirrors observability.calibration-review and
    // tasks.dispatch-recover).
    cliHidden: true,
  },
  // Service-window fields (mt#1411 spine — mt#1488)
  serviceStrategy: {
    schema: z.enum(["asap", "scheduled", "deadline-bound"] as const).optional(),
    description:
      "Routing strategy: 'asap' (default) | 'scheduled' | 'deadline-bound'. " +
      "When absent, per-kind defaults apply.",
    required: false,
  },
  windowKey: {
    schema: z.string().optional(),
    description:
      "Named service window (e.g. 'ask-hours'). Only used when serviceStrategy='scheduled'.",
    required: false,
  },
  forceImmediate: {
    schema: z.boolean().optional(),
    description:
      "When true, bypass the window check and route immediately. " +
      "Use only for critical-path unblocking.",
    required: false,
  },
  severity: {
    schema: z.enum(["incident"] as const).optional(),
    description:
      "Set to 'incident' when a severity trigger fired AND remediation is operator-only " +
      "(production incident, outage, security finding, blocked-past-threshold). On an " +
      "operator-routed ask this sends the principal ONE notification on their phone " +
      "pointing at this ask — you do not need to send a separate notification yourself. " +
      "Both halves are required: an incident you can fix yourself does not warrant it, " +
      "and an operator-only chore that is not a severity event belongs in the normal inbox.",
    required: false,
  },
  // NOTE: `principalPagedAt` is deliberately absent from this schema. It is
  // substrate-owned (mt#3595) — written only after a page actually goes out, so
  // a caller cannot claim a notification it never sent.
  // NOTE: `windowMissedCount` is intentionally omitted from this MCP parameter schema.
  // It is reaper-owned state (mt#1490): the reaper increments it each time a scheduled
  // window opens and the Ask is still pending. Callers must not set it directly via
  // asks.create — createAsk always initialises it to 0 for new Asks.
  acknowledgeFormWarnings: {
    schema: z.boolean().optional(),
    description:
      "When true, bypass the form-lint hard-reject (mt#3326) for this create call. A " +
      "deliberate, per-call override for a genuinely long/complex ask — never a default. " +
      "Recorded on the form-lint calibration log so override frequency stays reviewable via " +
      "/calibration-review. Without it, a create whose question/options fail any form-lint " +
      "check (internal-tool-id, over-word-budget, portal-no-link, long-option-label, " +
      "letter-prefixed-option-label) is rejected with the violations listed.",
    required: false,
  },
};

/**
 * Cross-field coherence validation for `asks.create` MCP params.
 *
 * `windowKey` is only meaningful when `serviceStrategy='scheduled'`. Passing it
 * alongside an *explicitly* non-scheduled strategy is a caller error that should
 * be caught at the parameter boundary — not silently ignored later.
 *
 * When `serviceStrategy` is *absent*, the validation passes. Per-kind defaults in
 * `createAsk` resolve the strategy (e.g., `direction.decide` → `scheduled`), so a
 * caller may legitimately omit `serviceStrategy` and supply a custom `windowKey` —
 * the kind's default resolves to `scheduled`, and the caller's `windowKey` overrides
 * the default window name.
 *
 * Only when `serviceStrategy` is *explicitly* set to a non-scheduled value does a
 * `windowKey` become incoherent: the caller has explicitly chosen a strategy that
 * doesn't use windows, yet is also specifying a window.
 *
 * Exported for direct testing without requiring the full command factory setup.
 * The `asks.create` command's `validate` hook delegates to this function.
 *
 * @throws {ValidationError} when `windowKey` is set AND `serviceStrategy` is explicitly non-scheduled
 */
export function validateAsksCreateParams(params: {
  windowKey?: string;
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
}): void {
  if (
    params.windowKey !== undefined &&
    params.serviceStrategy !== undefined &&
    params.serviceStrategy !== "scheduled"
  ) {
    throw new ValidationError(
      `windowKey is only valid when serviceStrategy='scheduled'. You explicitly set serviceStrategy='${params.serviceStrategy}' but also provided windowKey. ` +
        "Either drop windowKey, set serviceStrategy='scheduled', or omit serviceStrategy to use the kind's default."
    );
  }
}

/**
 * Authoring-time guard against the mt#3203 footgun: an `authorization.approve`
 * Ask whose options can never satisfy the redemption-time approval verifier.
 *
 * `.minsky/hooks/ask-verification.ts` anchors approval to an exact
 * approve-shaped token (`APPROVAL_TOKEN`, imported from
 * `@minsky/shared/ask-approval` — the SAME constant this function checks
 * against, so the two cannot drift apart). `askOptionSchema` defaults an
 * option's `value` to its `label` when no explicit `value` is supplied
 * (mt#3181), so a purely descriptive button label — e.g. "Approve the
 * override and merge" — silently becomes the recorded value and can never
 * verify. Left undetected, this surfaces only at REDEMPTION time (a merge
 * or guard-override attempt), after the operator has already approved, with
 * an error that reads as though they declined.
 *
 * Deliberately narrow in scope, matching the spec's "Does NOT cover":
 *   - Only fires for `kind === "authorization.approve"`. Every other kind's
 *     options are free-form decision frames with no approval verifier to
 *     satisfy.
 *   - Only fires when `options` is non-empty. A free-text (no-options)
 *     `authorization.approve` Ask is a different, already-out-of-scope
 *     failure mode (it correctly fails verification on its own).
 *
 * A caller supplying an explicit approve-shaped `value` alongside an
 * arbitrary human-readable `label` passes: this checks `value`, never
 * `label`, so operator-facing wording is never constrained.
 *
 * Exported for direct testing without requiring the full command factory
 * setup. The `asks.create` command's `validate` hook delegates to this
 * function, matching `validateAsksCreateParams`'s pattern above.
 *
 * @throws {ValidationError} when kind is `authorization.approve`, options are
 *   present, and none of them carries an approve-shaped `value`
 */
export function validateAuthorizationApproveOptions(params: {
  kind?: AskKind;
  options?: Array<{ label: string; value?: unknown }>;
}): void {
  if (params.kind !== "authorization.approve") return;
  if (!params.options || params.options.length === 0) return;

  const hasApproveShapedOption = params.options.some((option) =>
    isApproveShapedToken(option.value)
  );
  if (hasApproveShapedOption) return;

  const labels = params.options.map((option) => `"${option.label}"`).join(", ");
  throw new ValidationError(
    `authorization.approve Ask has no option with an approve-shaped value ` +
      `(${APPROVAL_TOKEN_EXAMPLES.join("/")}). Options given: ${labels}. ` +
      `A descriptive label is not enough — asks_create defaults "value" to "label" when ` +
      `omitted, and only an exact approve-shaped value verifies. Add one explicitly, ` +
      `e.g. {label: "...", value: "approve"} — the label can stay descriptive.`
  );
}

// ---------------------------------------------------------------------------
// asks.create — form-lint hard-reject (mt#3326)
// ---------------------------------------------------------------------------

/**
 * Filters form-lint matches down to the BLOCKING subset — everything except
 * the calibration-first `missing-force-immediate` check (mt#3436). Shared by
 * `validateFormLintNotViolated` (decides whether to hard-reject) and the
 * `asks.create` execute handler (decides the calibration log's
 * `acknowledged` field, see below) so the two can never drift on what counts
 * as blocking. Excluded upstream in `computeFormLintMatches` itself would
 * also hide the check from `formWarnings`/the calibration log entirely —
 * this filters only at the decision points that need the blocking/advisory
 * distinction, not at the point that computes matches.
 *
 * The exclusion list stays a DENYLIST, deliberately: a new check blocks
 * unless it is added here.
 *
 * **No count is stated here on purpose (PR #3158 R1).** This paragraph used to
 * open "Two are excluded", and it was wrong by the time anyone read it: mt#4148
 * and mt#4312 each added an exclusion without touching the sentence, and mt#4315
 * made it a third off. A hand-maintained tally beside a list that only grows is
 * a stale comment waiting to happen, so the reader is pointed at the filter body
 * — which cannot drift from itself — and each exclusion carries its own reason
 * at its own line. `asks.advisory-form-lint.test.ts` enumerates the current set
 * as executable assertions.
 *
 * `unlinkified-reference` (mt#2918): the transform beside it is best-effort by design
 * — it linkifies a CUED external reference and warns about the rest — and an
 * ask carrying a citation it could not resolve is still a decidable ask, so
 * rejecting the create would withhold a decision over a formatting gap. The
 * warning's job is to tell the author; blocking is a different, harsher
 * claim than the evidence supports.
 *
 * `missing-decision-options` (mt#3477) is NOT added — it blocks with the
 * original five. Its basis is recorded in
 * `form-lint.ts`'s module header: no false-positive class to calibrate (an
 * optionless `direction.decide` renders zero buttons by construction), and
 * the family's own escalation threshold (mem#760: three form-failure
 * incidents in 30 days) was already met by ask 6807fb14 / ask#6448 /
 * ask#6589.
 *
 * Exported for direct testing, matching `validateFormLintNotViolated`'s
 * pattern above.
 */
/**
 * Return `params` with its question normalized to the form that will actually
 * be PERSISTED (mt#2918).
 *
 * The single normalization seam shared by the two places that need it:
 * `asks.create`'s `validate` hook, which must not reject a body the transform
 * is about to fix, and `createAskWithFormLint`, which writes that body. Naming
 * it makes the ordering legible at both call sites instead of leaving it as an
 * implementation detail of whichever function happens to run first — PR #2755
 * R1/R2 both landed on that ambiguity.
 *
 * Idempotent, because `linkifyExternalRefs` is: a question that already carries
 * its URLs comes back unchanged, so applying this twice is a no-op rather than
 * a double-append.
 */
export function normalizeQuestionForLint<T extends { question?: string }>(params: T): T {
  if (typeof params.question !== "string") return params;
  const { text } = linkifyExternalRefs(params.question);
  return text === params.question ? params : { ...params, question: text };
}

/**
 * Reject a question carrying the tool call's own parameter encoding (mt#3936).
 *
 * Deliberately NOT a `computeFormLintMatches` check, for two reasons. It must
 * fire ahead of `acknowledgeFormWarnings`, which the lint pipeline sits behind;
 * and it is not a judgment about form at all — the markers it looks for cannot
 * occur in prose an author wrote, so there is no calibration question and no
 * false-positive posture to tune.
 *
 * What this DOES and does not buy: it catches the corruption when the artifact
 * lands IN the question, which is the shape three production rows actually
 * took. It cannot catch the sibling shape where `options` is dropped and the
 * question arrives clean — server-side, that is indistinguishable from an
 * author who supplied no options, which is exactly why the
 * `missing-decision-options` message cannot be made to tell them apart.
 */
export function assertNoSerializedParameterArtifact(
  question: string | undefined,
  surface: "asks.create" | "asks.edit" = "asks.create"
): void {
  if (typeof question !== "string") return;
  const marker = findSerializedParameterArtifact(question);
  if (marker === null) return;
  throw new ValidationError(
    `${surface}: the question contains \`${marker}\`, which is tool-call parameter markup, ` +
      `not prose. This means the call's encoding leaked into the question value — and ` +
      `anything that followed it, typically the \`options\` array, was swallowed with it ` +
      `rather than arriving as data.\n\n` +
      `Do NOT work around this by rewording the question or by passing ` +
      `acknowledgeFormWarnings (it does not apply here). Re-issue the call with each ` +
      `parameter supplied separately. If the options array keeps arriving empty while you ` +
      `are supplying it, that is mt#3936 — a shorter question is the known workaround.`
  );
}

export function filterBlockingFormLintMatches(matches: FormLintMatch[]): FormLintMatch[] {
  return matches.filter(
    (m) =>
      m.check !== "missing-force-immediate" &&
      m.check !== "unlinkified-reference" &&
      // mt#4148: advisory permanently, not as a calibration-first term awaiting
      // graduation. Every other check here states a condition the author can
      // SATISFY — supply a link, shorten the body, add options. This one asks
      // whether an exemption set is complete, which no matcher can decide, so
      // blocking on it would only teach authors to reword the label. The fire
      // is the prompt; the judgment stays with the author.
      m.check !== "unscoped-option-exception" &&
      // mt#4312: advisory permanently, and the direction is chosen rather than
      // inherited. Blocking would mean a mis-scored overlap can SUPPRESS a real
      // incident page, which is strictly worse than the duplicate page it would
      // prevent — the whole subsystem exists to get the principal's attention
      // when it is warranted. Fire, name the other ask, let the author decide.
      m.check !== "duplicate-open-incident" &&
      // mt#4315: advisory permanently, for the same reason as the check above
      // and one of its own. Whether a condition will self-resolve is a
      // PREDICTION about an external system — not something the author can
      // settle before filing, and not something a matcher can adjudicate. The
      // warning's job is to put category (b) in front of the author at the
      // moment of escalation; blocking would let a wrong guess about someone
      // else's infrastructure withhold a real page from the principal.
      m.check !== "asserted-not-self-resolving"
  );
}

/**
 * Reject an `asks.create` call whose question/options fail any form-lint
 * check (`@minsky/domain/ask/form-lint`'s `computeFormLintMatches`), unless
 * the caller explicitly acknowledges the violations via
 * `acknowledgeFormWarnings: true` (mt#3326).
 *
 * Design decision (recorded in the mt#3326 spec's "Design Decision" section
 * before this function was written): hard-reject with the violations
 * listed, mirroring the mt#2778 unknown-param MCP-boundary precedent,
 * rather than forcing a same-turn `asks.edit`. Evidence:
 * `.minsky/ask-form-lint-calibration.jsonl` shows the SAME over-word-budget
 * fire ignored on 5 different Asks within ~20h (2026-07-28 through
 * 2026-07-29) — detection was solved (`formWarnings` fires correctly) and
 * its output was routinely ignored fleet-wide because it was advisory-only.
 *
 * ALL five form-lint checks are blocking here, not only the two the retro
 * cites as recurring evidence (`over-word-budget`, `long-option-label`) —
 * the calibration log shows every check has fired at least once in
 * production; leaving the other three (`internal-tool-id`, `portal-no-link`,
 * `letter-prefixed-option-label`) advisory-only would silently reproduce the
 * same containment gap for those defect classes.
 *
 * As of mt#3477 there are SIX blocking checks: `missing-decision-options`
 * joins them, rejecting a `direction.decide` created with an absent or empty
 * `options` array. It is the one check admitted to this set without first
 * serving a calibration-first term — see `filterBlockingFormLintMatches`
 * above for why.
 *
 * **A sixth check is deliberately EXCLUDED from this hard-reject
 * (mt#3436).** `missing-force-immediate` (an operator-only-shaped ask whose
 * question reads like a live incident, created without `forceImmediate` —
 * see `communication-contract.mdc §Severity pierces the register` and the
 * originating incident mt#3433 / mem#779) stays calibration-first: it warns
 * via the calibration log only, unlike the five checks above. Unlike those
 * five, there is no calibration evidence yet that authors ignore it — it
 * follows the SAME calibration-first ladder the five mt#3326 checks
 * themselves went through before escalating, and graduates to blocking only
 * if that evidence accumulates.
 *
 * `acknowledgeFormWarnings: true` is the sanctioned override for a
 * genuinely long/complex ask (e.g. a multi-log calibration-review
 * disposition ask) — an explicit, auditable per-call escape hatch, never a
 * silent bypass, mirroring `forceImmediate`'s posture on the service-window
 * fields above. The `asks.create` execute handler records `acknowledged:
 * true` on the calibration-log entry when it is used, so override frequency
 * stays reviewable via `/calibration-review`.
 *
 * Scope, ORIGINALLY: `asks.create` only. mt#3326 recorded here that
 * `asks.edit` "does not compute form-lint at all" and declared extending it
 * out of scope. **mt#3929 closed that gap** — see
 * `validateEditFormLintAgainstExistingAsk` below.
 *
 * Why it mattered: `asks_edit` is the repair path the corpus recommends for a
 * rejected create (mem#760 rule 4, "prefer it over cancel+refile"), so the
 * enforced surface handed every fix-up to the unenforced one. Measured
 * 2026-08-10 (ask#7591): a create was hard-rejected for `over-word-budget`
 * and `long-option-label`, trimmed to pass — and a later edit restored a body
 * well over budget with no warning at all. Both of mt#3326's declared scope
 * limits were exercised by one incident.
 *
 * The underlying `computeFormLintMatches` stays pure and advisory-in-itself
 * (unchanged by this task) — this function is what makes its output
 * consequential, at the command-boundary layer, matching
 * `validateAuthorizationApproveOptions`'s separation of concerns.
 *
 * Exported for direct testing without requiring the full command factory
 * setup, matching `validateAuthorizationApproveOptions`'s pattern above.
 *
 * @throws {ValidationError} when form-lint matches exist and
 *   `acknowledgeFormWarnings` is not `true`
 */
export function validateFormLintNotViolated(params: {
  kind?: AskKind;
  question?: string;
  options?: Array<{ label: string }>;
  forceImmediate?: boolean;
  acknowledgeFormWarnings?: boolean;
  /**
   * Which command boundary is rejecting, for the error text (mt#3929). Defaults to
   * `asks.create` — the only surface that enforced this until the edit path joined it.
   */
  surface?: "asks.create" | "asks.edit";
}): void {
  // mt#3936: BEFORE the acknowledge escape, deliberately. Every other check
  // here describes an ask that is ill-FORMED — too long, no buttons — where an
  // author can reasonably say "yes, I meant that." This one describes a
  // question that has swallowed the tool call's own parameter encoding, which
  // is never something an author meant, and which silently destroyed the
  // sibling `options` array on its way in. There is nothing to acknowledge.
  assertNoSerializedParameterArtifact(params.question, params.surface);
  if (params.acknowledgeFormWarnings) return;
  // Absence of kind/question is a required-field concern the parameter
  // schema already enforces — nothing for this check to add.
  if (!params.kind || !params.question) return;

  // mt#2918 (PR #2755 R1): lint the text that will actually be PERSISTED, not
  // the caller's raw input. `createAskWithFormLint` linkifies external
  // references before the repo write, so validating the pre-transform text
  // judges a body that never exists. The failure is a false hard-reject:
  // `portal-no-link` fires on an authorization.approve question that names a
  // portal action and carries no URL — which is exactly the state of a
  // question whose only citation is a Notion page id the transform was about
  // to resolve. The author would be rejected for a defect the system had
  // already fixed.
  //
  // Normalizing here rather than special-casing `portal-no-link` is
  // deliberate: any present or future check that reads for a URL inherits the
  // same mismatch, so the fix belongs at the text, not at the check. One
  // consequence worth naming: `over-word-budget` now counts the appended URLs.
  // That is correct — the budget should measure the body the principal
  // actually receives.
  const { text: normalizedQuestion } = linkifyExternalRefs(params.question);

  const matches = computeFormLintMatches({
    kind: params.kind,
    question: normalizedQuestion,
    options: params.options,
    forceImmediate: params.forceImmediate,
  });
  const blocking = filterBlockingFormLintMatches(matches);
  if (blocking.length === 0) return;

  const violations = blocking.map((m) => `  - ${m.check}: ${m.message}`).join("\n");
  const plural = blocking.length > 1 ? "s" : "";
  const surface = params.surface ?? "asks.create";
  const verb = surface === "asks.edit" ? "edit" : "create";
  throw new ValidationError(
    `${surface}: ${blocking.length} form-lint violation${plural} — fix the ask and retry:\n` +
      `${violations}\n\n` +
      `Form-lint checks are consequential at the asks_${verb} boundary (mt#3326, extended to ` +
      `edits by mt#3929): the ${verb} is rejected rather than silently accepted with an ` +
      `ignorable warning. If this ask is genuinely long/complex and the violation is ` +
      `warranted, pass acknowledgeFormWarnings: true to ${verb} it anyway — this is recorded ` +
      `for calibration review, not a silent bypass.`
  );
}

/**
 * Typed input for `createAsk` — the internal helper exposed for testing.
 *
 * Mirrors `CreateAskInput` plus the producer-specific defaults that
 * `asks.create` applies before calling `repo.create`.
 *
 * NOT a handler annotation type (mt#2779): the `asks.create` execute handler
 * derives its params from the map by inference; this type covers direct
 * programmatic producers (tests, in-process Ask emitters).
 */
// eslint-disable-next-line custom/no-hand-rolled-command-params -- domain-mirroring producer input type (supersets the map: metadata/classifierVersion/projectId), not a handler annotation (mt#2779)
export interface CreateAskParams {
  kind: AskKind;
  title: string;
  question: string;
  options?: AskOption[];
  contextRefs?: ContextRef[];
  parentTaskId?: string;
  parentSessionId?: string;
  deadline?: string;
  metadata?: Record<string, unknown>;
  classifierVersion?: string;
  requestor?: string;
  /** Server-injected caller identity (mt#4476) — see the `callerActorId` param. */
  callerActorId?: string;
  /** Service-window routing strategy (mt#1411 spine — mt#1488). When absent, per-kind default applies. */
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
  /** Named window to target when strategy is "scheduled". When absent, per-kind default applies. */
  windowKey?: string;
  /** Bypass window check and route immediately (default false). */
  forceImmediate?: boolean;
  /**
   * Severity marker (mt#3595). `"incident"` on an operator-routed ask makes the
   * substrate page the principal once, so the escalation does not depend on the
   * producer remembering a separate notify call.
   */
  severity?: AskSeverity;
  /**
   * Resolved project uuid to stamp on the new Ask (ADR-021, mt#2563). The
   * `asks.create` execute path resolves this via `resolveCurrentProjectScope`;
   * direct callers (tests, programmatic emitters) may pass it explicitly or omit
   * it (unscoped Ask).
   */
  projectId?: string;
}

/**
 * Create an Ask, route it via mt#1069's policy-first router, and — for the
 * elicitation transport — dispatch synchronously through the active MCP
 * server.
 *
 * This is the canonical Ask producer surface. Direct callers (tests,
 * future programmatic Ask emission sites like the 2-strikes detector
 * mt#1241) get the same result shape as the `asks.create` MCP tool: a
 * single coherent producer path regardless of entrypoint (PR #919 R3).
 *
 * Return shape (`RoutedAsk | SuspendedAsk | ElicitationClosedAsk`):
 *   - Policy coverage  → `state: "closed"` (RoutedAsk shape, transport=policy)
 *   - Async transport  → `state: "routed"` (RoutedAsk shape, transport=inbox/mesh/subagent/retriever)
 *   - Window-deferred  → `state: "suspended"` (SuspendedAsk, pending window open via reaper)
 *   - Elicitation accept → `state: "closed"` (ElicitationClosedAsk, response populated)
 *   - Elicitation decline/cancel → `state: "cancelled"` (ElicitationClosedAsk, no response)
 *   - Elicitation dispatch error → `state: "suspended"` (ElicitationClosedAsk, no response)
 *   - Elicitation routed but no active server → `state: "suspended"` (ElicitationClosedAsk, no response)
 *
 * Persistence semantics:
 *   - Creates the Ask row in "detected" state.
 *   - For async transports: row stays at "detected"; downstream transport
 *     adapter (mt#1070 subagent, mt#454 inbox, etc.) walks the state
 *     machine. This matches Tree A's existing semantics in mt#1069/mt#1070.
 *   - For window-deferred asks: row is immediately walked to "suspended" via
 *     `advanceRoutedAskToSuspended`. The reaper (mt#1490) wakes it when the
 *     window opens by transitioning to "routed" and dispatching.
 *   - For elicitation: walks the state machine end-to-end. The repo state
 *     after this call always matches the returned object's state.
 *   - Per `Ask.response`'s contract in `types.ts`, `response` is only
 *     populated for `"responded"` / `"closed"` states. The cancelled/
 *     suspended return values intentionally omit it.
 */
/**
 * Pick the capability registry that decides how THIS ask routes (mt#4451).
 *
 * Extracted as a pure function so the preference is directly assertable: the
 * call site lives inside a `registerCommand` closure, and observing it there
 * would mean patching a collaborator rather than reading a returned value.
 *
 * The order is the whole point:
 *
 * 1. **The caller's own connection**, when the request arrived over MCP.
 *    `src/mcp/server.ts` builds a `SingleConnectionCapabilityRegistry` per
 *    CallTool from the `Server` handling that request.
 * 2. **The container's registry**, which since mt#4451 is the caller-agnostic
 *    no-op in production — `createStartCommand` no longer overrides it with
 *    the fleet-wide tracker. Tests may inject their own.
 * 3. **Nothing**, leaving the router with no capability registry at all, which
 *    it treats as "no elicitation".
 *
 * Steps 2 and 3 both mean "no elicitation" in production. That is deliberate:
 * a caller whose connection cannot be resolved must not inherit some other
 * connection's capabilities (SC3).
 */
export function selectCapabilityRegistry(
  callerCapabilities: ClientCapabilityRegistry | undefined,
  container: { has(key: string): boolean; get(key: string): unknown } | undefined
): ClientCapabilityRegistry | undefined {
  if (callerCapabilities) return callerCapabilities;
  if (container?.has("clientCapabilityRegistry")) {
    return container.get("clientCapabilityRegistry") as ClientCapabilityRegistry;
  }
  return undefined;
}

export async function createAsk(
  repo: AskRepository,
  params: CreateAskParams,
  routerOptions: PolicyFirstRouteOptions = {},
  /**
   * Delivery seam for the severity page (mt#3595). Omitted in production, where
   * the real Telegram-backed deps are built on demand; a test passes a stub to
   * assert the page decision without a network call.
   */
  pageDeps?: PrincipalPageDeps
): Promise<RoutedAsk | SuspendedAsk | ElicitationClosedAsk> {
  // Apply per-kind service-window defaults when the requestor has not supplied
  // explicit values. Explicit params always win over defaults (mt#1488 SC4).
  const kindDefaults = getServiceWindowDefault(params.kind);
  const resolvedStrategy = params.serviceStrategy ?? kindDefaults.serviceStrategy;
  // windowKey: only meaningful when strategy is "scheduled". If the requestor
  // supplies a windowKey with a non-scheduled strategy (e.g. "asap"), it is
  // ignored — persisting it would contradict documented semantics in types.ts
  // ("Only meaningful when serviceStrategy is 'scheduled'").
  const resolvedWindowKey =
    resolvedStrategy === "scheduled" ? (params.windowKey ?? kindDefaults.windowKey) : undefined;

  const input: CreateAskInput = {
    kind: params.kind,
    classifierVersion: params.classifierVersion ?? "v1.0.0",
    requestor: params.requestor ?? "minsky.agent:unknown",
    // mt#4476: server-injected, never caller-supplied. Trimmed-empty is treated as
    // absent so a blank injection cannot become a key nothing can match.
    filedByAgentId: params.callerActorId?.trim() ? params.callerActorId.trim() : undefined,
    title: params.title,
    question: params.question,
    options: params.options,
    contextRefs: params.contextRefs,
    parentTaskId: params.parentTaskId,
    parentSessionId: params.parentSessionId,
    // Project scope stamped at create time (ADR-021, mt#2563). Threaded from the
    // execute callsite's resolveCurrentProjectScope; undefined → unscoped Ask.
    projectId: params.projectId,
    deadline: params.deadline,
    metadata: params.metadata,
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: resolvedStrategy,
    windowKey: resolvedWindowKey,
    // windowMissedCount starts at 0 for all new Asks. The reaper (mt#1490)
    // increments this field as scheduled windows are missed. Callers must not
    // set this directly — it is reaper-owned state.
    windowMissedCount: 0,
    // forceImmediate is persisted here to record the caller's intent at creation time.
    // The router (mt#1490) observes this field to bypass the window check and route
    // immediately. createAsk does not act on it directly — that logic lives in the router.
    forceImmediate: params.forceImmediate ?? false,
    // Severity marker (mt#3595) — read AFTER routing by the page dispatch below,
    // since the page requires an operator routingTarget that does not exist yet
    // at insert time.
    severity: params.severity,
  };

  const ask = await repo.create(input);
  const routed = await policyFirstRoute(ask, routerOptions);

  // Live elicitation path: dispatch synchronously when an active server is
  // available — dispatchToElicitation owns its own persistence walk. The
  // no-active-server race (disconnect between hasElicitation() and the
  // server lookup) falls through to the shared persist path below, which
  // lands it as operator-suspended for recovery via the cockpit/CLI.
  if (!isSuspendedAsk(routed) && routed.transport.kind === "elicitation") {
    const registry = routerOptions.capabilityRegistry;
    const server = registry?.activeElicitationServer();
    if (server) {
      // mt#4450: persist the route outcome BEFORE dispatching, so the row
      // carries the `routingTarget` the router already chose.
      //
      // This branch RETURNS, so it never reaches the shared
      // `persistRouteOutcome` call below — and `dispatchToElicitation` walks
      // state only (`advanceToSuspended` issues `repo.transition` calls and
      // writes no other column). The result was an elicitation-routed ask
      // persisted with `routingTarget = NULL` even though `pickTransport`
      // returned "operator" for it, which is not cosmetic: the cockpit inbox
      // filters on `routingTarget === "operator"` and its resolve endpoint
      // refuses anything else (`src/cockpit/routes/asks.ts:407`, `:615`), so a
      // dispatch that failed left an ask the operator could neither see nor
      // answer. The warn at `:1431` already existed for exactly this shape and
      // was firing into the log with nothing to fix it.
      //
      // Reuses `routeResultToOutcomeWrite` rather than writing the field
      // directly so this path inherits the same authority rules as every
      // other — notably that a creator-specified "operator" beats the
      // kind→target default (mt#3491). The write lands `state: "routed"`;
      // `advanceToSuspended` then walks routed → suspended as before, so the
      // state machine is untouched and only the missing column is added.
      const { write: elicitationWrite } = routeResultToOutcomeWrite(routed, ask.routingTarget);
      await repo.persistRouteOutcome(ask.id, elicitationWrite);
      return await dispatchToElicitation(routed, { server, repo });
    }
    log.warn(
      "createAsk: elicitation routed but no active server — persisting as operator-suspended for recovery",
      {
        askId: routed.id,
      }
    );
  }

  // All remaining paths (mt#2265): persist the route outcome atomically so
  // the row reflects the router decision. Before this fix, async transports
  // (inbox / subagent / mesh / retriever) and policy closes returned an
  // in-memory result while the row stayed "detected" forever — the
  // write-only-graveyard root cause. The returned object is reconciled from
  // the persisted row so the tool response never narrates unpersisted state.
  // `ask.routingTarget` is whatever the CREATOR passed to `repo.create`. When
  // it is an explicit "operator" it wins over the kind→target default (mt#3491)
  // — see routeResultToOutcomeWrite's docblock for why (the reviewer
  // circuit-breaker emitter is the live case).
  const { write } = routeResultToOutcomeWrite(routed, ask.routingTarget);
  const persisted = await repo.persistRouteOutcome(ask.id, write);

  // Severity transport binding (mt#3595). Fires AFTER the route outcome is on
  // disk, because the decision needs the resolved routingTarget — an ask that
  // has not routed yet reads as not-operator-bound and would never page.
  //
  // This is a SECONDARY transport: it runs alongside the ask's ADR-008 primary
  // routing and changes no ask state, matching the shape the transport matrix
  // already uses for `authorization.approve` ("Mesh notify on resolve").
  // Deleting this block would leave every ask routed exactly as it is today.
  //
  // Never allowed to fail creation — see pagePrincipalForAsk's contract. The
  // ask IS the decision record; losing it to a notification failure would be
  // strictly worse than losing the notification.
  await dispatchPrincipalPage(repo, persisted, pageDeps);

  if (write.state === "suspended") {
    if (!persisted.routingTarget) {
      // A suspended row should always carry a routingTarget — both write paths
      // that produce `state: "suspended"` set one. Falling back to the router
      // result keeps the response usable, but the divergence means the DB layer
      // dropped a field, so say so loudly rather than papering over it
      // (R1 non-blocking).
      log.warn(
        "createAsk: persisted suspended ask has no routingTarget; falling back to the router result",
        { askId: ask.id, routerRoutingTarget: routed.routingTarget }
      );
    }
    // Operator-bound (inbox / elicitation-fallback) or window-deferred:
    // suspended = waiting for a response; visible on the cockpit /asks
    // surface and respondable via respondAndClose.
    const suspended: SuspendedAsk = {
      ...routed,
      state: "suspended",
      // From the PERSISTED row, not the router result — a creator-specified
      // target overrides the router's, and the response must not narrate a
      // different target than the one on disk (mt#3491).
      routingTarget: persisted.routingTarget ?? routed.routingTarget,
      transport: routed.transport,
      packagedPayload: routed.packagedPayload,
      routedAt: persisted.routedAt,
      suspendedAt: persisted.suspendedAt,
      suspendedForWindowKey: isSuspendedAsk(routed) ? routed.suspendedForWindowKey : undefined,
    };
    return suspended;
  }

  // write.state is "routed" (async transport awaiting delivery) or "closed"
  // (policy-covered) — both only arise from RoutedAsk router results.
  if (isSuspendedAsk(routed)) {
    // Unreachable by construction (suspended results map to write.state
    // "suspended" above); defensive return keeps the type sound.
    return routed;
  }
  return {
    ...routed,
    routedAt: persisted.routedAt ?? routed.routedAt,
    closedAt: persisted.closedAt ?? routed.closedAt,
  };
}

// ---------------------------------------------------------------------------
// Severity → principal page (mt#3595)
// ---------------------------------------------------------------------------

/**
 * Build the production delivery seam for the severity page.
 *
 * A factory rather than a constant so each dispatch gets a fresh closure and
 * tests can substitute the whole object at the `createAsk` seam.
 */
function makeProductionPageDeps(): PrincipalPageDeps {
  return {
    async send(message) {
      // Never reach the live channel from a test run (mt#3557 / mt#3538 class).
      // `notifyPrincipal` resolves credentials from the Pulumi stack when env
      // vars are absent, so an un-injected call here would spawn `pulumi` and
      // message the principal for real. That hazard is NEW with this dispatch:
      // it fires from `createAsk`, which is on far more test paths than the
      // `principal.notify` command those two tasks were about — no current test
      // creates a severity ask, but nothing stops the next one.
      //
      // Reported as a LOUD non-delivery rather than a silent success: the
      // caller records it, so a test that genuinely expects delivery fails
      // visibly instead of passing against a no-op. A test that wants the real
      // decision path injects `pageDeps` at the `createAsk` seam.
      if (process.env.NODE_ENV === "test") {
        return {
          delivered: false,
          error:
            "suppressed-in-test: production page deps were used without injection — " +
            "pass pageDeps to createAsk to exercise this path",
        };
      }
      try {
        const result = await notifyPrincipal({
          message: message.message,
          title: message.title,
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          // Explicit production wiring (ADR-026, mt#3609). This is the second
          // production caller of `notifyPrincipal`; the spec's original
          // enumeration named only the `principal.notify` command, which is
          // why the required-deps change had to re-derive its consumers.
          deps: createRealPrincipalChannelDeps(),
        });
        return result.delivered
          ? { delivered: true }
          : // notifyPrincipal reports a structured failure (`reason` +
            // `detail`) rather than an `error` string — flatten both so the
            // recorded failure says WHICH failure it was, not just that one
            // happened. "not-configured" and "send-failed" want very different
            // operator responses.
            { delivered: false, error: `${result.reason}: ${result.detail}` };
      } catch (err: unknown) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async recordFailure(ask, error) {
      // Log FIRST and unconditionally. The event row is best-effort by nature
      // (it needs a live DB, which may be the very thing that is broken), so it
      // cannot be the only record — a page failure that leaves no trace at all
      // is indistinguishable from an incident nobody reported.
      log.error("ask.page_failed: could not page the principal about a severity ask", {
        askId: ask.id,
        shortId: ask.shortId,
        error,
      });
      try {
        const provider = await resolvePersistenceProvider();
        await emitSystemEventFromProvider(provider ?? undefined, {
          eventType: "ask.page_failed",
          payload: { askId: ask.id, shortId: ask.shortId, error },
          ...(ask.parentTaskId === undefined ? {} : { relatedTaskId: ask.parentTaskId }),
        });
      } catch (err: unknown) {
        log.warn("ask.page_failed: event emission also failed (already logged above)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    now: () => new Date(),
  };
}

/**
 * Run the severity-page dispatch for a just-routed Ask.
 *
 * Swallow-by-design at this boundary, and the ONE place in this flow where that
 * is correct: `pagePrincipalForAsk` already records its own failures durably,
 * so anything escaping here is a defect in the page path itself — and failing
 * ask creation because a notification broke would destroy the decision record
 * to protect the reminder about it.
 */
async function dispatchPrincipalPage(
  repo: AskRepository,
  ask: Ask,
  deps?: PrincipalPageDeps
): Promise<void> {
  try {
    const outcome = await pagePrincipalForAsk(ask, repo, deps ?? makeProductionPageDeps());
    if (outcome.reason === "rate-limited") {
      // Never a silent cap (`work-completion.mdc`): a suppressed page must say
      // so, with the count, or the ceiling reads as "nothing needed sending".
      log.warn("ask page suppressed by rate limit", {
        askId: ask.id,
        recentPageCount: outcome.recentPageCount,
        windowHours: PAGE_RATE_LIMIT_WINDOW_MS / (60 * 60 * 1000),
        max: PAGE_RATE_LIMIT_MAX,
      });
    }
  } catch (err: unknown) {
    log.error("ask page dispatch threw; ask creation is unaffected", {
      askId: ask.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// createAsk + form-lint wrapper (mt#2798)
// ---------------------------------------------------------------------------

/** Result of `createAskWithFormLint`: the created Ask plus its form-lint outcome. */
export interface CreateAskWithFormLintResult {
  ask: RoutedAsk | SuspendedAsk | ElicitationClosedAsk;
  /** Advisory (warn-only) warning messages — NEVER blocks or alters creation. */
  formWarnings: string[];
  /** The underlying matches (check + message), for callers that need the check id. */
  formLintMatches: FormLintMatch[];
}

/**
 * Create an Ask via `createAsk` (unchanged), then compute the v1 mechanical
 * form-lint checks (`@minsky/domain/ask/form-lint`) against the SAME kind +
 * question that were just persisted (mt#2798).
 *
 * This is the seam the `asks.create` MCP command wraps to add
 * `formWarnings` to its result and drive the calibration-log write — kept
 * as a standalone exported function (rather than inlining the check in the
 * command's `execute()` handler) so it is directly testable with
 * `FakeAskRepository`, mirroring every other `createAsk`-based test in this
 * file, without requiring a full DI container + live persistence provider.
 *
 * Form-lint matches NEVER block or alter Ask creation — `createAsk` above
 * runs to completion identically regardless of the lint outcome.
 */
export async function createAskWithFormLint(
  repo: AskRepository,
  params: CreateAskParams,
  routerOptions: PolicyFirstRouteOptions = {}
): Promise<CreateAskWithFormLintResult> {
  // mt#2918: make external artifact citations reachable BEFORE the body is
  // persisted, so every downstream reader — the cockpit inbox, the CLI, a
  // notification payload — carries the URL rather than a bare page id. The
  // display-surface linkifier cannot do this job: it resolves refs against a
  // Minsky id-set, and a Notion page id is in no Minsky index.
  const persistedParams: CreateAskParams = normalizeQuestionForLint(params);

  // mt#4312: read the open incident asks BEFORE creating this one, so the
  // comparison set never contains the ask being created. Only for an incident
  // create — an ordinary ask pays no read.
  const openIncidentAsks =
    params.severity === "incident" ? await getOpenIncidentAsks(repo) : undefined;

  const ask = await createAsk(repo, persistedParams, routerOptions);
  const formLintMatches = computeFormLintMatches({
    kind: params.kind,
    // Lint the PERSISTED text, not the caller's input: a reference the
    // transform just made reachable must not also be reported as a defect.
    question: persistedParams.question,
    // Option labels are lint input too (mt#3253) — they render as the decision
    // buttons, so a 167-char label or one repeating the surface-rendered letter
    // is a form defect the producer should hear about.
    options: params.options,
    // forceImmediate feeds the missing-force-immediate check (mt#3436) —
    // calibration-first, never blocking (see validateFormLintNotViolated).
    forceImmediate: params.forceImmediate,
    // mt#4312: the counterweight to the check above. `severity` and the open
    // incident set together drive `duplicate-open-incident`; both are absent
    // for a non-incident create, which keeps that check silent.
    severity: params.severity,
    openIncidentAsks,
  });
  return {
    ask,
    formWarnings: formLintMatches.map((m) => m.message),
    formLintMatches,
  };
}

// ---------------------------------------------------------------------------
// asks.wait-for-response — schemas + render helper (mt#2266)
// ---------------------------------------------------------------------------

/**
 * Parameters for `asks.wait-for-response`.
 *
 * ## `timeoutSeconds` is not reliably reachable over MCP (mt#4455)
 *
 * This command emits **no progress notifications**. `context.onProgress?.()`
 * (mt#2677) exists so a long-running command produces transport activity
 * instead of silence; the emitters are the PR-polling commands
 * (`session.pr.checks`, `session.pr.wait-for-review`, and `session.pr.drive`
 * through its delegation to the latter) plus `session.migrate`. This command is
 * not among them, so a wait here is silent for its whole duration, the
 * connection looks IDLE to the transport underneath, and it can be closed
 * before the requested budget elapses (~225 s measured 2026-08-22 on the
 * sibling `deployment.wait-for-latest`).
 *
 * The clamp below still says `[1, 1800]` because it is the DOMAIN's contract and
 * remains correct on the CLI path; over MCP the reachable ceiling is lower and
 * not stated by any schema. Mechanism: **mt#1576** Occurrence 8. Transport-side
 * decision: **mt#4455** (the shim's absolute bound is sized above 1800 s; the
 * idle half is separate and unfixed).
 *
 * For an ask that may take minutes, prefer filing and continuing over blocking
 * here — which is the shape mt#3564's answered-ask injection exists to support.
 */
const asksWaitForResponseParams = {
  id: {
    schema: z.string().trim().min(1),
    description: "Ask ID (UUID) to wait on until it reaches responded/closed",
    required: true,
  },
  timeoutSeconds: {
    schema: z.number().int().positive(),
    description:
      "Max seconds to wait (default 600; clamped to [1, 1800]). " +
      "NOTE (mt#4455): over MCP this command emits no progress, so the transport's " +
      "idle timeout can end the call before this budget elapses.",
    required: false,
    defaultValue: 600,
  },
  intervalSeconds: {
    schema: z.number().int().positive(),
    description: "Polling interval in seconds (default 15; clamped to [5, 60])",
    required: false,
    defaultValue: 15,
  },
};

/**
 * Render the text-mode message for an `asks.wait-for-response` result.
 * Exported (pure) so the format contract can be unit-tested independently of
 * the wait tool's dependency chain — mirrors `formatMatchMessage` /
 * `formatTimeoutMessage` in the session PR wait-for-review adapter.
 */
export function formatAskWaitMessage(result: AskWaitForResponseResult): string {
  const secs = Math.round(result.elapsedMs / 1000);
  if (result.resolved) {
    const payload = result.response.payload;
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    // mt#3215: `responded`/`closed` are response-bearing states regardless of
    // WHO closed them — a system sweep's automated closure (parent-terminal,
    // supersession) sets `response` exactly like a genuine operator answer
    // does. Render the two differently so a caller reading this line alone
    // (not the raw payload) cannot mistake an unanswered auto-close for a
    // real response — the ask#6024 incident this task fixes.
    const autoClosed = isAutomatedClosureResponder(result.response.responder);
    const headline = autoClosed
      ? `⚠ Ask auto-closed (${result.state}) by ${result.response.responder} — NOT an operator ` +
        `response after ${secs}s / ${result.pollCount} poll(s)`
      : `✓ Ask resolved (${result.state}) by ${result.response.responder} ` +
        `after ${secs}s / ${result.pollCount} poll(s)`;
    return [headline, "", payloadStr].join("\n");
  }
  if (result.terminal) {
    return (
      `✗ Ask reached terminal state "${result.lastState}" without a response ` +
      `after ${secs}s / ${result.pollCount} poll(s). It can no longer be answered.`
    );
  }
  return (
    `⏳ Ask still pending (state "${result.lastState}") after ${secs}s / ` +
    `${result.pollCount} poll(s). Timeout reached without a response — re-wait or act on the pending state.`
  );
}

// ---------------------------------------------------------------------------
// asks.edit — schemas + validation (mt#2668)
// ---------------------------------------------------------------------------

export const asksEditParams = {
  id: {
    schema: z.string().trim().min(1),
    description: "Ask ID (UUID) to edit",
    required: true,
  },
  title: {
    schema: z.string().min(1).optional(),
    description: "Replacement title (list rendering / notifications)",
    required: false,
  },
  question: {
    schema: z.string().min(1).optional(),
    description: "Replacement question body",
    required: false,
  },
  options: {
    schema: z.array(askOptionSchema).optional(),
    description: "Replacement decision-frame options (wholesale replace, not merge)",
    required: false,
  },
  contextRefs: {
    schema: z.array(contextRefSchema).optional(),
    description: "Replacement context refs (wholesale replace, not merge)",
    required: false,
  },
  metadata: {
    schema: z.record(z.string(), z.unknown()).optional(),
    description:
      "Metadata keys to shallow-merge over existing metadata (editHistory and originalContent are reserved — provenance and the pre-edit content capture; caller-supplied values for either are ignored)",
    required: false,
  },
  editor: {
    schema: z.string().trim().min(1).optional(),
    description:
      "Editor identity recorded in the provenance note; defaults to a session-unknown marker",
    required: false,
  },
  acknowledgeFormWarnings: {
    schema: z.boolean().optional(),
    description:
      "When true, bypass the form-lint hard-reject (mt#3929) for this edit call. The same " +
      "escape asks_create offers: use it when the ask is genuinely long/complex and the " +
      "violation is warranted, or when repairing one field of an ask whose pre-existing body " +
      "already violates. Without it, an edit whose RESULTING question/options fail any " +
      "form-lint check is rejected.",
    required: false,
  },
};

/**
 * Cross-field validation for `asks.edit` MCP params:
 *
 * 1. At least one editable field must be provided — an edit that touches
 *    nothing is a caller error caught at the parameter boundary, not a
 *    silent no-op.
 * 2. `metadata` must not contain forbidden keys (`__proto__`, `prototype`,
 *    `constructor`) — prototype-pollution hardening at the MCP boundary,
 *    aligned with the domain layer's `sanitizeMetadata` on the same
 *    `FORBIDDEN_METADATA_KEYS` policy constant (PR #1831 review,
 *    defense-in-depth at both layers).
 *
 * Exported for direct testing without the full command factory setup. The
 * `asks.edit` command's `validate` hook delegates to this function.
 *
 * @throws {ValidationError} when no editable field is provided, or when
 *         metadata contains a forbidden key
 */
export function validateAsksEditParams(
  params: Pick<EditAskContentParams, "title" | "question" | "options" | "contextRefs" | "metadata">
): void {
  if (providedEditableFields(params).length === 0) {
    throw new ValidationError(
      "asks.edit: at least one editable field (title, question, options, contextRefs, metadata) must be provided."
    );
  }
  if (params.metadata !== undefined) {
    const forbidden = Object.keys(params.metadata).filter((key) =>
      (FORBIDDEN_METADATA_KEYS as readonly string[]).includes(key)
    );
    if (forbidden.length > 0) {
      throw new ValidationError(
        `asks.edit: metadata contains forbidden key(s): ${forbidden.join(", ")}. ` +
          `The keys __proto__, prototype, and constructor are rejected (prototype-pollution hardening).`
      );
    }
  }
}

/**
 * Edit-time counterpart to `validateAuthorizationApproveOptions` (mt#3209).
 *
 * `asks.edit`'s own params carry no `kind` field — an edit payload alone
 * doesn't say what kind the target Ask is, so the mt#3203 authoring-time
 * guard can't be applied to it directly. This fetches the Ask's PERSISTED
 * kind and re-uses `validateAuthorizationApproveOptions` against it — same
 * function, same `@minsky/shared/ask-approval` vocabulary underneath it, no
 * second copy of the approve-token regex.
 *
 * Chosen over deferring the check into `execute` (the spec's alternative
 * path): keeping it in `validate` means an edit that would strip the last
 * approve-shaped option from a live `authorization.approve` Ask is rejected
 * BEFORE any mutation runs, via the same `ValidationError` type and the same
 * validate→execute gate mt#3203 established for `asks.create` — not a
 * generic `Error` thrown partway through the domain-level write path. This
 * mirrors `command-registry`'s ADR-004 pipeline (`shared-command-integration.ts`
 * / `command-generator-core.ts`): `validate()` is awaited and any throw
 * short-circuits before `execute()` ever runs, so this fully gates the
 * mutation exactly like the create-time check does.
 *
 * Failure mode — DB unavailable (or the fetch otherwise fails) at validate
 * time: the guard is skipped (fail-open), NOT because the risk is silently
 * accepted, but because `execute()` performs its OWN `buildAskRepository` /
 * `getById` resolution moments later (via `editAskContent`) and will surface
 * a clear "AskRepository unavailable" or "Ask not found" error on its own if
 * persistence is genuinely broken or the id doesn't resolve — no edit
 * reaches the repository either way. The only gap this leaves is a
 * transient DB blip that resolves between `validate` and `execute` in the
 * same request, which is narrow and consistent with this file's existing
 * fail-open convention (`buildAskRepository`, `resolveAskIdInput`,
 * `resolveCurrentProjectScope` all degrade gracefully on persistence
 * failures rather than throwing from a resolution helper).
 *
 * Deliberately narrow, matching `validateAuthorizationApproveOptions`'s own
 * scope in one respect: only fires when the caller is replacing `options`
 * (checked by the `validate` hook before calling this — see the `asks.edit`
 * command registration) — editing title/question/contextRefs/metadata on an
 * `authorization.approve` Ask is unaffected, even when its EXISTING options
 * already lack an approve-shaped value (pre-existing state; not this
 * function's job to retroactively enforce).
 *
 * Diverges from `validateAuthorizationApproveOptions` on ONE point (mt#3209
 * review R1): an EDIT that replaces `options` with an empty array is
 * rejected here even though the create-time function treats empty/absent
 * `options` as out of scope. That create-time skip encodes a real,
 * deliberate case — a caller creating an ask that has never had options
 * intends a free-text `authorization.approve` Ask (which correctly fails
 * verification on its own, since `.minsky/hooks/ask-verification.ts` never
 * treats a free-text `message` as approval). But an EDIT that sets
 * `options: []` on an ask that previously had a valid approve-shaped option
 * is STRIPPING it, not authoring a free-text ask from birth — and matches
 * the spec's literal wording ("no option carries an approve-shaped value")
 * vacuously for the empty set. Silently allowing it here would let the same
 * mt#3203 footgun back in through a one-character `options: []` edit.
 *
 * Exported for direct testing with a `FakeAskRepository`, mirroring the
 * rest of this file's conventions.
 */
export async function validateEditOptionsAgainstExistingAsk(
  repo: AskRepository | null,
  resolvedId: string,
  options: Array<{ label: string; value?: unknown }>
): Promise<void> {
  if (!repo) return; // fail-open — execute() surfaces its own clear error

  let existing: Ask | null;
  try {
    existing = await repo.getById(resolvedId);
  } catch (err: unknown) {
    log.warn(
      "asks.edit: could not fetch existing Ask to check authorization.approve options guard (fail-open)",
      {
        askId: resolvedId,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return;
  }
  if (!existing) return; // not-found surfaces from execute()'s own lookup

  // mt#3209 review R1: reject an edit that strips ALL options from an
  // authorization.approve Ask. validateAuthorizationApproveOptions
  // deliberately skips empty/absent options (a legitimate CREATE-time
  // "free-text ask" case), but that carve-out does not extend to an EDIT
  // that empties out options previously present — see the docstring above.
  if (existing.kind === "authorization.approve" && options.length === 0) {
    throw new ValidationError(
      `authorization.approve Ask edit would strip all options, leaving none with an ` +
        `approve-shaped value (${APPROVAL_TOKEN_EXAMPLES.join("/")}). Add at least one option ` +
        `with an explicit approve-shaped value, e.g. {label: "...", value: "approve"}, or omit ` +
        `"options" from this edit to leave the existing ones untouched.`
    );
  }

  validateAuthorizationApproveOptions({ kind: existing.kind, options });
}

/**
 * Gate for whether an `asks.edit` call needs the `validateEditOptionsAgainstExistingAsk`
 * check at all (mt#3209). Pulled out as a standalone pure function so the third
 * success criterion — editing title/question/contextRefs/metadata on an
 * `authorization.approve` Ask is UNAFFECTED, even when its existing options
 * already lack an approve-shaped value — is directly testable, rather than
 * only inferable from reading the `asks.edit` command's `validate` hook. A
 * `false` result means the (persistence-touching) guard is skipped entirely,
 * not merely that it happens not to fire.
 */
export function editRequiresApproveOptionsGuard(
  params: Pick<EditAskContentParams, "title" | "question" | "options" | "contextRefs" | "metadata">
): boolean {
  return params.options !== undefined;
}

/**
 * Gate for whether an `asks.edit` needs the form-lint check (mt#3929).
 *
 * Only an edit that touches `question` or `options` can change what form-lint
 * reads — a title/contextRefs/metadata-only edit cannot, so it skips the
 * (persistence-touching) guard entirely rather than merely passing it. Pure and
 * exported so that skip is directly testable, mirroring
 * `editRequiresApproveOptionsGuard`.
 */
export function editRequiresFormLintGuard(
  params: Pick<EditAskContentParams, "title" | "question" | "options" | "contextRefs" | "metadata">
): boolean {
  return params.question !== undefined || params.options !== undefined;
}

/**
 * The option shape form-lint actually reads (mt#3929): it inspects `label` and nothing else.
 * Kept deliberately wider than `AskOption` so a caller can pass either a full persisted option
 * or a label-only literal — narrowing to `AskOption` here would buy no safety, since `value` is
 * never consulted, and would force casts at every call site.
 */
export type FormLintOptionShape = { label: string; value?: unknown };

/**
 * The POST-EDIT question/options an `asks.edit` will persist (mt#3929).
 *
 * Form-lint has to judge the **result**, not the payload: an edit that replaces
 * only `options` still produces a body whose word budget is set by the EXISTING
 * question, and an edit that rewrites only `question` is bounded by the existing
 * options' labels. Linting the payload alone would let either half slip past by
 * being absent.
 *
 * Deliberately a merge, not a diff. An edit that leaves an existing violation
 * untouched should not be blamed for it — but under this merge it IS still
 * rejected, and that is the intended reading of "lint the result": a caller who
 * edits an already-over-budget ask is asked to bring it into budget while they
 * are in there. The escape is the same `acknowledgeFormWarnings` the create path
 * offers, so the pre-existing-violation case has a one-flag answer rather than a
 * carve-out nobody can see.
 *
 * Pure, so the merge semantics are testable without a repository.
 */
export function mergeEditForFormLint(
  existing: Pick<Ask, "kind" | "question"> & { options?: FormLintOptionShape[] },
  params: Pick<EditAskContentParams, "question"> & { options?: FormLintOptionShape[] }
): { kind: AskKind; question: string; options?: FormLintOptionShape[] } {
  return {
    kind: existing.kind,
    question: params.question ?? existing.question,
    options: params.options ?? existing.options,
  };
}

/**
 * Run the create path's form-lint against what an `asks.edit` will actually
 * persist (mt#3929) — closing the gap mt#3326 declared out of scope.
 *
 * Fetches the existing Ask to build the post-edit state (see
 * `mergeEditForFormLint`), then delegates to the SAME
 * `validateFormLintNotViolated` the create boundary uses, so the two surfaces
 * cannot drift into different checks, different blocking subsets, or different
 * override semantics. Only the surface name in the error text differs.
 *
 * Fail-open on a fetch failure, matching
 * `validateEditOptionsAgainstExistingAsk` and this file's convention for
 * resolution helpers: a transient DB blip must not block a repair to an ask
 * that is already live.
 */
export async function validateEditFormLintAgainstExistingAsk(
  repo: AskRepository | null,
  resolvedId: string,
  params: Pick<EditAskContentParams, "question" | "options"> & {
    acknowledgeFormWarnings?: boolean;
  }
): Promise<void> {
  // mt#3936: same reasoning as the create path — an edit can carry the
  // artifact in exactly as a create can, and repairing a corrupted ask by
  // writing MORE corrupted markup into it is the one outcome to prevent.
  assertNoSerializedParameterArtifact(params.question, "asks.edit");
  if (params.acknowledgeFormWarnings) return;
  if (!repo) return; // fail-open — execute() surfaces its own clear error

  let existing: Ask | null;
  try {
    existing = await repo.getById(resolvedId);
  } catch (err: unknown) {
    log.warn("asks.edit: could not fetch existing Ask to run form-lint (fail-open)", {
      askId: resolvedId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!existing) return; // not-found surfaces from execute()'s own lookup

  const merged = mergeEditForFormLint(existing, params);
  validateFormLintNotViolated({
    kind: merged.kind,
    question: merged.question,
    options: merged.options,
    // `forceImmediate` is not editable, so the existing value governs; reading
    // it off the ask keeps a check that consults it (severity/transport shape)
    // judging the real record rather than a default.
    forceImmediate: existing.forceImmediate,
    surface: "asks.edit",
  });
}

// ---------------------------------------------------------------------------
// asks.create — form-lint result shape (mt#2798)
// ---------------------------------------------------------------------------

/**
 * `asks.create`'s result shape: the routed/suspended/elicitation-closed Ask
 * PLUS an advisory (warn-only) `formWarnings` array from the form-lint
 * checks in `@minsky/domain/ask/form-lint`. Always present (empty array
 * when no check fires) — see `humility.mdc §Escalation packaging`'s "Form"
 * sub-checklist for what these checks encode. Warnings never block or alter
 * Ask creation; they are purely advisory instrumentation feeding
 * `.minsky/ask-form-lint-calibration.jsonl` for future `/calibration-review`.
 */
export type AsksCreateResult = (RoutedAsk | SuspendedAsk | ElicitationClosedAsk) & {
  formWarnings: string[];
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Resolve the current project's uuid for project-scoped Ask reads and writes
 * (ADR-021 — mt#2416 read-side, mt#2563 write-side). Single source of truth so
 * `asks.create` stamps the SAME project the `asks.list` default filter reads by:
 * create/list scope parity. Returns the project uuid, or `undefined` when
 * persistence is unavailable, the project is unidentified (hosted server /
 * cockpit daemon with no single-repo cwd), or resolution fails — fail-open to an
 * unscoped read/write, never a throw.
 */
async function resolveCurrentProjectScope(
  container: AppContainerInterface | undefined,
  caller: string
): Promise<string | undefined> {
  if (!container?.has("persistence")) return undefined;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return undefined;
    const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
    const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
    const { isAllProjects } = await import("@minsky/domain/project/scope");
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return undefined;
    const rawDb = await persistenceProvider.getDatabaseConnection();
    if (!rawDb) return undefined;
    const scope = await resolveProjectScope(
      identity,
      rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb,
      `asks.${caller}`
    );
    return isAllProjects(scope) ? undefined : scope;
  } catch (err: unknown) {
    log.debug(`[${caller}] Project scope resolution failed; defaulting to unscoped`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Register the asks commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, commands resolve
 *   the persistence provider from it to build the AskRepository.
 */
export function registerAsksCommands(container?: AppContainerInterface): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.list",
      category: CommandCategory.TOOLS,
      name: "list",
      description:
        "List Asks with optional id, state, and kind filters. `id` accepts a full UUID, " +
        "an unambiguous prefix (>=8 hex chars, mt#2696), or an `ask#N` short id (mt#2965). " +
        "Returns full ask records by default; pass `summary: true` for compact rows (id, " +
        "kind, state, title, routingTarget, parentTaskId, createdAt, routedAt) with no " +
        "question/options/contextRefs/metadata body — safe to page through at any store " +
        "size (mt#2748). To inspect one specific Ask by id, `asks_get` returns exactly one " +
        "full record with a bare (non-list-wrapped) shape.",
      requiresSetup: true,
      parameters: asksListParams,
      execute: async (params): Promise<AsksListResult> => {
        const repo = await requireAskRepository(container, "asks.list");

        const allProjects = params.allProjects as boolean | undefined;
        const summary = params.summary as boolean | undefined;

        // ADR-021 / mt#2416: resolve project scope so list returns only this
        // project's asks by default. When allProjects=true, skip resolution.
        // Shares resolveCurrentProjectScope with asks.create (mt#2563) so the
        // read filter and the write stamp agree on the same project_id.
        const projectScope = allProjects
          ? undefined
          : await resolveCurrentProjectScope(container, "asks.list");

        // mt#2965: id resolution (uuid / 8-char hex prefix / ask#N short id)
        // is delegated to resolveAskIdInput — the SAME generalized resolver
        // asks.respond/edit/wait-for-response use — via listAsksFiltered.
        const result = await listAsksFiltered(repo, (id) => resolveAskIdInput(id, container), {
          id: params.id as string | undefined,
          state: params.state as AskState | undefined,
          kind: params.kind as AskKind | undefined,
          limit: (params.limit as number | undefined) ?? 50,
          projectScope,
        });

        // mt#2748: opt-in compact projection, applied on top of listAsksFiltered's
        // result. Default (summary:false/absent) is unchanged from the pre-mt#2748
        // full-record shape — kept as the default because at least one known
        // consumer (`.minsky/hooks/ask-verification.ts`, the authorization.approve
        // self-respond-vector-closure security check) reads
        // `response.responder`/`response.payload` off unfiltered asks.list rows
        // with no explicit mode flag; a summary-by-default would silently strip
        // those fields and fail that check closed for every grant.
        if (!summary) return result;
        return {
          ...result,
          summary: true,
          asks: result.asks.map(toAskSummary),
        };
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.get",
      category: CommandCategory.TOOLS,
      name: "get",
      description:
        "Fetch a single full Ask record by id — the ergonomic path for inspecting a " +
        "specific Ask without pulling a whole `asks_list` page (mt#2748). `id` accepts a " +
        "full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), or an `ask#N` short id " +
        "(mt#2965). Use `asks_list` with `summary: true` to browse/filter across many Asks " +
        "instead.",
      requiresSetup: true,
      parameters: asksGetParams,
      execute: async (params): Promise<Ask> => {
        const repo = await requireAskRepository(container, "asks.get");

        const rawId = params.id as string;
        // mt#2696: resolve a short-prefix citation before it ever reaches a
        // Postgres `uuid` column comparison.
        const resolvedId = await resolveAskIdInput(rawId, container);

        return getAskByResolvedId(repo, rawId, resolvedId);
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.reconcile",
      category: CommandCategory.TOOLS,
      name: "reconcile",
      description:
        "Run one reconcile pass over open quality.review Asks (polls GitHub for reviews and notifies the operator)",
      requiresSetup: true,
      parameters: asksReconcileParams,
      execute: async (): Promise<ReconcileResult> => {
        const repo = await requireAskRepository(container, "asks.reconcile");

        let tokenProvider;
        try {
          const { getConfiguration } = await import("@minsky/domain/configuration/index");
          const { createTokenProvider } = await import("@minsky/domain/auth");
          const cfg = getConfiguration();
          const userToken = cfg.github?.token ?? "";
          const githubCfg = cfg.github ?? {};
          tokenProvider = createTokenProvider(githubCfg, userToken);
        } catch (err: unknown) {
          const cause = err instanceof Error ? err.message : String(err);
          throw new Error(
            `asks.reconcile requires Minsky configuration to be initialized. ` +
              `Run \`minsky setup\` (or the appropriate init step) before calling reconcile, ` +
              `or pass a pre-built TokenProvider through the DI container. Cause: ${cause}`,
            { cause: err instanceof Error ? err : new Error(String(err)) }
          );
        }

        const githubClient = makeProductionGithubReviewClient(tokenProvider);
        const operatorNotify = new SystemOperatorNotify();
        // mt#1661 v0: compose LoggingWakeSignalSink + PersistentWakeSignalSink so
        // both fire in parallel on every quality.review wake. The persistent sink
        // writes to the wake_pending table; the MCP wake-enrichment middleware
        // drains it on subsequent allowlisted tool calls (pull-on-tool-call
        // delivery — Class B in mt#1519's catalog).
        const wakeSink = await buildCompositeWakeSink(container);
        return reconcile(repo, githubClient, operatorNotify, wakeSink);
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.respond",
      category: CommandCategory.TOOLS,
      name: "respond",
      description:
        "Respond to any suspended Ask (mt#1458, ADR-008). " +
        "v1 accepts ANY suspended Ask regardless of routingTarget — see mt#454-impl follow-up. " +
        "Pre-suspended (detected/classified/routed) and terminal " +
        "(closed/cancelled/expired) states are rejected with a clear error. " +
        "`id` accepts a full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), " +
        "or an `ask#N` short id (mt#2965).",
      // requiresSetup: false — asks.respond depends only on the persistence
      // provider, not on global Minsky configuration. The execute() closure
      // surfaces a clear "AskRepository unavailable" error if persistence
      // is missing (graceful failure mode).
      requiresSetup: false,
      parameters: asksRespondParams,
      execute: async (params): Promise<RespondToAskResult> => {
        const repo = await requireAskRepository(container, "asks.respond");

        // mt#2696: resolve a short-prefix citation to the full uuid before it
        // ever reaches a Postgres `uuid` column comparison.
        const id = await resolveAskIdInput(params.id as string, container);

        return respondToAsk(repo, {
          id,
          message: params.message as string,
          responder: params.responder as string | undefined,
        }).then(async (result) => {
          // Best-effort system event for the plant-board activity stream (mt#2489).
          // mt#2696 R1 (reviewer finding 3): `askId` is the RESOLVED full uuid
          // (`id`, not the raw `params.id` prefix a caller may have passed).
          // Verified this is the correct/expected form for every current
          // consumer of `ask.answered`'s `askId` payload field — no consumer
          // parses or compares against a short-prefix form:
          //   - `system-events-schema.ts` documents the payload shape as
          //     `{ askId: string; ... }` with no length/format constraint
          //     tied to the short-prefix convention.
          //   - `plant-gestures.ts`'s `ask.answered` case triggers a visual
          //     pulse from the event TYPE alone; it does not read
          //     `payload.askId` at all.
          //   - `ActivityPage.tsx`'s `eventSummary()` switch has no
          //     `ask.answered` case (falls through), so no reader there
          //     dereferences `payload.askId` today either.
          //   - The one place askId IS compared for equality against a live
          //     record, `AskPage.tsx:54` (`asks.find((a) => a.id === askId)`),
          //     compares against `Ask.id` — a full uuid — so a full-uuid
          //     `askId` is the format every existing/plausible-future
          //     consumer expects; a short prefix would be the wrong choice.
          await emitSystemEventBestEffort(container, {
            eventType: "ask.answered",
            payload: {
              askId: id,
              responder: (params.responder as string | undefined) ?? null,
            },
          });
          // mt#4476: the same event, addressed to the conversation that filed the ask
          // rather than to the activity stream. Until this existed, `asks.respond`
          // emitted the line above and nothing else — an agent mid-turn learned of its
          // own answer only when its turn ended and a new prompt fired mt#3564's hook.
          await emitAnsweredAskWakeBestEffort(() => buildCompositeWakeSink(container), result.ask);
          return result;
        });
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.cancel",
      category: CommandCategory.TOOLS,
      name: "cancel",
      description:
        "Terminally cancel an Ask that was never dispatched (mt#3353, ADR-008). " +
        "Covers the pre-suspended states — detected/classified/routed — which " +
        "`asks.respond` rejects and which neither existing sweep reads: " +
        "`advancement.ts` sweeps `detected` and `stale-suspended-close.ts` sweeps " +
        "`suspended`, so `classified` and `routed` debris accumulates unreachable. " +
        "This command is the terminal PRIMITIVE for those states; whether a RECURRING " +
        "sweep may safely retire them, and under which rule, is mt#4361 — parent-terminal " +
        "is not a safe trigger there, because a parent can go terminal by concluding the " +
        "work is operator-only while that work is still outstanding. " +
        "Silent to the operator: this is debris cleanup, not a decision. " +
        "Idempotent — an already-terminal Ask is a no-op. " +
        "`id` accepts a full UUID, an unambiguous prefix (>=8 hex chars), or an `ask#N` short id.",
      // Same rationale as asks.respond: depends only on the persistence
      // provider, not on global Minsky configuration.
      requiresSetup: false,
      parameters: asksCancelParams,
      execute: async (params): Promise<CancelAskResult> => {
        const repo = await requireAskRepository(container, "asks.cancel");
        // mt#2696: resolve a short-prefix citation to the full uuid before it
        // ever reaches a Postgres `uuid` column comparison.
        const id = await resolveAskIdInput(params.id as string, container);

        return cancelAsk(repo, {
          id,
          reason: params.reason as string,
          responder: params.responder as string | undefined,
        });
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.create",
      category: CommandCategory.TOOLS,
      name: "create",
      description: "Create an Ask and route it via the policy-first router (ADR-008)",
      requiresSetup: true,
      parameters: asksCreateParams,
      validate: async (params) => {
        // Cross-field coherence: windowKey is only meaningful when serviceStrategy='scheduled'.
        // Reject at the parameter boundary so callers get immediate, actionable feedback.
        validateAsksCreateParams(params);
        // mt#3203: reject an authorization.approve Ask whose options can never
        // satisfy the redemption-time approval verifier — catch the footgun at
        // authoring time, not at merge/guard-override time after the operator
        // has already approved.
        validateAuthorizationApproveOptions(params);
        // mt#3326: reject a create whose question/options fail any form-lint
        // check, unless the caller explicitly acknowledges them. Runs last —
        // fixing form/wording is usually the last thing an author checks.
        //
        // mt#2918 / PR #2755: the question is normalized to its PERSISTED form
        // before it is linted, so `validate` and `execute` judge the same text.
        // Without this a URL-reading check (`portal-no-link`) rejects a body
        // whose only missing link the transform was about to add.
        // `validateFormLintNotViolated` also normalizes internally, so a caller
        // that forgets this is still correct; `linkifyExternalRefs` is
        // idempotent, which is what makes applying it at both seams safe.
        validateFormLintNotViolated(normalizeQuestionForLint(params));
      },
      execute: async (params, ctx: CommandExecutionContext): Promise<AsksCreateResult> => {
        const repo = await requireAskRepository(container, "asks.create");

        // ADR-021 / mt#2563: resolve the current project and stamp it on the new
        // Ask so it is visible to the default project-scoped asks.list — completes
        // the Phase-1.3b write-stamping deferred by mt#2416. Shares
        // resolveCurrentProjectScope with asks.list, so create and the default
        // read filter agree on the same project_id (create/list scope parity).
        const resolvedProjectId = await resolveCurrentProjectScope(container, "asks.create");

        // mt#1457: pull the capability registry from the container so the
        // mt#1457 pulled a capability registry from the container so the router
        // could consult it. mt#4451 changed WHICH registry: the one describing
        // the connection that filed THIS ask, never a fleet-wide view. See
        // `selectCapabilityRegistry` for the order and why the fallback is
        // caller-agnostic.
        const capabilityRegistry = selectCapabilityRegistry(ctx?.callerCapabilities, container);

        const routerOptions: PolicyFirstRouteOptions = capabilityRegistry
          ? { capabilityRegistry }
          : {};

        const {
          ask: result,
          formWarnings,
          formLintMatches,
        } = await createAskWithFormLint(
          repo,
          {
            kind: params.kind as AskKind,
            title: params.title as string,
            question: params.question as string,
            options: params.options as AskOption[] | undefined,
            contextRefs: params.contextRefs as ContextRef[] | undefined,
            parentTaskId: params.parentTaskId as string | undefined,
            parentSessionId: params.parentSessionId as string | undefined,
            deadline: params.deadline as string | undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            classifierVersion: params.classifierVersion as string | undefined,
            requestor: params.requestor as string | undefined,
            // mt#4476: the MCP server overwrote this with the resolved caller identity
            // before the handler ran, so it is trustworthy in a way `requestor` is not.
            callerActorId: params.callerActorId as string | undefined,
            // Service-window fields (mt#1411 spine — mt#1488)
            serviceStrategy: params.serviceStrategy as
              | "asap"
              | "scheduled"
              | "deadline-bound"
              | undefined,
            windowKey: params.windowKey as string | undefined,
            forceImmediate: params.forceImmediate as boolean | undefined,
            // mt#3595 — drives the substrate-sent page; see the param's schema
            // description for when it applies.
            severity: params.severity as AskSeverity | undefined,
            // ADR-021 / mt#2563: stamp the resolved project on the new Ask.
            projectId: resolvedProjectId,
          },
          routerOptions
        );

        // Emit ask.created event (best-effort via EventEmitter — never throws).
        // Resolve DB connection from the same container the repo used.
        if (container?.has("persistence")) {
          try {
            const persistenceProvider = container.get(
              "persistence"
            ) as SqlCapablePersistenceProvider;
            if (persistenceProvider.getDatabaseConnection) {
              const db = await persistenceProvider.getDatabaseConnection();
              if (db) {
                const eventEmitter = createEventEmitter(
                  db as import("drizzle-orm/postgres-js").PostgresJsDatabase
                );
                await eventEmitter.emit({
                  eventType: "ask.created",
                  payload: {
                    askId: result.id,
                    kind: result.kind,
                    title: result.title,
                    question: result.question,
                  },
                  actor: (params.requestor as string) ?? undefined,
                  relatedTaskId: (params.parentTaskId as string) ?? undefined,
                  relatedSessionId: (params.parentSessionId as string) ?? undefined,
                });
                // Audit surfacing for phase-1 policy closures (mt#2666 SC4):
                // reviewable via events_list — see buildPolicyClosedEvent.
                const policyClosedEvent = buildPolicyClosedEvent(result);
                if (policyClosedEvent) {
                  await eventEmitter.emit(policyClosedEvent);
                }
              }
            }
          } catch (err: unknown) {
            // Best-effort: swallow any errors resolving the DB or building the emitter.
            log.warn("asks.create: failed to emit ask.created event (best-effort, swallowed)", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Form-lint (mt#2798; consequential at this boundary since mt#3326)
        // — humility.mdc §Escalation packaging's "Form" sub-checklist,
        // structurally checked via createAskWithFormLint above. By the time
        // execute() runs, a non-empty formLintMatches means EITHER
        // acknowledgeFormWarnings was true (the validate hook above already
        // rejected the create otherwise) OR the only match present is the
        // calibration-first missing-force-immediate check (mt#3436), which
        // never blocks. Record either case on the calibration JSONL so
        // /calibration-review can see override/fire frequency for both.
        if (formLintMatches.length > 0) {
          // mt#3436 R1: `acknowledged` must reflect a genuine hard-reject
          // bypass, not the raw acknowledgeFormWarnings flag — a caller can
          // pass that flag for an unrelated reason (or defensively) on a
          // create whose ONLY match is the advisory missing-force-immediate
          // check, which has nothing to acknowledge. Gate on whether a
          // BLOCKING match was actually present.
          const hasBlockingMatch = filterBlockingFormLintMatches(formLintMatches).length > 0;
          appendAskFormLintCalibrationRecord(ctx?.workspacePath ?? process.cwd(), {
            timestamp: new Date().toISOString(),
            askId: result.id,
            kind: result.kind,
            matches: formLintMatches.map((m) => ({ class: m.check, phrase: m.message })),
            acknowledged: hasBlockingMatch && Boolean(params.acknowledgeFormWarnings),
          });
        }

        return { ...result, formWarnings };
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.wait-for-response",
      category: CommandCategory.TOOLS,
      name: "wait-for-response",
      description:
        "Block until an Ask reaches responded/closed (returns the response payload), " +
        "or a cancelled/expired terminal state, or the timeout elapses. " +
        "Agent-side analogue of session_pr_wait-for-review for the Ask system (mt#2266). " +
        "Caller-managed gating: does NOT mutate task status. " +
        "`id` accepts a full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), " +
        "or an `ask#N` short id (mt#2965).",
      // requiresSetup: false — depends only on the persistence provider
      // (like asks.respond), not on global Minsky configuration.
      requiresSetup: false,
      parameters: asksWaitForResponseParams,
      execute: async (params): Promise<AskWaitForResponseResult> => {
        const repo = await requireAskRepository(container, "asks.wait-for-response");

        // mt#2696: resolve a short-prefix citation before it ever reaches a
        // Postgres `uuid` column comparison.
        const id = await resolveAskIdInput(params.id as string, container);

        return askWaitForResponse(
          {
            id,
            timeoutSeconds: params.timeoutSeconds as number | undefined,
            intervalSeconds: params.intervalSeconds as number | undefined,
          },
          { repo }
        );
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.edit",
      category: CommandCategory.TOOLS,
      name: "edit",
      description:
        "Edit a non-terminal Ask's content (question/title/options/contextRefs/metadata) in place " +
        "WITHOUT consuming it (mt#2668). State is never changed — a suspended Ask stays suspended " +
        "and stays in the operator queue. Terminal asks (closed/cancelled/expired) are rejected. " +
        "Every edit appends an editHistory provenance note (editor + timestamp + touched fields) " +
        "to metadata, and preserves each content field's PRE-EDIT value once, under " +
        "metadata.originalContent — so the text an ask was originally escalated with survives a " +
        "correction (mt#4329). `id` accepts a full UUID, an unambiguous prefix (>=8 hex chars, mt#2696), " +
        "or an `ask#N` short id (mt#2965).",
      // requiresSetup: false — asks.edit depends only on the persistence
      // provider, not on global Minsky configuration (same posture as
      // asks.respond / asks.wait-for-response).
      requiresSetup: false,
      parameters: asksEditParams,
      validate: async (params) => {
        // At least one editable field must be provided — reject at the
        // parameter boundary so callers get immediate, actionable feedback.
        validateAsksEditParams(params);

        // mt#3209: reject an edit that would replace `options` on an
        // EXISTING `authorization.approve` Ask with none carrying an
        // approve-shaped value — the same footgun mt#3203 closed on
        // asks_create, reachable here because asks.edit can wholesale-
        // replace options on an ask that already exists. Only fires when
        // `options` is part of THIS edit; other fields are unaffected even
        // when the ask's current options already lack an approve-shaped
        // value (pre-existing state, not this check's job to retroactively
        // enforce). See `validateEditOptionsAgainstExistingAsk` for the
        // fetch-failure handling.
        if (editRequiresApproveOptionsGuard(params)) {
          const repo = await buildAskRepository(container);
          const resolvedId = await resolveAskIdInput(params.id as string, container);
          await validateEditOptionsAgainstExistingAsk(
            repo,
            resolvedId,
            params.options as Array<{ label: string; value?: unknown }>
          );
        }

        // mt#3929: form-lint the POST-EDIT body. mt#3326 made these checks
        // consequential on `asks.create` and explicitly left the edit path
        // alone — but the edit path is the repair route the corpus recommends
        // for a rejected create (mem#760 rule 4), so every fix-up landed on
        // the unenforced surface and a rewrite could restore a violation the
        // create had just rejected (ask#7591, 2026-08-10).
        if (editRequiresFormLintGuard(params)) {
          const repo = await buildAskRepository(container);
          const resolvedId = await resolveAskIdInput(params.id as string, container);
          await validateEditFormLintAgainstExistingAsk(repo, resolvedId, {
            question: params.question as string | undefined,
            options: params.options as AskOption[] | undefined,
            acknowledgeFormWarnings: params.acknowledgeFormWarnings as boolean | undefined,
          });
        }
      },
      execute: async (params): Promise<{ ask: Ask }> => {
        const repo = await requireAskRepository(container, "asks.edit");

        // mt#2696: resolve a short-prefix citation before it ever reaches a
        // Postgres `uuid` column comparison.
        const id = await resolveAskIdInput(params.id as string, container);

        // mt#3929 (PR #2779 R1): re-run the form-lint here, adjacent to the
        // write. The `validate` hook's copy reads a snapshot fetched a moment
        // earlier, so a concurrent edit landing in between would persist a body
        // nothing linted — the check would pass against state that no longer
        // exists. Re-linting against a fresh read closes that window down to
        // `editAskContent`'s own read-modify-write, which is as tight as this
        // layer gets without a transaction; the validate-time copy stays because
        // it is what gives a caller the rejection BEFORE any work is attempted.
        if (editRequiresFormLintGuard(params)) {
          await validateEditFormLintAgainstExistingAsk(repo, id, {
            question: params.question as string | undefined,
            options: params.options as AskOption[] | undefined,
            acknowledgeFormWarnings: params.acknowledgeFormWarnings as boolean | undefined,
          });
        }

        // Same window, same close, for the mt#3209 approve-options guard. The
        // reviewer flagged only the form-lint one because that is what this PR
        // added, but the defect is the shape — a validate-time read deciding a
        // write that happens later — and this sibling has carried it since
        // mt#3209. Stripping the last approve-shaped option from an
        // authorization.approve Ask is a worse outcome to let through than an
        // over-long label, so leaving it exposed while fixing its neighbour
        // would be the wrong half to close.
        if (editRequiresApproveOptionsGuard(params)) {
          await validateEditOptionsAgainstExistingAsk(
            repo,
            id,
            params.options as Array<{ label: string; value?: unknown }>
          );
        }

        return editAskContent(repo, {
          id,
          title: params.title as string | undefined,
          question: params.question as string | undefined,
          options: params.options as AskOption[] | undefined,
          contextRefs: params.contextRefs as ContextRef[] | undefined,
          metadata: params.metadata as Record<string, unknown> | undefined,
          editor: params.editor as string | undefined,
        });
      },
    })
  );

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "asks.repair",
      category: CommandCategory.TOOLS,
      name: "repair",
      description:
        "Repair a non-terminal Ask's GRAPH fields — its parent task, or a routingTarget the " +
        "router failed to persist (mt#4305). Distinct from asks_edit, which owns CONTENT: " +
        "routing fields are mechanism-owned and deliberately not reachable there. State is " +
        "never changed — a suspended Ask stays suspended and stays in the operator queue, so " +
        "this is not a way to retire an ask (use asks_cancel). Terminal asks are rejected. " +
        "`repairRoutingTarget` only FILLS an absent target, re-deriving the value from the " +
        "router itself; an Ask that already carries one is rejected, and there is no parameter " +
        "that can name a target. Every repair appends an editHistory provenance note carrying " +
        "the touched fields, the editor, and the prior parent when one was replaced. `id` " +
        "accepts a full UUID, an unambiguous prefix (>=8 hex chars), or an `ask#N` short id.",
      // requiresSetup: false — same posture as asks.edit / asks.respond: this
      // depends on the persistence provider, not on global Minsky config.
      requiresSetup: false,
      parameters: asksRepairParams,
      validate: async (params) => {
        // Reject a no-op call at the parameter boundary so the caller gets
        // immediate feedback rather than a domain-layer error after two reads.
        if (params.parentTaskId === undefined && !params.repairRoutingTarget) {
          throw new Error(
            "asks.repair: at least one repair must be requested (parentTaskId, repairRoutingTarget)."
          );
        }
      },
      execute: async (params): Promise<{ ask: Ask; repaired: string[] }> => {
        const repo = await requireAskRepository(container, "asks.repair");
        // mt#2696: resolve a short-prefix / ask#N citation before it reaches a
        // Postgres `uuid` column comparison.
        const id = await resolveAskIdInput(params.id as string, container);

        return repairAskGraph(
          repo,
          {
            id,
            parentTaskId: params.parentTaskId as string | undefined,
            repairRoutingTarget: params.repairRoutingTarget as boolean | undefined,
            editor: params.editor as string | undefined,
          },
          buildRepairDeps(container)
        );
      },
    })
  );
}
