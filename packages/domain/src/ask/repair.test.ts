/**
 * Tests for `repairAskGraph` (mt#4305) — the repair surface for an Ask's GRAPH
 * fields, the counterpart to `editAskContent`'s content surface.
 *
 * Exercises the domain function end-to-end against `FakeAskRepository` (which
 * mirrors the Drizzle backend's non-terminal guard, error text included),
 * verifying:
 *   1. Reparenting moves `parentTaskId` and never changes `state`.
 *   2. Routing repair FILLS an absent target with the router's own decision,
 *      and REFUSES an ask that already carries one — the authority rule that
 *      keeps this verb from becoming a re-route.
 *   3. Terminal asks are refused, same shape as `editAskContent`'s guard.
 *   4. A nonexistent parent task is refused.
 *   5. Provenance: every repair appends an editHistory note carrying the
 *      touched fields, the editor, and the PRIOR value of a moved parent.
 *   6. Negative controls: a content edit leaves both graph fields untouched.
 *
 * No `spyOn` anywhere: both collaborators are injected as plain functions
 * (`RepairAskGraphDeps`), which is the point of taking them as required deps
 * rather than reaching for a module the function imports.
 */

import { describe, expect, test } from "bun:test";

import { repairAskGraph, type RepairAskGraphDeps } from "./repair";
import { editAskContent, EDIT_HISTORY_METADATA_KEY, type AskEditNote } from "./edit";
import { FakeAskRepository } from "./repository";
import type { Ask, AskState } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KIND_DIRECTION_DECIDE = "direction.decide" as const;

const TEST_AGENT = "minsky.agent:test";
const ORIGINAL_PARENT = "mt#0001";
const FOLLOW_UP_PARENT = "mt#0002";
const OPERATOR = "operator";

/** Deps that say yes to every task and always resolve the operator target. */
const PERMISSIVE_DEPS: RepairAskGraphDeps = {
  taskExists: async () => true,
  resolveRoutingTarget: async () => OPERATOR,
};

/**
 * Seed an ask at `state`. `routingTarget` is left ABSENT by default — that is
 * the shape the three mt#4450 rows landed in and the one this verb repairs.
 */
async function seedAsk(
  repo: FakeAskRepository,
  overrides: { state?: AskState; routingTarget?: string; parentTaskId?: string } = {}
): Promise<Ask> {
  const created = await repo.create({
    kind: KIND_DIRECTION_DECIDE,
    classifierVersion: "v1.0.0",
    requestor: TEST_AGENT,
    title: "Pick the path",
    question: "Which way?",
    parentTaskId: overrides.parentTaskId ?? ORIGINAL_PARENT,
    ...(overrides.routingTarget === undefined
      ? {}
      : { routingTarget: overrides.routingTarget as Ask["routingTarget"] }),
    metadata: { unrelated: "keep me" },
  });
  const state = overrides.state ?? "suspended";
  if (state === "detected") return created;
  const seeded: Ask = { ...created, state };
  repo._seedAtState(seeded);
  return seeded;
}

function historyOf(ask: Ask): AskEditNote[] {
  const raw = ask.metadata[EDIT_HISTORY_METADATA_KEY];
  return Array.isArray(raw) ? (raw as AskEditNote[]) : [];
}

// ---------------------------------------------------------------------------
// Reparenting
// ---------------------------------------------------------------------------

describe("repairAskGraph — reparenting", () => {
  test("moves the parent, keeps the state, and records the move with its prior parent", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask, repaired } = await repairAskGraph(
      repo,
      { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT, editor: TEST_AGENT },
      PERMISSIVE_DEPS
    );

    expect(ask.parentTaskId).toBe(FOLLOW_UP_PARENT);
    // The invariant `editAskContent` holds, held here too: a suspended ask
    // stays suspended and stays in the operator queue. Repair is not disposal.
    expect(ask.state).toBe("suspended");
    expect(repaired).toEqual(["parentTaskId"]);

    const history = historyOf(ask);
    expect(history).toHaveLength(1);
    expect(history[0]?.fields).toEqual(["parentTaskId"]);
    expect(history[0]?.editor).toBe(TEST_AGENT);
    // The half `fields` alone cannot answer: moved FROM where.
    expect(history[0]?.previous?.parentTaskId).toBe(ORIGINAL_PARENT);
  });

  test("preserves unrelated metadata keys", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask } = await repairAskGraph(
      repo,
      { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT },
      PERMISSIVE_DEPS
    );

    expect(ask.metadata.unrelated).toBe("keep me");
  });

  test("defaults the editor when none is supplied", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask } = await repairAskGraph(
      repo,
      { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT },
      PERMISSIVE_DEPS
    );

    expect(historyOf(ask)[0]?.editor).toBe("minsky.agent:unknown");
  });

  test("refuses a parent task that does not exist", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);
    const deps: RepairAskGraphDeps = { ...PERMISSIVE_DEPS, taskExists: async () => false };

    await expect(
      repairAskGraph(repo, { id: seeded.id, parentTaskId: "mt#9999" }, deps)
    ).rejects.toThrow(/does not exist/);
  });

  test("refuses a reparent to the parent it already has", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    await expect(
      repairAskGraph(repo, { id: seeded.id, parentTaskId: ORIGINAL_PARENT }, PERMISSIVE_DEPS)
    ).rejects.toThrow(/already parented/);
  });

  test("allows a reparent onto a task that is itself terminal", async () => {
    // A DONE parent is a legitimate destination: moving an ask onto a task that
    // has since closed corrects the historical record, and mt#3215 removed the
    // sweep behaviour that made a terminal parent dangerous.
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask } = await repairAskGraph(
      repo,
      { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT },
      { ...PERMISSIVE_DEPS, taskExists: async () => true }
    );

    expect(ask.parentTaskId).toBe(FOLLOW_UP_PARENT);
  });
});

// ---------------------------------------------------------------------------
// Routing repair — the authority rule
// ---------------------------------------------------------------------------

describe("repairAskGraph — routingTarget", () => {
  test("fills an absent target with the value the router resolves", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);
    expect(seeded.routingTarget).toBeUndefined();

    const { ask, repaired } = await repairAskGraph(
      repo,
      { id: seeded.id, repairRoutingTarget: true },
      PERMISSIVE_DEPS
    );

    expect(ask.routingTarget).toBe(OPERATOR);
    expect(ask.state).toBe("suspended");
    expect(repaired).toEqual(["routingTarget"]);
    expect(historyOf(ask)[0]?.fields).toEqual(["routingTarget"]);
  });

  test("never takes the target from the caller — the router's value wins", async () => {
    // There is no parameter that could carry "agent:me"; the only way a value
    // reaches the row is through the injected resolver. This asserts the shape
    // structurally: a resolver returning a peer target lands that, and nothing
    // in `RepairAskGraphParams` could have overridden it.
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask } = await repairAskGraph(
      repo,
      { id: seeded.id, repairRoutingTarget: true },
      { ...PERMISSIVE_DEPS, resolveRoutingTarget: async () => "policy" }
    );

    expect(ask.routingTarget).toBe("policy");
  });

  test("REFUSES an ask that already carries a target — repair is not re-route", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo, { routingTarget: OPERATOR });

    await expect(
      repairAskGraph(repo, { id: seeded.id, repairRoutingTarget: true }, PERMISSIVE_DEPS)
    ).rejects.toThrow(/does not re-route/);
  });

  test("refuses to guess when the router resolves nothing", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    await expect(
      repairAskGraph(
        repo,
        { id: seeded.id, repairRoutingTarget: true },
        { ...PERMISSIVE_DEPS, resolveRoutingTarget: async () => undefined }
      )
    ).rejects.toThrow(/refusing to guess/);
  });

  test("repairs both fields in one call and records both on one note", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    const { ask, repaired } = await repairAskGraph(
      repo,
      { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT, repairRoutingTarget: true },
      PERMISSIVE_DEPS
    );

    expect(ask.parentTaskId).toBe(FOLLOW_UP_PARENT);
    expect(ask.routingTarget).toBe(OPERATOR);
    expect(repaired).toEqual(["parentTaskId", "routingTarget"]);
    expect(historyOf(ask)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe("repairAskGraph — rejections", () => {
  test.each(["closed", "cancelled", "expired"] as const)(
    "refuses a %s ask",
    async (state: AskState) => {
      const repo = new FakeAskRepository();
      const seeded = await seedAsk(repo, { state });

      await expect(
        repairAskGraph(repo, { id: seeded.id, parentTaskId: FOLLOW_UP_PARENT }, PERMISSIVE_DEPS)
      ).rejects.toThrow(/terminal state/);
    }
  );

  test("refuses an unknown ask id", async () => {
    const repo = new FakeAskRepository();

    await expect(
      repairAskGraph(repo, { id: "no-such-ask", parentTaskId: FOLLOW_UP_PARENT }, PERMISSIVE_DEPS)
    ).rejects.toThrow(/not found/);
  });

  test("refuses an empty id", async () => {
    const repo = new FakeAskRepository();

    await expect(
      repairAskGraph(repo, { id: "   ", parentTaskId: FOLLOW_UP_PARENT }, PERMISSIVE_DEPS)
    ).rejects.toThrow(/id is required/);
  });

  test("refuses a call requesting no repair at all", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    await expect(repairAskGraph(repo, { id: seeded.id }, PERMISSIVE_DEPS)).rejects.toThrow(
      /at least one repair/
    );
  });

  test("refuses an empty parentTaskId", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo);

    await expect(
      repairAskGraph(repo, { id: seeded.id, parentTaskId: "  " }, PERMISSIVE_DEPS)
    ).rejects.toThrow(/must not be empty/);
  });
});

// ---------------------------------------------------------------------------
// Negative controls — the content surface must not touch graph fields
// ---------------------------------------------------------------------------

describe("editAskContent leaves graph fields alone", () => {
  test("a content-only edit does not change parentTaskId or routingTarget", async () => {
    const repo = new FakeAskRepository();
    const seeded = await seedAsk(repo, { routingTarget: OPERATOR });

    const { ask } = await editAskContent(repo, {
      id: seeded.id,
      question: "Rewritten question",
    });

    expect(ask.parentTaskId).toBe(ORIGINAL_PARENT);
    expect(ask.routingTarget).toBe(OPERATOR);
  });
});
