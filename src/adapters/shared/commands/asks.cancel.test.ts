/**
 * Tests for `asks.cancel` (mt#3353) — the terminal transition for an Ask that
 * no transport ever dispatched.
 *
 * Before this command, `asks.respond` was the only terminal path and it rejects
 * every pre-suspended state ("only 'suspended' Asks can be responded to"), so
 * `detected`/`classified`/`routed` debris could not be retired in-band at all.
 * Neither sweep reaches those middle states either: `advancement.ts` reads
 * `listByState("detected")` and `stale-suspended-close.ts` reads
 * `listByState("suspended")`.
 *
 * Its own file rather than an addition to `asks.test.ts` because that file is at
 * the 1500-line cap, and the sibling suites (`asks.severity-page.test.ts`,
 * `asks.external-refs.test.ts`, …) already establish one-file-per-concern here.
 */

import { describe, expect, test } from "bun:test";

import { cancelAsk } from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";

/** Walk a fresh Ask to `routed` — the state this command exists for. */
async function seedRouted(repo: FakeAskRepository): Promise<string> {
  const ask = await repo.create({
    kind: "capability.escalate",
    classifierVersion: "v1",
    requestor: "test",
    title: "Stranded ask",
    question: "Do the thing?",
  });
  await repo.transition(ask.id, "classified");
  await repo.transition(ask.id, "routed");
  return ask.id;
}

describe("cancelAsk (mt#3353)", () => {
  test("cancels a routed Ask and reports the outcome", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    const result = await cancelAsk(repo, { id, reason: "premise falsified" });

    expect(result.outcome).toBe("cancelled");
    expect(result.askId).toBe(id);
    expect((await repo.getById(id))?.state).toBe("cancelled");
  });

  test("defaults the responder to a system identifier, never `operator`", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    const result = await cancelAsk(repo, { id, reason: "parent terminal" });

    // The whole point. `respondAndCloseAsk` defaults an omitted responder to
    // "operator" (`repository.ts`), which records the PRINCIPAL as having
    // decided. With no cancel verb, the live practice became retiring an ask by
    // ANSWERING it as its own author — so the absence of this command laundered
    // agent withdrawals into the principal's answered record (mem#1122,
    // mem#1007). A cancel path inheriting that default would reproduce exactly
    // the defect it exists to remove.
    expect(result.responder).not.toBe("operator");
    expect(result.responder).toBe("system:agent-cancelled");
  });

  test("passes a caller-supplied non-`system:` responder through unchanged", async () => {
    // PR #3190 R1 (non-blocking) read the assertion above as claiming the command
    // NORMALIZES responders to a `system:` prefix. It does not, and should not:
    // `CloseAsResolvedInput` documents that an unrecognised-prefix responder maps
    // to the `subagent` attention transport, so an agent id is a legitimate
    // value. The only rule is that `operator` is refused; everything else is the
    // caller's to name. Pinned here so the guarantee is stated rather than
    // implied by a default that happens to start with `system:`.
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    const result = await cancelAsk(repo, {
      id,
      reason: "superseded",
      responder: "minsky.agent:cockpit",
    });

    expect(result.responder).toBe("minsky.agent:cockpit");
    expect(result.outcome).toBe("cancelled");
  });

  test("REJECTS an explicit `operator` responder rather than rewriting it", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    await expect(
      cancelAsk(repo, { id, reason: "withdrawn", responder: "operator" })
    ).rejects.toThrow(/may not be "operator"/);

    // And the Ask is left alone — a rejected cancel must not half-apply.
    expect((await repo.getById(id))?.state).toBe("routed");
  });

  test("rejects `operator` case-insensitively and after trimming", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    await expect(
      cancelAsk(repo, { id, reason: "withdrawn", responder: "  Operator  " })
    ).rejects.toThrow(/may not be "operator"/);
  });

  test("records the reason as the disposition, alongside the responder", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    await cancelAsk(repo, {
      id,
      reason: "deploy verified 2026-08-19; premise dead",
      responder: "system:sweep",
    });

    const metadata = (await repo.getById(id))?.metadata as Record<string, unknown> | undefined;
    const record = metadata?.cancellation as Record<string, unknown> | undefined;
    expect(record?.responder).toBe("system:sweep");
    expect(record?.fromState).toBe("routed");
    expect((record?.payload as Record<string, unknown> | undefined)?.reason).toBe(
      "deploy verified 2026-08-19; premise dead"
    );
  });

  test("is idempotent — re-cancelling an already-terminal Ask is a no-op", async () => {
    const repo = new FakeAskRepository();
    const id = await seedRouted(repo);

    await cancelAsk(repo, { id, reason: "first" });
    const second = await cancelAsk(repo, { id, reason: "second" });

    expect(second.outcome).toBe("already-terminal");
    expect((await repo.getById(id))?.state).toBe("cancelled");
  });

  test("reports `not-found` for an unknown id instead of throwing", async () => {
    const repo = new FakeAskRepository();

    const result = await cancelAsk(repo, {
      id: "00000000-0000-4000-8000-000000000000",
      reason: "nothing here",
    });

    expect(result.outcome).toBe("not-found");
  });
});
