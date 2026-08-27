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
import { createAsk, selectCapabilityRegistry } from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { ClientCapabilityRegistry } from "@minsky/domain/client-capabilities";

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

// ---------------------------------------------------------------------------
// Which registry decides the route (mt#4451)
// ---------------------------------------------------------------------------

/**
 * SC1 at the CALL SITE, which is where the original defect lived.
 *
 * `src/mcp/client-capabilities.test.ts` proves a caller-scoped registry answers
 * for one connection. That is necessary and not sufficient: the defect was that
 * `asks.create` never ASKED such a registry — it read the container's
 * process-wide one, so a correct per-connection implementation sitting unused
 * would have changed nothing.
 *
 * These assert the selection itself. `selectCapabilityRegistry` is exported for
 * exactly this reason: the live call site is inside a `registerCommand` closure,
 * and reaching it would mean patching a collaborator instead of reading a
 * returned value.
 */
describe("selectCapabilityRegistry — caller wins over container (mt#4451)", () => {
  const CALLER: ClientCapabilityRegistry = {
    hasElicitation: () => true,
    activeElicitationServer: () => ({ elicitInput: async () => ({ action: "accept" as const }) }),
  };
  const FLEET: ClientCapabilityRegistry = {
    hasElicitation: () => true,
    activeElicitationServer: () => ({ elicitInput: async () => ({ action: "accept" as const }) }),
  };
  const containerHolding = (registry: ClientCapabilityRegistry) => ({
    has: (key: string) => key === "clientCapabilityRegistry",
    get: (_key: string) => registry as unknown,
  });

  test("SC1: the caller's registry is chosen even when the container holds another", () => {
    // Identity, not capability: both advertise elicitation, so only identity
    // distinguishes "asked the caller" from "asked whoever was in the container".
    expect(selectCapabilityRegistry(CALLER, containerHolding(FLEET))).toBe(CALLER);
  });

  test("falls back to the container's registry when the call did not arrive over MCP", () => {
    expect(selectCapabilityRegistry(undefined, containerHolding(FLEET))).toBe(FLEET);
  });

  test("SC3: no caller connection and no container entry resolves to no registry at all", () => {
    const emptyContainer = { has: () => false, get: () => undefined as unknown };
    expect(selectCapabilityRegistry(undefined, emptyContainer)).toBeUndefined();
    expect(selectCapabilityRegistry(undefined, undefined)).toBeUndefined();
  });
});

/**
 * The end-to-end consequence of SC1/SC2: an ask filed by a connection that did
 * NOT advertise elicitation must not reach the elicitation transport, even
 * while another connection on the same daemon is elicitation-capable.
 *
 * Pre-fix this ask routed to elicitation and blocked its caller for ~330s
 * (measured 2026-08-23, mt#4450 AT1) before dying on the transport's idle
 * timeout.
 */
describe("createAsk — a non-advertising caller does not reach elicitation (mt#4451)", () => {
  test("routes to the inbox and stays operator-addressable", async () => {
    const repo = new FakeAskRepository();

    // What `SingleConnectionCapabilityRegistry` yields for a caller whose own
    // client advertised no elicitation — regardless of who else is connected.
    // WHICH registry `asks.create` hands to `createAsk` is the selection
    // covered above; this asserts what the router does once it has this one.
    const callerRegistry: ClientCapabilityRegistry = {
      hasElicitation: () => false,
      activeElicitationServer: () => null,
    };

    const result = await createAsk(repo, askParams(), {
      workspaceRoot: NONEXISTENT_WORKSPACE_ROOT,
      capabilityRegistry: callerRegistry,
    });

    expect(result.transport?.kind).toBe("inbox");
    // Still addressable by the operator — the mt#4450 guarantee holds here too.
    const persisted = await repo.getById(result.id);
    expect(persisted?.routingTarget).toBe("operator");
  });
});
