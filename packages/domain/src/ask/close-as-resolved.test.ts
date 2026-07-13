/**
 * Tests for closeAskAsResolved (mt#2593) — the state-aware, idempotent, never-throws
 * Ask-closure primitive used by the commit-success and PR-merge emit sites.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import type { Ask, AskState } from "./types";
import { closeAskAsResolved, selectOpenReviewAsksForMergedPr } from "./close-as-resolved";

// Repeated literals extracted to satisfy custom/no-magic-string-duplication.
const COMMIT_LANDED = "system:commit-landed";
const PR_MERGED = "system:pr-merged";
const ALREADY_TERMINAL = "already-terminal";
const REVIEW_RESPONDER = "reviewer:service:bot";

/**
 * Seed an Ask into a specific lifecycle state by walking the state machine from
 * the `detected` state `create()` produces.
 *   - `cancelled` is reached in one hop from `detected` (off the linear path).
 *   - all others walk the linear detected -> classified -> routed -> suspended
 *     -> responded -> closed chain.
 */
async function seed(repo: FakeAskRepository, target: AskState): Promise<string> {
  let ask = await repo.create({
    kind: "authorization.approve",
    classifierVersion: "v1",
    requestor: "test",
    title: "Commit authorization: test",
    question: "Authorize?",
  });
  if (target === "cancelled") {
    await repo.transition(ask.id, "cancelled");
    return ask.id;
  }
  const linear: Partial<Record<AskState, AskState>> = {
    detected: "classified",
    classified: "routed",
    routed: "suspended",
    suspended: "responded",
    responded: "closed",
  };
  while (ask.state !== target) {
    const next = linear[ask.state];
    if (!next) throw new Error(`cannot walk to ${target} from ${ask.state}`);
    ask = await repo.transition(ask.id, next);
  }
  return ask.id;
}

describe("closeAskAsResolved", () => {
  let repo: FakeAskRepository;
  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("closes a suspended Ask to `closed` with the audit payload attached", async () => {
    const id = await seed(repo, "suspended");
    const outcome = await closeAskAsResolved(repo, id, {
      responder: COMMIT_LANDED,
      payload: { commitHash: "abc123" },
    });
    expect(outcome.kind).toBe("closed");
    const ask = await repo.getById(id);
    expect(ask?.state).toBe("closed");
    expect(ask?.response?.responder).toBe(COMMIT_LANDED);
    expect((ask?.response?.payload as { commitHash: string }).commitHash).toBe("abc123");
    // attentionCost is computed and written on the closed path.
    expect(ask?.response?.attentionCost).toBeDefined();
  });

  it("cancels a freshly-created (detected) Ask — `closed` is unreachable from detected", async () => {
    const id = await seed(repo, "detected");
    const outcome = await closeAskAsResolved(repo, id, { responder: COMMIT_LANDED });
    expect(outcome.kind).toBe("cancelled");
    const ask = await repo.getById(id);
    expect(ask?.state).toBe("cancelled");
  });

  it("cancels a classified Ask", async () => {
    const id = await seed(repo, "classified");
    const outcome = await closeAskAsResolved(repo, id, { responder: PR_MERGED });
    expect(outcome.kind).toBe("cancelled");
    expect((await repo.getById(id))?.state).toBe("cancelled");
  });

  it("cancels a routed Ask", async () => {
    const id = await seed(repo, "routed");
    const outcome = await closeAskAsResolved(repo, id, { responder: PR_MERGED });
    expect(outcome.kind).toBe("cancelled");
    expect((await repo.getById(id))?.state).toBe("cancelled");
  });

  it("is a no-op on an already-closed Ask (idempotent)", async () => {
    const id = await seed(repo, "closed");
    const outcome = await closeAskAsResolved(repo, id, { responder: COMMIT_LANDED });
    expect(outcome.kind).toBe(ALREADY_TERMINAL);
    expect((await repo.getById(id))?.state).toBe("closed");
  });

  it("is a no-op on an already-cancelled Ask (idempotent)", async () => {
    const id = await seed(repo, "cancelled");
    const outcome = await closeAskAsResolved(repo, id, { responder: COMMIT_LANDED });
    expect(outcome.kind).toBe(ALREADY_TERMINAL);
    expect((await repo.getById(id))?.state).toBe("cancelled");
  });

  it("re-running a close is idempotent (second call sees terminal)", async () => {
    const id = await seed(repo, "detected");
    const first = await closeAskAsResolved(repo, id, { responder: COMMIT_LANDED });
    expect(first.kind).toBe("cancelled");
    const second = await closeAskAsResolved(repo, id, { responder: COMMIT_LANDED });
    expect(second.kind).toBe(ALREADY_TERMINAL);
  });

  it("returns not-found for an unknown id (never throws)", async () => {
    const outcome = await closeAskAsResolved(repo, "does-not-exist", {
      responder: COMMIT_LANDED,
    });
    expect(outcome.kind).toBe("not-found");
  });

  it("closes a responded Ask to `closed` — `cancelled` is invalid from responded", async () => {
    const id = await seed(repo, "responded");
    const outcome = await closeAskAsResolved(repo, id, { responder: PR_MERGED });
    expect(outcome.kind).toBe("closed");
    expect((await repo.getById(id))?.state).toBe("closed");
  });

  it("closing a responded Ask preserves its existing response (e.g. a posted review)", async () => {
    // Reach `responded` via repo.respond (reconciler-style) so the Ask carries a
    // review response that must survive the merge-time close.
    let ask = await repo.create({
      kind: "quality.review",
      classifierVersion: "v1",
      requestor: "test",
      title: "Review PR",
      question: "Review?",
    });
    ask = await repo.transition(ask.id, "classified");
    ask = await repo.transition(ask.id, "routed");
    ask = await repo.transition(ask.id, "suspended");
    await repo.respond(ask.id, {
      response: {
        responder: REVIEW_RESPONDER,
        payload: { reviewId: 42 },
        attentionCost: { transport: "subagent", resolvedIn: "subagent" },
      },
    });
    const outcome = await closeAskAsResolved(repo, ask.id, { responder: PR_MERGED });
    expect(outcome.kind).toBe("closed");
    const closed = await repo.getById(ask.id);
    expect(closed?.state).toBe("closed");
    expect(closed?.response?.responder).toBe(REVIEW_RESPONDER);
  });
});

describe("selectOpenReviewAsksForMergedPr", () => {
  let repo: FakeAskRepository;
  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  async function reviewAsk(prNumber: number | null): Promise<Ask> {
    return repo.create({
      kind: "quality.review",
      classifierVersion: "v1",
      requestor: "test",
      title: prNumber != null ? `Review PR #${prNumber} before merge` : "Review before merge",
      question: "Review?",
      parentTaskId: "mt#100",
      contextRefs:
        prNumber != null
          ? [
              {
                kind: "github-pr",
                ref: `https://github.com/edobry/minsky/pull/${prNumber}`,
                description: `PR #${prNumber}`,
              },
            ]
          : [],
    });
  }

  it("selects a review Ask whose PR ref matches the merged PR number", async () => {
    const match = await reviewAsk(123);
    const selected = selectOpenReviewAsksForMergedPr([match], 123);
    expect(selected.map((a) => a.id)).toEqual([match.id]);
  });

  it("excludes a review Ask whose PR ref is for a different PR", async () => {
    const other = await reviewAsk(999);
    expect(selectOpenReviewAsksForMergedPr([other], 123)).toEqual([]);
  });

  it("includes a review Ask with no PR ref (same-task fallback)", async () => {
    const noRef = await reviewAsk(null);
    const selected = selectOpenReviewAsksForMergedPr([noRef], 123);
    expect(selected.map((a) => a.id)).toEqual([noRef.id]);
  });

  it("excludes a terminal review Ask", async () => {
    const closed = await reviewAsk(123);
    await repo.transition(closed.id, "cancelled");
    const terminal = (await repo.getById(closed.id)) as Ask;
    expect(selectOpenReviewAsksForMergedPr([terminal], 123)).toEqual([]);
  });

  it("excludes non-quality.review kinds", async () => {
    const authz = await repo.create({
      kind: "authorization.approve",
      classifierVersion: "v1",
      requestor: "test",
      title: "Commit authorization: x",
      question: "Authorize?",
      parentTaskId: "mt#100",
    });
    expect(selectOpenReviewAsksForMergedPr([authz], 123)).toEqual([]);
  });

  it("with an undefined merged PR number, includes no-ref asks but excludes ref-bearing ones", async () => {
    const withRef = await reviewAsk(123);
    const noRef = await reviewAsk(null);
    const selected = selectOpenReviewAsksForMergedPr([withRef, noRef], undefined);
    expect(selected.map((a) => a.id)).toEqual([noRef.id]);
  });
});
