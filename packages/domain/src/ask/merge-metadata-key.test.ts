/**
 * Tests for `mergeMetadataKey` (mt#4486) — the atomic single-key metadata merge.
 *
 * Generalized out of `recordCancellation` (mt#3353) when a second caller needed
 * the same shape: a credential request records its parent's entry status from a
 * read taken before the ask existed, and has to correct it from the block's own
 * authoritative read.
 *
 * **What is actually at stake here is the OTHER keys.** The whole reason this is
 * a key-scoped merge rather than a read-merge-`updateContent` sequence is that
 * the read-merge-write shape shipped first and was caught as BLOCKING (PR #3190
 * R1): it writes the whole `metadata` object back, so a concurrent edit landing
 * inside the window is silently lost. These run against `FakeAskRepository`,
 * whose in-memory merge mirrors the Drizzle jsonb `||` — so they pin the
 * CONTRACT (other keys survive, terminal rows are refused, a miss returns false
 * rather than throwing) rather than the SQL, which only a live database can
 * check.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import { CANCELLATION_METADATA_KEY } from "./edit";
import type { Ask } from "./types";

const AUTH_APPROVE: Ask["kind"] = "authorization.approve";

/**
 * The key these tests merge under. A realistic one — it is what the credential
 * request writes — but bound locally rather than imported, because what is under
 * test is the generic merge, not the credentials payload.
 */
const PAYLOAD_KEY = "credentialRequest";

async function seedRouted(repo: FakeAskRepository, metadata?: Record<string, unknown>) {
  const ask = await repo.create({
    kind: AUTH_APPROVE,
    classifierVersion: "v1",
    requestor: "test",
    title: "Add the Example credential",
    question: "Enter it?",
    ...(metadata ? { metadata } : {}),
  });
  await repo.transition(ask.id, "classified");
  return (await repo.transition(ask.id, "routed")).id;
}

describe("mergeMetadataKey", () => {
  let repo: FakeAskRepository;
  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("writes the key onto a row whose metadata is empty", async () => {
    const id = await seedRouted(repo);

    expect(await repo.mergeMetadataKey(id, PAYLOAD_KEY, { provider: "github" })).toBe(true);

    const after = await repo.getById(id);
    expect(after?.metadata?.[PAYLOAD_KEY]).toEqual({ provider: "github" });
  });

  it("leaves every OTHER key untouched", async () => {
    // The property the whole design exists for. A read-merge-write would pass
    // this test in isolation and still lose `unrelated` under concurrency; what
    // this pins is that the operation is scoped to one key by construction.
    const id = await seedRouted(repo, { unrelated: { keep: "me" }, alsoKeep: 7 });

    await repo.mergeMetadataKey(id, PAYLOAD_KEY, { provider: "github" });

    const after = await repo.getById(id);
    expect(after?.metadata?.unrelated).toEqual({ keep: "me" });
    expect(after?.metadata?.alsoKeep).toBe(7);
  });

  it("replaces the key wholesale rather than deep-merging it", async () => {
    // Documented behaviour, asserted so a later "helpful" deep merge is a test
    // failure: the correcting caller passes a payload rebuilt by the same
    // builder that wrote the original, which is only correct if the old value
    // is fully displaced.
    const id = await seedRouted(repo, {
      [PAYLOAD_KEY]: { provider: "github", parentEntryStatus: "PLANNING" },
    });

    await repo.mergeMetadataKey(id, PAYLOAD_KEY, {
      provider: "github",
      parentEntryStatus: "IN-PROGRESS",
    });

    expect((await repo.getById(id))?.metadata?.[PAYLOAD_KEY]).toEqual({
      provider: "github",
      parentEntryStatus: "IN-PROGRESS",
    });
  });

  it("refuses a TERMINAL row, and says so with false rather than a throw", async () => {
    const id = await seedRouted(repo);
    await repo.transition(id, "cancelled");

    expect(await repo.mergeMetadataKey(id, PAYLOAD_KEY, { provider: "github" })).toBe(false);
    expect((await repo.getById(id))?.metadata?.[PAYLOAD_KEY]).toBeUndefined();
  });

  it("returns false for a row that does not exist", async () => {
    // A provenance write must never fail the operation it rides on, so a miss
    // is a return value and not an exception.
    expect(await repo.mergeMetadataKey("00000000-0000-0000-0000-000000000000", "k", 1)).toBe(false);
  });

  it("still backs recordCancellation, which now delegates to it", async () => {
    // The delegation is the regression risk in this change: mt#3353's caller
    // must keep working unchanged.
    const id = await seedRouted(repo);

    expect(await repo.recordCancellation(id, { by: "operator", reason: "superseded" })).toBe(true);

    expect((await repo.getById(id))?.metadata?.[CANCELLATION_METADATA_KEY]).toEqual({
      by: "operator",
      reason: "superseded",
    });
  });
});
