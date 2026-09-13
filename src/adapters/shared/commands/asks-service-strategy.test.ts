/**
 * mt#4427 — `serviceStrategy` is a record field, not a routing input.
 *
 * Split out of `asks.test.ts`, which sits at the max-lines ceiling. These pin
 * the create path end-to-end through `createAsk` against a `FakeAskRepository`,
 * for the one kind whose default CHANGED (`authorization.approve`,
 * deadline-bound → asap) and for the matrix as a class.
 *
 * The regression guard that matters most here is that retiring the router's
 * deadline-bound branch does NOT move where an authorization ask lands. It was
 * `suspended` before — the branch's verdict and the inbox mapping wrote the
 * same state — and it is `suspended` after, now via the inbox mapping alone
 * (`routeResultToOutcomeWrite`, `packages/domain/src/ask/advancement.ts`).
 * What changes is the recorded strategy.
 */

import { describe, expect, test } from "bun:test";

import { createAsk } from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import { SERVICE_WINDOW_DEFAULTS } from "@minsky/domain/ask/service-window-defaults";

/** Non-existent root: no policy sources load, so the router reaches the kind matrix. */
const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_asks_service_strategy__";

/** A fixed far-future deadline — the clock is never read (mt#4740). */
const FAR_FUTURE_DEADLINE = "2030-01-01T00:00:00.000Z";

/** The one kind whose default changed under mt#4427. */
const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;

describe("mt#4427: authorization.approve create path", () => {
  test("with a far-future deadline persists asap + suspended (inbox), deadline retained", async () => {
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Authorize the thing",
        question: "May the agent do the thing?",
        deadline: FAR_FUTURE_DEADLINE,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(result.state).toBe("suspended");
    expect(result.routingTarget).toBe("operator");
    expect(result.transport.kind).toBe("inbox");

    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.routingTarget).toBe("operator");
    expect(persisted?.serviceStrategy).toBe("asap");
    // The deadline is still recorded — it just no longer routes.
    expect(persisted?.deadline).toBe(FAR_FUTURE_DEADLINE);
  });

  test("with NO deadline persists asap + suspended (inbox)", async () => {
    // The live population's shape: every deadline-bound ask in the production
    // record on 2026-09-13 had no deadline, and the retired branch suspended
    // each one through its `deadline === null` sub-case.
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Authorize the other thing",
        question: "May the agent do the other thing?",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(result.state).toBe("suspended");
    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.serviceStrategy).toBe("asap");
    expect(persisted?.deadline).toBeUndefined();
  });

  test("an explicit deadline-bound override is stored verbatim and still lands in suspended", async () => {
    // The value stays accepted (migration 0029's CHECK constraint, live rows);
    // it is recorded on the row and ignored by routing.
    const repo = new FakeAskRepository();

    const result = await createAsk(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Authorize with an explicit strategy",
        question: "May the agent do the third thing?",
        serviceStrategy: "deadline-bound",
        deadline: FAR_FUTURE_DEADLINE,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(result.state).toBe("suspended");
    const persisted = await repo.getById(result.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.serviceStrategy).toBe("deadline-bound");
  });
});

describe("mt#4427: per-kind default matrix", () => {
  test("EVERY kind defaults to asap — no default names a retired strategy", () => {
    // The class assertion for the strategy axis, mirroring mt#4421's for the
    // window axis in `asks.test.ts`: `scheduled` and `deadline-bound` are
    // stored-and-ignored values now, and a default producing either would
    // record a policy that nothing implements.
    for (const [kind, def] of Object.entries(SERVICE_WINDOW_DEFAULTS)) {
      expect({ kind, strategy: def.serviceStrategy }).toEqual({ kind, strategy: "asap" });
    }
  });
});
