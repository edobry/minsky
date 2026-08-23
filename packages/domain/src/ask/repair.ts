/**
 * repairAskGraph — repair surface for an Ask's GRAPH fields (mt#4305).
 *
 * `editAskContent` (`edit.ts`) serves the CONTENT surface, and its
 * `EditAskFields` docblock draws the boundary this module sits on the other
 * side of: lifecycle state, routing fields and service-window fields "are owned
 * by their respective mechanisms (state machine, router, reaper) and are NOT
 * reachable through `updateContent`."
 *
 * That boundary is about who may REWRITE a field. It left no answer at all to a
 * different question — what happens when the owning mechanism gets it wrong, or
 * never writes it. Two fields sat on the wrong side of that gap:
 *
 * - **`parentTaskId`** had no write path after creation, in any layer. mem#724
 *   told agents to "re-parent the ask to the follow-up task before merging" as
 *   the mitigation for a sweep trap; no surface could do it, so an agent
 *   following the corpus either failed or substituted something worse — a
 *   duplicate ask, or answering the original to retire it, which
 *   `respondAndClose` records against `"operator"` by default and thereby
 *   attributes an agent's withdrawal to the principal (mem#1122, mem#1007).
 * - **`routingTarget`** had a repository write (`updateRoutingTarget`) and no
 *   tool surface. When mt#4450's elicitation branch returned before
 *   `persistRouteOutcome`, three suspended asks landed carrying no target at
 *   all. `src/cockpit/routes/asks.ts` filters `routingTarget === "operator"` on
 *   both the inbox list (`:407`, `:420`) and the resolve endpoint (`:614`, a
 *   403), so those asks were invisible AND unresolvable on the operator's own
 *   surface while remaining answerable through `asks.respond`, which accepts any
 *   suspended ask. A live decision the principal could not reach.
 *
 * ## The authority rule, and why it is the whole design
 *
 * A verb that sets `routingTarget` to a caller-supplied value would let an agent
 * address an ask to ITSELF and route around the operator entirely — the
 * opposite of what the Ask subsystem is for. So this module does not accept a
 * routing target. It REPAIRS one:
 *
 * 1. It refuses an ask that already carries a target. Filling an absent field is
 *    a repair; replacing a present one is a re-route, and this is not that verb.
 * 2. It never takes the value as input. The caller supplies a
 *    {@link RepairAskGraphDeps.resolveRoutingTarget} that re-derives the target
 *    from the router, so the value that lands is the one the router itself would
 *    have chosen. This is the same mechanism mt#4450 applied inline
 *    (`routeResultToOutcomeWrite`), reused rather than re-decided.
 *
 * The consequence worth stating plainly: there is no argument to this function
 * that can produce an arbitrary routing target. The constraint is structural,
 * not a validation that could be forgotten at one call site.
 *
 * ## Deps are required, never optional-with-fallback
 *
 * {@link RepairAskGraphDeps} is a required parameter and both of its members are
 * required, per ADR-026 — an optional dep with a real fallback is the shape that
 * let two tests reach live infrastructure by injecting nothing (mt#3609). It is
 * also what makes this module testable without patching a collaborator it
 * reaches itself (`testing-standards.mdc §Testable Design`): a test supplies
 * plain functions, and there is no `spyOn` anywhere in `repair.test.ts`.
 *
 * ## What it does NOT do
 *
 * Repairing never changes `state` — the same invariant `editAskContent` holds.
 * A suspended ask stays suspended and stays in the operator queue. Reparenting
 * is not a disposal route; retiring an ask is `asks.cancel` (mt#3353), which
 * records who cancelled it and why.
 */

import type { Ask } from "./types";
import type { AskRepository, RepairAskGraphFields } from "./repository";
import {
  EDIT_HISTORY_METADATA_KEY,
  sanitizeMetadata,
  type AskEditNote,
  type AskGraphPrevious,
} from "./edit";

/** Params for {@link repairAskGraph}. At least one repair must be requested. */
export interface RepairAskGraphParams {
  /** Primary key of the Ask to repair. */
  id: string;
  /** Who is repairing — AgentId or "operator". Defaults to "minsky.agent:unknown". */
  editor?: string;
  /**
   * Move the Ask to this parent task. Validated to exist via
   * {@link RepairAskGraphDeps.taskExists}.
   */
  parentTaskId?: string;
  /**
   * Fill an ABSENT `routingTarget` with the router's own decision.
   *
   * A boolean rather than a value, deliberately — see this module's docblock.
   * There is no way to say WHICH target; only that the missing one should be
   * re-derived.
   */
  repairRoutingTarget?: boolean;
}

/** Injected collaborators. Both required (ADR-026). */
export interface RepairAskGraphDeps {
  /**
   * Whether `taskId` names a task that exists.
   *
   * A reparent to a nonexistent id is refused rather than allowed: an ask whose
   * parent does not resolve is worse off than one parented to the wrong real
   * task, because every consumer that walks the graph from the parent side
   * (`listByParentTask`, the cockpit task page, the sweeps) simply never sees
   * it. A TERMINAL parent is deliberately ALLOWED — moving an ask onto a task
   * that has since closed is a legitimate correction of the historical record,
   * and the sweep no longer closes asks on parent-terminal for the class where
   * that mattered (mt#3215).
   */
  taskExists(taskId: string): Promise<boolean>;
  /**
   * The `routingTarget` the router would choose for this Ask, re-derived now.
   *
   * Returning `undefined` means the router produced no target, which is a
   * refusal rather than a no-op: a repair that cannot determine the right value
   * must not guess one.
   */
  resolveRoutingTarget(ask: Ask): Promise<string | undefined>;
}

/**
 * Repair an Ask's graph fields in place.
 *
 * Preconditions (validated up front, with clear errors):
 *   - `params.id` is a non-empty string.
 *   - At least one repair is requested (`parentTaskId` or `repairRoutingTarget`).
 *   - The Ask exists.
 *   - The Ask is NOT terminal (closed / cancelled / expired). Enforced twice —
 *     here for a readable error, and atomically inside `repo.repairGraphFields`
 *     so a concurrent close cannot slip a repair onto a terminal row.
 *   - When repairing routing: the Ask carries NO `routingTarget` today, and the
 *     router resolves one now.
 *   - When reparenting: the new parent exists, and differs from the current one.
 */
export async function repairAskGraph(
  repo: AskRepository,
  params: RepairAskGraphParams,
  deps: RepairAskGraphDeps
): Promise<{ ask: Ask; repaired: string[] }> {
  if (!params.id || params.id.trim() === "") {
    throw new Error("repairAskGraph: id is required and must not be empty");
  }
  if (params.parentTaskId === undefined && !params.repairRoutingTarget) {
    throw new Error(
      "repairAskGraph: at least one repair must be requested (parentTaskId, repairRoutingTarget)"
    );
  }

  const existing = await repo.getById(params.id);
  if (!existing) {
    throw new Error(`repairAskGraph: Ask not found: ${params.id}`);
  }
  if (
    existing.state === "closed" ||
    existing.state === "cancelled" ||
    existing.state === "expired"
  ) {
    throw new Error(
      `repairAskGraph: Ask is in terminal state "${existing.state}" — only non-terminal Asks can be repaired. ` +
        `Repairing never changes state; a suspended Ask stays suspended.`
    );
  }

  const write: RepairAskGraphFields = {};
  const previous: AskGraphPrevious = {};
  const repaired: string[] = [];

  if (params.parentTaskId !== undefined) {
    const next = params.parentTaskId.trim();
    if (next === "") {
      throw new Error("repairAskGraph: parentTaskId must not be empty — use a real task id");
    }
    if (next === existing.parentTaskId) {
      throw new Error(
        `repairAskGraph: Ask ${params.id} is already parented to ${next} — nothing to repair`
      );
    }
    if (!(await deps.taskExists(next))) {
      throw new Error(
        `repairAskGraph: task ${next} does not exist — refusing to reparent Ask ${params.id} onto a parent that will not resolve`
      );
    }
    write.parentTaskId = next;
    if (existing.parentTaskId !== undefined) previous.parentTaskId = existing.parentTaskId;
    repaired.push("parentTaskId");
  }

  if (params.repairRoutingTarget) {
    // The authority rule. A present target is the router's own decision (or an
    // authoritative creator override, mt#3491) and is not this verb's to
    // revise — refusing here is what keeps "repair" from becoming "re-route".
    if (existing.routingTarget) {
      throw new Error(
        `repairAskGraph: Ask ${params.id} already has routingTarget "${existing.routingTarget}" — ` +
          `this verb fills an ABSENT target, it does not re-route. Nothing to repair.`
      );
    }
    const resolved = await deps.resolveRoutingTarget(existing);
    if (!resolved) {
      throw new Error(
        `repairAskGraph: the router resolved no routingTarget for Ask ${params.id} — refusing to guess one`
      );
    }
    write.routingTarget = resolved;
    repaired.push("routingTarget");
  }

  // Provenance, in the SAME write as the field change (see
  // `RepairAskGraphFields`). Appended to the same append-only history the
  // content edits write, so one read shows every change an Ask has taken —
  // `sanitizeMetadata` on the existing side for the same reason `editAskContent`
  // applies it: metadata reaches the substrate from an untrusted surface, and a
  // prototype-pollution vector must not survive a merge on any path.
  const existingHistory = existing.metadata[EDIT_HISTORY_METADATA_KEY];
  const history = Array.isArray(existingHistory) ? existingHistory : [];
  const note: AskEditNote = {
    editedAt: new Date().toISOString(),
    editor: params.editor?.trim() || "minsky.agent:unknown",
    fields: repaired,
    ...(Object.keys(previous).length > 0 ? { previous } : {}),
  };
  write.metadata = {
    ...sanitizeMetadata(existing.metadata),
    [EDIT_HISTORY_METADATA_KEY]: [...history, note],
  };

  const ask = await repo.repairGraphFields(params.id, write);
  return { ask, repaired };
}
