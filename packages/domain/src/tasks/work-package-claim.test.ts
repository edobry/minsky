import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  claimWorkPackage,
  releaseWorkPackage,
  explainClaimRefusal,
  explainReleaseRefusal,
  WORK_PACKAGE_KIND,
} from "./work-package-claim";

/**
 * Stateful fluent-chain fake emulating the ONE property the claim path buys
 * from Postgres: a conditional UPDATE matches a row exactly once. Configured
 * with successive `.returning()` results for updates and successive resolved
 * row sets for selects (each awaited select consumes one entry); `set` values
 * and inserted rows are captured for assertion. `transaction` hands back the
 * same fake — the module under test never branches on tx identity.
 */
function makeFakeDb(opts: {
  updateReturns: Array<Array<{ id: string }>>;
  selectReturns: Array<unknown[]>;
}) {
  let updateCall = 0;
  let selectCall = 0;
  const captured = {
    setValues: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
  };
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.setValues.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve(opts.updateReturns[updateCall++] ?? []),
          }),
        };
      },
    }),
    select: () => {
      const rows = () => opts.selectReturns[selectCall++] ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (
          onFulfilled: (rows: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => Promise.resolve(rows()).then(onFulfilled, onRejected),
      };
      return chain;
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.inserted.push(row);
        return Promise.resolve();
      },
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  } as unknown as PostgresJsDatabase;
  return { db, captured };
}

const NOW = new Date("2026-08-30T12:00:00.000Z");

describe("claimWorkPackage", () => {
  test("winner: conditional update matches, identity is written with the injected clock", async () => {
    const { db, captured } = makeFakeDb({
      updateReturns: [[{ id: "mt#100" }]],
      selectReturns: [],
    });
    const outcome = await claimWorkPackage(db, { taskId: "mt#100", claimedBy: "conv-A" }, NOW);
    expect(outcome).toEqual({ ok: true, taskId: "mt#100", claimedBy: "conv-A", claimedAt: NOW });
    expect(captured.setValues[0]).toMatchObject({
      status: "IN-PROGRESS",
      claimedBy: "conv-A",
      claimedAt: NOW,
    });
  });

  test("race loser: zero rows back, refusal names the holder from the diagnostic read", async () => {
    // AT2's shape: the same READY package, two claimants. The first update
    // matched (row consumed); the second matches nothing and the follow-up
    // read shows the winner's identity.
    const { db } = makeFakeDb({
      updateReturns: [[{ id: "mt#100" }], []],
      selectReturns: [[{ kind: WORK_PACKAGE_KIND, status: "IN-PROGRESS", claimedBy: "conv-A" }]],
    });
    const winner = await claimWorkPackage(db, { taskId: "mt#100", claimedBy: "conv-A" }, NOW);
    const loser = await claimWorkPackage(db, { taskId: "mt#100", claimedBy: "conv-B" }, NOW);
    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (!loser.ok && loser.reason === "not-claimable") {
      expect(loser.holder).toBe("conv-A");
      expect(loser.message).toContain("conv-A");
    } else {
      throw new Error(`expected not-claimable refusal, got ${JSON.stringify(loser)}`);
    }
  });

  test("nonexistent task: not-found refusal", async () => {
    const { db } = makeFakeDb({ updateReturns: [[]], selectReturns: [[]] });
    const outcome = await claimWorkPackage(db, { taskId: "mt#999", claimedBy: "conv-A" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("ordinary task: wrong-kind refusal names the kind and the ordinary path", async () => {
    const { db } = makeFakeDb({
      updateReturns: [[]],
      selectReturns: [[{ kind: "implementation", status: "READY", claimedBy: null }]],
    });
    const outcome = await claimWorkPackage(db, { taskId: "mt#42", claimedBy: "conv-A" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "wrong-kind", kind: "implementation" });
  });

  test("unclaimable status without a holder: refusal names the status", async () => {
    const { db } = makeFakeDb({
      updateReturns: [[]],
      selectReturns: [[{ kind: WORK_PACKAGE_KIND, status: "TODO", claimedBy: null }]],
    });
    const outcome = await claimWorkPackage(db, { taskId: "mt#100", claimedBy: "conv-A" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "not-claimable", status: "TODO" });
    if (!outcome.ok && outcome.reason === "not-claimable") {
      expect(outcome.message).toContain("TODO");
    }
  });
});

describe("releaseWorkPackage", () => {
  test("success: clears identity, returns READY, appends transfer with next seq", async () => {
    const { db, captured } = makeFakeDb({
      updateReturns: [[{ id: "mt#100" }]],
      // First select: the before-read (holder); second: max(seq) → next.
      selectReturns: [
        [{ kind: WORK_PACKAGE_KIND, status: "IN-PROGRESS", claimedBy: "conv-A" }],
        [{ next: 2 }],
      ],
    });
    const outcome = await releaseWorkPackage(
      db,
      { taskId: "mt#100", byConversation: "conv-A", notes: "docs half done" },
      NOW
    );
    expect(outcome).toEqual({
      ok: true,
      taskId: "mt#100",
      previousHolder: "conv-A",
      transferSeq: 2,
    });
    expect(captured.setValues[0]).toMatchObject({
      status: "READY",
      claimedBy: null,
      claimedAt: null,
    });
    expect(captured.inserted[0]).toMatchObject({
      packageTaskId: "mt#100",
      seq: 2,
      origin: "release",
      byConversation: "conv-A",
      notes: "docs half done",
    });
  });

  test("empty transfer log: first release entry gets seq 1", async () => {
    const { db, captured } = makeFakeDb({
      updateReturns: [[{ id: "mt#100" }]],
      selectReturns: [
        [{ kind: WORK_PACKAGE_KIND, status: "IN-PROGRESS", claimedBy: "conv-A" }],
        [{ next: 1 }],
      ],
    });
    const outcome = await releaseWorkPackage(db, { taskId: "mt#100", byConversation: null }, NOW);
    expect(outcome).toMatchObject({ ok: true, transferSeq: 1 });
    expect(captured.inserted[0]).toMatchObject({ seq: 1, notes: null });
  });

  test("unclaimed package: not-claimed refusal, no transfer appended", async () => {
    const { db, captured } = makeFakeDb({
      updateReturns: [[]],
      selectReturns: [[{ kind: WORK_PACKAGE_KIND, status: "READY", claimedBy: null }]],
    });
    const outcome = await releaseWorkPackage(db, { taskId: "mt#100", byConversation: "x" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "not-claimed", status: "READY" });
    expect(captured.inserted).toHaveLength(0);
  });

  test("ordinary task: wrong-kind refusal", async () => {
    const { db } = makeFakeDb({
      updateReturns: [[]],
      selectReturns: [[{ kind: "implementation", status: "IN-PROGRESS", claimedBy: null }]],
    });
    const outcome = await releaseWorkPackage(db, { taskId: "mt#42", byConversation: "x" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "wrong-kind", kind: "implementation" });
  });

  test("nonexistent task: not-found refusal", async () => {
    const { db } = makeFakeDb({ updateReturns: [[]], selectReturns: [[]] });
    const outcome = await releaseWorkPackage(db, { taskId: "mt#999", byConversation: "x" }, NOW);
    expect(outcome).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("explain* pure refusal builders", () => {
  test("explainClaimRefusal: claimed row without recorded holder still explains", () => {
    const outcome = explainClaimRefusal("mt#100", {
      kind: WORK_PACKAGE_KIND,
      status: "IN-PROGRESS",
      claimedBy: null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not-claimable", holder: null });
    if (!outcome.ok && outcome.reason === "not-claimable") {
      expect(outcome.message).toContain("holder was not recorded");
    }
  });

  test("explainReleaseRefusal: missing row is not-found", () => {
    expect(explainReleaseRefusal("mt#1", undefined)).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });
});
