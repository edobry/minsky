/**
 * Tests for `pollForMergeableStatus` and the `mergePullRequest` mergeability
 * trichotomy (mt#2890).
 *
 * Root cause: GitHub computes PR mergeability asynchronously. While the
 * background test-merge is in flight (or the API is degraded), `mergeable`
 * is `null` -- not `false`. The pre-mt#2890 code treated `!pr.mergeable` as
 * "has a conflict", so a transient `null` was mislabeled as a real merge
 * conflict during a GitHub API degradation window (PR #1988 incident).
 *
 * `pollForMergeableStatus` is exported specifically so this trichotomy is
 * testable without mocking `@octokit/rest` -- it takes a `fetchPr` callback
 * instead of an Octokit instance.
 */

import { describe, test, expect } from "bun:test";
import { pollForMergeableStatus, MERGEABILITY_POLL_DELAYS_MS } from "./github-pr-operations";

// A no-op sleep so tests don't actually wait ~15s.
const NO_WAIT = async (_ms: number): Promise<void> => {};

describe("pollForMergeableStatus", () => {
  test("returns immediately when mergeable is already non-null (true)", async () => {
    let fetchCount = 0;
    const initialPr = { mergeable: true as boolean | null };
    const result = await pollForMergeableStatus(
      async () => {
        fetchCount++;
        return { mergeable: true as boolean | null };
      },
      initialPr,
      { sleepFn: NO_WAIT }
    );
    expect(result.mergeable).toBe(true);
    expect(fetchCount).toBe(0); // never needed to re-fetch
  });

  test("returns immediately when mergeable is already non-null (false)", async () => {
    let fetchCount = 0;
    const initialPr = { mergeable: false as boolean | null };
    const result = await pollForMergeableStatus(
      async () => {
        fetchCount++;
        return { mergeable: false as boolean | null };
      },
      initialPr,
      { sleepFn: NO_WAIT }
    );
    expect(result.mergeable).toBe(false);
    expect(fetchCount).toBe(0);
  });

  test("null then true on re-poll resolves to true (merge proceeds)", async () => {
    const responses: Array<boolean | null> = [true];
    let fetchCount = 0;
    const result = await pollForMergeableStatus(
      async () => {
        fetchCount++;
        return { mergeable: responses.shift() ?? null };
      },
      { mergeable: null },
      { sleepFn: NO_WAIT }
    );
    expect(result.mergeable).toBe(true);
    expect(fetchCount).toBe(1); // resolved on the first re-poll
  });

  test("null then false on re-poll resolves to false (real conflict)", async () => {
    const responses: Array<boolean | null> = [false];
    const result = await pollForMergeableStatus(
      async () => ({ mergeable: responses.shift() ?? null }),
      { mergeable: null },
      { sleepFn: NO_WAIT }
    );
    expect(result.mergeable).toBe(false);
  });

  test("null exhausting the poll budget returns still-null (caller throws distinct error)", async () => {
    let fetchCount = 0;
    const result = await pollForMergeableStatus(
      async () => {
        fetchCount++;
        return { mergeable: null as boolean | null };
      },
      { mergeable: null },
      { sleepFn: NO_WAIT }
    );
    expect(result.mergeable).toBeNull();
    // One fetch per configured delay -- default budget is 3 retries.
    expect(fetchCount).toBe(MERGEABILITY_POLL_DELAYS_MS.length);
  });

  test("honors a custom delaysMs budget (fewer/more attempts)", async () => {
    let fetchCount = 0;
    const result = await pollForMergeableStatus(
      async () => {
        fetchCount++;
        return { mergeable: null as boolean | null };
      },
      { mergeable: null },
      { sleepFn: NO_WAIT, delaysMs: [10, 20] }
    );
    expect(result.mergeable).toBeNull();
    expect(fetchCount).toBe(2);
  });

  test("sleeps between each retry using the configured delays", async () => {
    const sleptMs: number[] = [];
    const responses: Array<boolean | null> = [null, true];
    await pollForMergeableStatus(
      async () => ({ mergeable: responses.shift() ?? null }),
      { mergeable: null },
      {
        sleepFn: async (ms: number) => {
          sleptMs.push(ms);
        },
        delaysMs: [100, 200, 300],
      }
    );
    // Resolved on the second re-poll (after 2 sleeps).
    expect(sleptMs).toEqual([100, 200]);
  });
});
