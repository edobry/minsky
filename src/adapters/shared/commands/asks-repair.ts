/**
 * `asks.repair` — parameter schema and container-backed collaborators (mt#4305).
 *
 * Its own module rather than another block in `asks.ts`, which sits at the
 * 1500-line ESLint cap; the sibling test files (`asks.cancel.test.ts`,
 * `asks.severity-page.test.ts`, …) already establish one-file-per-concern here.
 *
 * Deliberately imports NOTHING from `./asks`. The registration itself stays
 * there, where `requireAskRepository` and `resolveAskIdInput` live, so this
 * module is a leaf and there is no import cycle to reason about.
 */

import { z } from "zod";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { Ask } from "@minsky/domain/ask/types";
import type { RepairAskGraphDeps } from "@minsky/domain/ask/repair";
import { policyFirstRoute, type PolicyFirstRouteOptions } from "@minsky/domain/ask/router";
import { routeResultToOutcomeWrite } from "@minsky/domain/ask/advancement";
import { selectCapabilityRegistry } from "./asks";

/**
 * Params for `asks.repair` — the GRAPH-field repair surface.
 *
 * Note what is NOT here: a `routingTarget` value. `repairRoutingTarget` is a
 * boolean because a caller-supplied target would let an agent address an ask to
 * itself and route around the operator; the value is re-derived from the router
 * instead. See `repairAskGraph`'s docblock for the full rule, and
 * `asks.repair.test.ts` for the structural guard that keeps this object free of
 * a target-shaped field.
 */
export const asksRepairParams = {
  id: {
    schema: z.string().trim().min(1),
    description: "Ask ID (UUID, unambiguous prefix, or ask#N short id) to repair",
    required: true,
  },
  parentTaskId: {
    schema: z.string().trim().min(1).optional(),
    description:
      "Move the Ask to this parent task. The task must exist; a reparent to the parent it " +
      "already has is rejected. State is never changed — reparenting is not a way to retire " +
      "an ask (use asks_cancel for that).",
    required: false,
  },
  repairRoutingTarget: {
    schema: z.boolean().optional(),
    description:
      "Fill an ABSENT routingTarget by re-deriving it from the router. Rejected when the Ask " +
      "already carries a target — this fills a field the router failed to write, it does not " +
      "re-route. There is deliberately no way to specify WHICH target.",
    required: false,
  },
  editor: {
    schema: z.string().trim().min(1).optional(),
    description:
      "Editor identity recorded in the provenance note; defaults to a session-unknown marker",
    required: false,
  },
};

/**
 * Build the collaborators `repairAskGraph` needs, from the DI container.
 *
 * Both are required by the domain function (ADR-026) — there is no
 * optional-dep-with-real-fallback here, so a caller that forgets to wire one
 * fails at the type level rather than silently reaching infrastructure.
 */
export function buildRepairDeps(container: AppContainerInterface | undefined): RepairAskGraphDeps {
  return {
    async taskExists(taskId: string): Promise<boolean> {
      if (!container?.has("taskService")) {
        throw new Error("asks.repair: task service unavailable — DI container not initialized");
      }
      const service = container.get("taskService");
      // `getTask` returns null for an unknown id rather than throwing, so the
      // null is what has to be read — a truthiness check on the CALL would
      // report every id as existing.
      return (await service.getTask(taskId)) !== null;
    },
    async resolveRoutingTarget(ask: Ask): Promise<string | undefined> {
      // Re-run the SAME router the create path runs, with the same options, so
      // the value that lands is the one the router itself would have chosen
      // rather than one this repair surface invented.
      // mt#4451: deliberately does NOT pass the repairer's own connection
      // capabilities, and the `undefined` first argument is the point rather
      // than an omission. A repair fixes an ask filed by some OTHER
      // conversation, often long ago; routing it by whoever happens to be
      // running the repair is precisely the "one connection decides for
      // another" category error mt#4451 exists to remove. So a repaired ask
      // resolves to no elicitation and lands addressable in the inbox.
      //
      // In production this is also what the container yields on its own — the
      // key holds the no-op since `createStartCommand` stopped overriding it —
      // but going through the shared selector states the intent instead of
      // depending on that default staying put.
      const capabilityRegistry = selectCapabilityRegistry(undefined, container);
      const routerOptions: PolicyFirstRouteOptions = capabilityRegistry
        ? { capabilityRegistry }
        : {};

      const routed = await policyFirstRoute(ask, routerOptions);
      // `ask.routingTarget` is absent by construction here (`repairAskGraph`
      // refuses otherwise), but pass it anyway so this call site inherits the
      // creator-override rule (mt#3491) identically to every other consumer of
      // this mapping instead of encoding a second, subtly different one.
      const { write } = routeResultToOutcomeWrite(routed, ask.routingTarget);

      if (write.state === "closed") {
        // The router's answer is "this should not be an open ask at all", which
        // is a DISPOSITION, not a routing target. Stamping `policy` on a
        // suspended row would leave it just as invisible to the operator as the
        // NULL this was called to fix, while looking repaired. Refuse, and let
        // the caller choose between answering it and retiring it.
        throw new Error(
          `asks.repair: the router would now resolve Ask ${ask.id} by policy rather than route it. ` +
            `That is a disposition, not a routing repair — answer it (asks_respond) or retire it (asks_cancel).`
        );
      }
      return write.routingTarget;
    },
  };
}
