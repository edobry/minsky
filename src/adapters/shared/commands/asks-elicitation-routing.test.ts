/**
 * `createAsk` — routingTarget persistence on the elicitation path (mt#4450).
 *
 * Split out of `asks.test.ts`, which sits at the 1500-line `max-lines` error
 * ceiling; adding these cases there tipped it over. The split is along a real
 * seam rather than an arbitrary line count — everything here is about one
 * question: does an ask routed to the elicitation transport end up ADDRESSABLE
 * by the operator, whether or not the dispatch succeeds?
 *
 * Why that question needs its own tests. The elicitation branch of `createAsk`
 * returns early and never reaches the shared `persistRouteOutcome` call, and
 * the transport's own walk (`advanceToSuspended`) issues state transitions and
 * writes no other column. So the row kept `routingTarget = NULL` even though
 * `pickTransport` had returned "operator" for it — and the cockpit inbox
 * filters on `routingTarget === "operator"` (`src/cockpit/routes/asks.ts:407`)
 * while its resolve endpoint refuses anything else (`:615`). A failed dispatch
 * therefore produced an ask the operator could neither see nor answer, which is
 * the failure mode the ask subsystem exists to prevent.
 *
 * Requested by PR #3259 R1 as a non-blocking finding; it is the right ask —
 * nothing pinned this column, so the fix could have silently regressed.
 */

import { describe, expect, test } from "bun:test";
import { createAsk } from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";

const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_asks_create__";
const KIND_DIRECTION_DECIDE = "direction.decide" as const;

const OPTIONS = [
  { label: "X", value: "x" },
  { label: "Y", value: "y" },
];

/** Params shared by both cases, so the only difference is the server's behavior. */
function askParams() {
  return {
    kind: KIND_DIRECTION_DECIDE,
    title: "Pick X",
    question: "Pick X or Y",
    options: OPTIONS,
    // Holds the test on the elicitation transport rather than on whichever
    // branch the per-kind service-window default happens to take (mt#4421).
    forceImmediate: true,
  };
}

describe("createAsk — elicitation routingTarget persistence (mt#4450)", () => {
  test("a FAILED dispatch still leaves an operator-addressable row", async () => {
    const repo = new FakeAskRepository();

    // A server whose dispatch throws — the shape a disconnected or
    // non-responding client produces. The live incident's exact error was
    // "MCP error -32000: Connection closed", logged by the transport as
    // "elicitation transport: dispatch failed; leaving Ask suspended".
    const failingServer = {
      elicitInput: async () => {
        throw new Error("MCP error -32000: Connection closed");
      },
    };

    const result = await createAsk(repo, askParams(), {
      workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
      capabilityRegistry: {
        hasElicitation: () => true,
        activeElicitationServer: () => failingServer,
      },
    });

    // The transport's documented contract on dispatch failure.
    expect(result.state).toBe("suspended");

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    // The assertion this file exists for: suspended AND addressable.
    expect(persisted?.routingTarget).toBe("operator");
  });

  test("a SUCCESSFUL dispatch persists the routing target too", async () => {
    // Not redundant with the case above: the two take different paths through
    // the transport (one throws before the response walk, one runs it to
    // completion), and only a shared write ahead of BOTH covers them.
    const repo = new FakeAskRepository();

    const acceptingServer = {
      elicitInput: async () => ({ action: "accept" as const, content: { chosen: "x" } }),
    };

    const result = await createAsk(repo, askParams(), {
      workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
      capabilityRegistry: {
        hasElicitation: () => true,
        activeElicitationServer: () => acceptingServer,
      },
    });

    expect(result.state).toBe("closed");

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("closed");
    expect(persisted?.routingTarget).toBe("operator");
  });
});
