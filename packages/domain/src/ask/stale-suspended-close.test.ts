/**
 * Tests for runStaleSuspendedAskCloseSweep (mt#3001) — the recurring
 * reconciliation layer that retires resolved-but-suspended asks.
 *
 * The fixture matrix mirrors the mt#3000 residue patterns (the 12 stale asks
 * that survived every one-time sweep): parent-terminal mt#/gh# asks,
 * failed-commit orphans superseded by a landed retry, TTL-expired abandoned
 * asks — plus the classes the sweep must NEVER touch (fresh non-commit
 * authorization asks, direction.decide, active-parent review asks).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import type { Ask, AskState } from "./types";
import type { AskRepository } from "./repository";
import {
  runStaleSuspendedAskCloseSweep,
  isCommitAuthAsk,
  DEFAULT_STALE_COMMIT_AUTH_TTL_MS,
  RESPONDER_PARENT_TERMINAL,
  RESPONDER_SUPERSEDED,
} from "./stale-suspended-close";

const KIND_AUTH_APPROVE = "authorization.approve";
const KIND_QUALITY_REVIEW = "quality.review";
const KIND_DIRECTION_DECIDE = "direction.decide";
const COMMIT_TITLE = "Commit authorization: test commit";
const SESSION_A = "session-aaaa";

interface SeedInput {
  kind: Ask["kind"];
  state?: AskState;
  parentTaskId?: string;
  parentSessionId?: string;
  commitMessage?: string;
}

/**
 * Seed an Ask and walk it to the target state (default `suspended`).
 * Age-sensitive tests drive the sweep's `nowMs` forward instead of
 * back-dating `createdAt` (the fake stamps creation time itself).
 */
async function seed(repo: FakeAskRepository, input: SeedInput): Promise<string> {
  const ask = await repo.create({
    kind: input.kind,
    classifierVersion: "v1",
    requestor: "test",
    title: input.commitMessage !== undefined ? COMMIT_TITLE : `${input.kind}: test`,
    question: "test?",
    parentTaskId: input.parentTaskId,
    parentSessionId: input.parentSessionId,
    metadata: input.commitMessage !== undefined ? { commitMessage: input.commitMessage } : {},
  });
  const target = input.state ?? "suspended";
  const linear: Partial<Record<AskState, AskState>> = {
    detected: "classified",
    classified: "routed",
    routed: "suspended",
    suspended: "responded",
    responded: "closed",
  };
  let current = ask;
  while (current.state !== target) {
    const next = linear[current.state];
    if (!next) throw new Error(`cannot walk to ${target} from ${current.state}`);
    current = await repo.transition(current.id, next);
  }
  return ask.id;
}

async function stateOf(repo: AskRepository, id: string): Promise<AskState | undefined> {
  return (await repo.getById(id))?.state;
}

async function createdAtMs(repo: AskRepository, id: string): Promise<number> {
  const ask = await repo.getById(id);
  if (!ask) throw new Error(`seeded ask not found: ${id}`);
  return Date.parse(ask.createdAt);
}

const EMPTY_STATUS_MAP: ReadonlyMap<string, string> = new Map();

describe("isCommitAuthAsk", () => {
  it("recognizes authorization.approve with metadata.commitMessage; rejects others", () => {
    const base = {
      id: "x",
      classifierVersion: "v1",
      state: "suspended",
      requestor: "r",
      title: "t",
      question: "q",
      createdAt: new Date().toISOString(),
      windowMissedCount: 0,
      forceImmediate: false,
    } as unknown as Ask;
    expect(
      isCommitAuthAsk({ ...base, kind: KIND_AUTH_APPROVE, metadata: { commitMessage: "m" } })
    ).toBe(true);
    expect(isCommitAuthAsk({ ...base, kind: KIND_AUTH_APPROVE, metadata: {} })).toBe(false);
    expect(
      isCommitAuthAsk({ ...base, kind: KIND_QUALITY_REVIEW, metadata: { commitMessage: "m" } })
    ).toBe(false);
  });
});

describe("runStaleSuspendedAskCloseSweep", () => {
  let repo: FakeAskRepository;
  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("closes a commit-auth ask whose parent task is terminal, with the audit responder", async () => {
    const id = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "mt#100",
      commitMessage: "fix: x",
    });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["mt#100", "DONE"]]),
    });
    expect(outcome.closedParentTerminal).toBe(1);
    expect(await stateOf(repo, id)).toBe("closed");
    expect((await repo.getById(id))?.response?.responder).toBe(RESPONDER_PARENT_TERMINAL);
  });

  it("closes a quality.review ask on parent-terminal; leaves parent-active review asks open", async () => {
    const doneId = await seed(repo, { kind: KIND_QUALITY_REVIEW, parentTaskId: "mt#200" });
    const activeId = await seed(repo, { kind: KIND_QUALITY_REVIEW, parentTaskId: "mt#201" });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([
        ["mt#200", "CLOSED"],
        ["mt#201", "IN-PROGRESS"],
      ]),
    });
    expect(outcome.closedParentTerminal).toBe(1);
    expect(await stateOf(repo, doneId)).toBe("closed");
    expect(await stateOf(repo, activeId)).toBe("suspended");
  });

  it("treats a lowercase backend status (gh#-style 'closed') as terminal", async () => {
    const id = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "gh#1761",
      commitMessage: "fix: tray",
    });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["gh#1761", "closed"]]),
    });
    expect(outcome.closedParentTerminal).toBe(1);
    expect(await stateOf(repo, id)).toBe("closed");
  });

  it("closes a failed-commit orphan when a LATER commit-auth ask from the same session landed", async () => {
    const orphanId = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "mt#300",
      parentSessionId: SESSION_A,
      commitMessage: "fix: first attempt",
    });
    // Ensure the retry's createdAt is STRICTLY later — the fake stamps
    // millisecond-resolution timestamps and supersession requires `>`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The successful retry: created later, same session, reached closed.
    await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      state: "closed",
      parentTaskId: "mt#300",
      parentSessionId: SESSION_A,
      commitMessage: "fix: retry that landed",
    });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: EMPTY_STATUS_MAP,
    });
    expect(outcome.closedSuperseded).toBe(1);
    expect(await stateOf(repo, orphanId)).toBe("closed");
    expect((await repo.getById(orphanId))?.response?.responder).toBe(RESPONDER_SUPERSEDED);
  });

  it("does NOT treat a later landed commit from a DIFFERENT session as supersession", async () => {
    const orphanId = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "mt#310",
      parentSessionId: SESSION_A,
      commitMessage: "fix: attempt",
    });
    await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      state: "closed",
      parentTaskId: "mt#310",
      parentSessionId: "session-bbbb",
      commitMessage: "fix: other session's commit",
    });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: EMPTY_STATUS_MAP,
    });
    expect(outcome.closedSuperseded).toBe(0);
    expect(await stateOf(repo, orphanId)).toBe("suspended");
  });

  it("expires a commit-auth ask older than the TTL (gh#-parented, unresolvable status)", async () => {
    const id = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "gh#1761",
      parentSessionId: SESSION_A,
      commitMessage: "fix: tray",
    });
    const createdMs = await createdAtMs(repo, id);
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: EMPTY_STATUS_MAP,
      nowMs: createdMs + DEFAULT_STALE_COMMIT_AUTH_TTL_MS + 60_000,
    });
    expect(outcome.expiredTtl).toBe(1);
    expect(await stateOf(repo, id)).toBe("expired");
  });

  it("leaves a FRESH commit-auth ask open when no signal fires", async () => {
    const id = await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "mt#320",
      parentSessionId: SESSION_A,
      commitMessage: "fix: fresh",
    });
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["mt#320", "IN-PROGRESS"]]),
    });
    expect(outcome.untouched).toBe(1);
    expect(await stateOf(repo, id)).toBe("suspended");
  });

  it("never TTL-expires or supersedes a NON-commit authorization ask; closes it only on parent-terminal", async () => {
    // A canary/credential-style approval: no metadata.commitMessage.
    const canaryId = await seed(repo, { kind: KIND_AUTH_APPROVE, parentTaskId: "mt#400" });
    const canaryCreatedMs = await createdAtMs(repo, canaryId);
    // Even with an ancient clock, the non-commit ask must survive.
    const old = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["mt#400", "IN-PROGRESS"]]),
      nowMs: canaryCreatedMs + 10 * DEFAULT_STALE_COMMIT_AUTH_TTL_MS,
    });
    expect(old.untouched).toBe(1);
    expect(await stateOf(repo, canaryId)).toBe("suspended");
    // Parent goes terminal → now it closes as moot.
    const after = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["mt#400", "DONE"]]),
    });
    expect(after.closedParentTerminal).toBe(1);
    expect(await stateOf(repo, canaryId)).toBe("closed");
  });

  it("never touches direction.decide, even with a terminal parent and an ancient clock", async () => {
    const id = await seed(repo, { kind: KIND_DIRECTION_DECIDE, parentTaskId: "mt#500" });
    const decideCreatedMs = await createdAtMs(repo, id);
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: new Map([["mt#500", "DONE"]]),
      nowMs: decideCreatedMs + 10 * DEFAULT_STALE_COMMIT_AUTH_TTL_MS,
    });
    expect(outcome.untouched).toBe(1);
    expect(outcome.closedParentTerminal).toBe(0);
    expect(await stateOf(repo, id)).toBe("suspended");
  });

  it("respects the batch cap and reports the deferred remainder", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seed(repo, { kind: KIND_DIRECTION_DECIDE, parentTaskId: `mt#60${i}` });
    }
    const outcome = await runStaleSuspendedAskCloseSweep(repo, {
      taskStatusById: EMPTY_STATUS_MAP,
      batchLimit: 3,
    });
    expect(outcome.scanned).toBe(3);
    expect(outcome.deferred).toBe(2);
  });

  it("fails open when the suspended listing throws (zero outcome, no throw)", async () => {
    const broken = {
      ...repo,
      listByState: async () => {
        throw new Error("db down");
      },
    } as unknown as AskRepository;
    const outcome = await runStaleSuspendedAskCloseSweep(broken, {
      taskStatusById: EMPTY_STATUS_MAP,
    });
    expect(outcome.scanned).toBe(0);
    expect(outcome.errors).toBe(0);
  });

  it("is idempotent: a second pass over already-retired asks changes nothing", async () => {
    await seed(repo, {
      kind: KIND_AUTH_APPROVE,
      parentTaskId: "mt#700",
      commitMessage: "fix: y",
    });
    const statusMap = new Map([["mt#700", "DONE"]]);
    const first = await runStaleSuspendedAskCloseSweep(repo, { taskStatusById: statusMap });
    expect(first.closedParentTerminal).toBe(1);
    const second = await runStaleSuspendedAskCloseSweep(repo, { taskStatusById: statusMap });
    expect(second.scanned).toBe(0);
    expect(second.closedParentTerminal).toBe(0);
  });
});
