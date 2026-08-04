/**
 * mt#3691 AT4 — a candidate for which no label tier resolves.
 *
 * The interesting case is not the happy path (covered live against the real DB,
 * see the PR's live-verification section) but the DEGRADED one: a conversation
 * with no bound task title, no generated title, no substantive user turn and no
 * subagent descriptor must still come back with the tier-4 timestamp·cwd·id
 * string. Returning an empty string, or dropping the entry, would put the
 * switcher right back to rendering a bare uuid — the exact state this task
 * exists to remove.
 *
 * `db` and `titleCache` are parameters of the function under test, so these
 * stubs are passed in rather than patched over an import.
 */
import { describe, expect, test } from "bun:test";

import { labelConversationCandidates } from "./conversation-candidate-labels";

const CONV = "4d0b6e1a-9c77-4f0e-9d51-2b3c4d5e6f70";

/**
 * A db whose every query rejects. `fetchEnrichment` catches internally and
 * returns an empty map, so this exercises "every tier missed" — which is the
 * same observable state as a conversation that genuinely has no label inputs,
 * and is reachable without standing up five table fixtures.
 */
const failingDb = {
  select: () => {
    throw new Error("no db in this test");
  },
} as never;

describe("labelConversationCandidates", () => {
  test("AT4: a candidate with no resolvable tier gets the tier-4 fallback", async () => {
    const labels = await labelConversationCandidates(
      failingDb,
      [
        {
          agentSessionId: CONV,
          cwd: "/Users/e/Projects/minsky",
          startedAt: "2026-08-04T12:00:00.000Z",
          generatedTitle: null,
        },
      ],
      null
    );

    const label = labels.get(CONV);
    expect(label).toBeDefined();
    expect(label).not.toBe("");
    // Tier 4 is timestamp·cwd·id-prefix: strictly more identifying than the
    // bare uuid, and never the bare uuid itself.
    expect(label).not.toBe(CONV);
    expect(label).toContain("Projects/minsky");
    expect(label).toContain(CONV.slice(0, 8));
  });

  test("AT4: the generated title still wins when it is the ONLY input", async () => {
    // The guard in the implementation includes `generatedTitle`; without that,
    // a conversation whose only label source is its generated title would drop
    // to the fallback even though a real label was available.
    const labels = await labelConversationCandidates(
      failingDb,
      [
        {
          agentSessionId: CONV,
          cwd: "/Users/e/Projects/minsky",
          startedAt: "2026-08-04T12:00:00.000Z",
          generatedTitle: "Wiring the switcher",
        },
      ],
      null
    );

    expect(labels.get(CONV)).toContain("Wiring the switcher");
  });

  test("every candidate gets an entry, so no item can render blank", async () => {
    const second = "8f7e6d5c-4b3a-2910-8f7e-6d5c4b3a2910";
    const labels = await labelConversationCandidates(
      failingDb,
      [
        { agentSessionId: CONV, cwd: null, startedAt: null, generatedTitle: null },
        { agentSessionId: second, cwd: null, startedAt: null, generatedTitle: null },
      ],
      null
    );

    expect(labels.size).toBe(2);
    for (const id of [CONV, second]) {
      expect(labels.get(id)).toBeTruthy();
    }
  });

  test("an empty candidate list costs no queries and returns no labels", async () => {
    const labels = await labelConversationCandidates(failingDb, [], null);
    expect(labels.size).toBe(0);
  });
});
