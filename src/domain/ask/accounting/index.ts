/**
 * Ask attention-accounting module — ADR-008 §Attention accounting.
 *
 * Implements:
 *   - buildAttentionCost() — derive AttentionCost from a close event
 *   - getRollupForTask() — per-task rollup aggregation
 *   - getRollupForKind() — per-kind top-10 rollup aggregation
 *
 * v1 is observational only (no budget enforcement per ADR-008).
 *
 * Reference: mt#1071, ADR-008 §Attention accounting.
 */

import type { Ask, AskKind, AttentionCost, TransportKind } from "../types";
import type { AskRepository } from "../repository";

// ---------------------------------------------------------------------------
// Responder → TransportKind mapping
// ---------------------------------------------------------------------------

/**
 * Responder values that map to a known TransportKind.
 * When the responder is an arbitrary AgentId string (e.g. a subagent id),
 * we default to "subagent" transport.
 */
const RESPONDER_TO_TRANSPORT: Record<string, TransportKind> = {
  operator: "inbox",
  policy: "policy",
  timeout: "timeout",
};

/**
 * Responder values that map to a known resolvedIn value.
 */
const RESPONDER_TO_RESOLVED_IN: Record<string, AttentionCost["resolvedIn"]> = {
  operator: "inbox",
  policy: "policy",
  timeout: "timeout",
};

/**
 * Derive transport and resolvedIn from a responder string.
 *
 * - "policy" -> transport = "policy", resolvedIn = "policy"
 * - "operator" -> transport = "inbox", resolvedIn = "inbox"
 * - "timeout" -> transport = "timeout", resolvedIn = "timeout"
 * - any other string (AgentId) -> transport = "subagent", resolvedIn = "subagent"
 */
function deriveTransportAndResolvedIn(responder: string): {
  transport: TransportKind;
  resolvedIn: AttentionCost["resolvedIn"];
} {
  const transport: TransportKind =
    (RESPONDER_TO_TRANSPORT[responder] as TransportKind | undefined) ?? "subagent";
  const resolvedIn: AttentionCost["resolvedIn"] =
    (RESPONDER_TO_RESOLVED_IN[responder] as AttentionCost["resolvedIn"] | undefined) ?? "subagent";
  return { transport, resolvedIn };
}

// ---------------------------------------------------------------------------
// buildAttentionCost — fill-in on close
// ---------------------------------------------------------------------------

/**
 * Input for building an AttentionCost on Ask close.
 *
 * Callers (the close path in the adapter layer or a wrapper around
 * AskRepository.close()) supply this context so the accounting module
 * can construct the correct cost shape per ADR-008 + the audit-corrected
 * success criteria.
 */
export interface AttentionCostInput {
  /** Who resolved the Ask — determines transport + resolvedIn. */
  responder: string;
  /**
   * Token cost for subagent/retriever asks.
   * Only relevant when responder is an AgentId (not "policy"/"operator"/"timeout").
   */
  tokenCost?: number;
  /**
   * Operator cost ordinal — present when the ask was escalated to a human.
   * Only relevant when responder is "operator".
   */
  operatorCost?: AttentionCost["operatorCost"];
}

/**
 * Build an `AttentionCost` record for an Ask being closed.
 *
 * Applies audit-corrected rules:
 *   - responder = "policy" -> tokenCost = 0, resolvedIn = "policy", no operatorCost
 *   - responder = "operator" -> transport = "inbox", attach operatorCost if provided
 *   - responder = "timeout" -> transport = "timeout", resolvedIn = "timeout"
 *   - other responders (AgentId) -> transport = "subagent", attach tokenCost if provided
 *
 * Does NOT apply to cancelled/expired Asks — callers must check state before calling.
 */
export function buildAttentionCost(input: AttentionCostInput): AttentionCost {
  const { transport, resolvedIn } = deriveTransportAndResolvedIn(input.responder);

  if (resolvedIn === "policy") {
    // Policy close: zero token cost, no operatorCost, resolvedIn = "policy"
    return {
      tokenCost: 0,
      transport,
      resolvedIn,
    };
  }

  const cost: AttentionCost = {
    transport,
    resolvedIn,
  };

  if (input.tokenCost !== undefined) {
    cost.tokenCost = input.tokenCost;
  }

  if (input.operatorCost !== undefined) {
    cost.operatorCost = input.operatorCost;
  }

  return cost;
}

// ---------------------------------------------------------------------------
// Rollup types
// ---------------------------------------------------------------------------

/**
 * Operator-cost ordinal distribution for a population of Asks.
 *
 * Only counts Asks that have `operatorCost` populated.
 */
export interface OperatorCostDistribution {
  quick: number;
  medium: number;
  deep: number;
}

/**
 * Per-kind count within a task rollup.
 */
export type KindCounts = Record<AskKind, number>;

/**
 * Rollup of attention costs for a single task.
 *
 * Denominator excludes Asks that are in cancelled or expired state AND
 * have not been routed yet (pre-routing cancellations/expirations).
 */
export interface TaskRollup {
  /** The task ID this rollup is for. */
  taskId: string;
  /** Total Asks included in the denominator (excludes pre-routing cancelled/expired). */
  total: number;
  /** Per-kind counts over the included population. */
  kindCounts: KindCounts;
  /** Ordinal distribution over Asks with operatorCost populated. */
  operatorCostDistribution: OperatorCostDistribution;
}

/**
 * A single entry in the per-kind top-10 rollup.
 */
export interface KindTaskEntry {
  taskId: string;
  askCount: number;
  /** Sum of ordinal weights: quick=1, medium=2, deep=3 */
  operatorCostWeight: number;
}

/**
 * Rollup of the most expensive tasks for a given Ask kind.
 */
export interface KindRollup {
  kind: AskKind;
  /** Top 10 tasks by costliness heuristic (operatorCostWeight desc, askCount desc). */
  topTasks: KindTaskEntry[];
}

// ---------------------------------------------------------------------------
// Pre-routing detection helper
// ---------------------------------------------------------------------------

/**
 * Asks that are cancelled or expired before routing have not yet had a transport
 * selected and are excluded from rollup denominators per audit-corrected SC#3.
 *
 * "Pre-routing" means the Ask never reached state "routed" or beyond.
 * We detect this by checking whether `routedAt` is absent.
 */
function isPreRoutingCancelledOrExpired(ask: Ask): boolean {
  if (ask.state !== "cancelled" && ask.state !== "expired") return false;
  // If routedAt is set, routing happened before cancellation/expiration.
  return !ask.routedAt;
}

// ---------------------------------------------------------------------------
// getRollupForTask
// ---------------------------------------------------------------------------

const ALL_KINDS: AskKind[] = [
  "capability.escalate",
  "information.retrieve",
  "authorization.approve",
  "direction.decide",
  "coordination.notify",
  "quality.review",
  "stuck.unblock",
];

const ORDINAL_WEIGHTS: Record<string, number> = {
  quick: 1,
  medium: 2,
  deep: 3,
};

/**
 * Compute a per-task attention rollup.
 *
 * @param repo   AskRepository to query.
 * @param taskId Parent task ID (e.g., "mt#123").
 * @returns      TaskRollup over all non-excluded Asks for the task.
 */
export async function getRollupForTask(repo: AskRepository, taskId: string): Promise<TaskRollup> {
  const all = await repo.listByParentTask(taskId);

  // Exclude pre-routing cancelled/expired Asks from the denominator.
  const included = all.filter((a) => !isPreRoutingCancelledOrExpired(a));

  // Per-kind counts
  const kindCounts: KindCounts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as KindCounts;
  for (const ask of included) {
    if (ask.kind in kindCounts) {
      kindCounts[ask.kind]++;
    }
  }

  // Operator cost ordinal distribution — only over Asks with operatorCost
  const dist: OperatorCostDistribution = { quick: 0, medium: 0, deep: 0 };
  for (const ask of included) {
    const operatorCost = ask.response?.attentionCost?.operatorCost;
    if (operatorCost) {
      const kind = operatorCost.kind;
      if (kind === "quick") dist.quick++;
      else if (kind === "medium") dist.medium++;
      else if (kind === "deep") dist.deep++;
    }
  }

  return {
    taskId,
    total: included.length,
    kindCounts,
    operatorCostDistribution: dist,
  };
}

// ---------------------------------------------------------------------------
// getRollupForKind
// ---------------------------------------------------------------------------

/**
 * Compute a per-kind rollup: the top 10 most expensive tasks for the given kind.
 *
 * "Expensive" heuristic: sum of operator cost ordinal weights (quick=1, medium=2,
 * deep=3) across Asks of this kind on the task. Ties broken by askCount descending.
 *
 * Only task-scoped Asks (with parentTaskId) are included.
 * Pre-routing cancelled/expired Asks are excluded from the denominator.
 *
 * @param repo AskRepository to query.
 * @param kind The AskKind to roll up.
 * @returns    KindRollup with top 10 tasks.
 */
export async function getRollupForKind(repo: AskRepository, kind: AskKind): Promise<KindRollup> {
  // Query all states and filter by kind.
  const allStates = [
    "detected",
    "classified",
    "routed",
    "suspended",
    "responded",
    "closed",
    "cancelled",
    "expired",
  ] as const;

  const allAsks: Ask[] = [];
  for (const state of allStates) {
    const subset = await repo.listByState(state);
    allAsks.push(...subset.filter((a) => a.kind === kind));
  }

  // Exclude pre-routing cancelled/expired
  const included = allAsks.filter((a) => !isPreRoutingCancelledOrExpired(a));

  // Group by parentTaskId — skip session-scoped Asks (no parentTaskId)
  const byTask = new Map<string, Ask[]>();
  for (const ask of included) {
    if (!ask.parentTaskId) continue;
    const list = byTask.get(ask.parentTaskId);
    if (list) {
      list.push(ask);
    } else {
      byTask.set(ask.parentTaskId, [ask]);
    }
  }

  // Compute per-task cost entry
  const entries: KindTaskEntry[] = [];
  for (const [taskId, asks] of byTask) {
    let operatorCostWeight = 0;
    for (const ask of asks) {
      const operatorCost = ask.response?.attentionCost?.operatorCost;
      if (operatorCost) {
        operatorCostWeight += ORDINAL_WEIGHTS[operatorCost.kind] ?? 0;
      }
    }
    entries.push({
      taskId,
      askCount: asks.length,
      operatorCostWeight,
    });
  }

  // Sort: primary by operatorCostWeight desc, secondary by askCount desc
  entries.sort((a, b) => {
    const weightDiff = b.operatorCostWeight - a.operatorCostWeight;
    if (weightDiff !== 0) return weightDiff;
    return b.askCount - a.askCount;
  });

  return {
    kind,
    topTasks: entries.slice(0, 10),
  };
}
