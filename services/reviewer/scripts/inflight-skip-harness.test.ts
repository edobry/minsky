/**
 * Tests for the L4 harness's decision core (mt#4895; fixes from PR #3566 R1).
 *
 * The smoke script itself cannot run without live App credentials and a real PR,
 * so everything it DECIDES lives in `inflight-skip-harness.ts` and is covered
 * here. Two of these are regression tests for R1's blocking findings:
 *
 *  - `collectStdoutLines` returning a completion promise (R1-1). The original
 *    returned only the array, so the script parsed it while the background
 *    reader was still draining and could miss the trailing line — which is
 *    exactly where a terminal event lands.
 *  - `deriveVerdict` being a pure function over observations, which is what
 *    let the script's failure paths become throws instead of `process.exit`
 *    calls that skipped cleanup (R1-2).
 */

import { describe, test, expect } from "bun:test";
import { collectStdoutLines, findEvents, deriveVerdict } from "./inflight-skip-harness";

const encoder = new TextEncoder();

/** A stream that emits `chunks` in order, one per microtask turn, then closes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      // Yield so the chunk genuinely arrives after the caller has had a chance
      // to look at `lines` — that is the race being reproduced.
      await new Promise((resolve) => setTimeout(resolve, 1));
      controller.enqueue(encoder.encode(chunks[i] as string));
      i += 1;
    },
  });
}

describe("collectStdoutLines", () => {
  test("R1-1 regression: lines are INCOMPLETE before `done` resolves and COMPLETE after", async () => {
    const { lines, done } = collectStdoutLines(
      streamOf(['{"event":"first"}\n', '{"event":"runReview.skipped_concurrent_inflight"}\n'])
    );

    // This is the old behaviour's failure mode: the script killed the process
    // and read `lines` here. Nothing has been drained yet.
    expect(lines).toHaveLength(0);

    await done;

    // With the completion promise awaited, the trailing event is present — and
    // it is the one the verdict depends on.
    expect(lines).toHaveLength(2);
    expect(findEvents(lines, "runReview.skipped_concurrent_inflight")).toHaveLength(1);
  });

  test("flushes a trailing segment that never got a newline", async () => {
    const { lines, done } = collectStdoutLines(streamOf(['{"event":"a"}\n', '{"event":"b"}']));
    await done;
    expect(lines).toHaveLength(2);
    expect(findEvents(lines, "b")).toHaveLength(1);
  });

  test("reassembles a JSON object split across chunk boundaries", async () => {
    const { lines, done } = collectStdoutLines(streamOf(['{"event":"sp', 'lit"}\n']));
    await done;
    expect(lines).toEqual(['{"event":"split"}']);
  });

  test("a null stream yields no lines and an already-resolved done", async () => {
    const { lines, done } = collectStdoutLines(null);
    await done;
    expect(lines).toHaveLength(0);
  });
});

describe("findEvents", () => {
  test("returns only objects whose event matches, in order", () => {
    const lines = [
      '{"event":"x","n":1}',
      "not json at all",
      '{"event":"y"}',
      '{"event":"x","n":2}',
    ];
    const found = findEvents(lines, "x");
    expect(found).toHaveLength(2);
    expect(found[0]?.["n"]).toBe(1);
    expect(found[1]?.["n"]).toBe(2);
  });

  test("non-JSON banner lines are skipped rather than throwing", () => {
    expect(() => findEvents(["$ bun run server.ts", "listening on 34601"], "x")).not.toThrow();
    expect(findEvents(["listening"], "x")).toHaveLength(0);
  });
});

describe("deriveVerdict — contention mode", () => {
  const base = {
    mode: "contention" as const,
    skipForB: true,
    skipForA: false,
    publishFailed: false,
    checkRunConclusion: "skipped" as string | null,
  };

  test("passes when B skipped, A did not, and a conclusion was read back", () => {
    const v = deriveVerdict(base);
    expect(v.pass).toBe(true);
    expect(v.skipCheckRunAttempted).toBe(true);
    expect(v.reason).toContain("conclusion: skipped");
  });

  test("a FAILED publish still counts as ATTEMPTED — that is the SC3 contract", () => {
    const v = deriveVerdict({ ...base, checkRunConclusion: null, publishFailed: true });
    expect(v.pass).toBe(true);
    expect(v.skipCheckRunAttempted).toBe(true);
    expect(v.reason).toContain("publish failed");
  });

  test("fails when neither publish signal is present — the skip never surfaced", () => {
    const v = deriveVerdict({ ...base, checkRunConclusion: null, publishFailed: false });
    expect(v.pass).toBe(false);
    expect(v.skipCheckRunAttempted).toBe(false);
  });

  test("fails when B did not skip at all", () => {
    expect(deriveVerdict({ ...base, skipForB: false }).pass).toBe(false);
  });

  test("fails when A ALSO skipped — A holds the marker, so a skip on A means something else took it", () => {
    expect(deriveVerdict({ ...base, skipForA: true }).pass).toBe(false);
  });
});

describe("deriveVerdict — negative-control mode", () => {
  const base = {
    mode: "negative-control" as const,
    skipForB: false,
    skipForA: false,
    publishFailed: false,
    checkRunConclusion: null,
  };

  test("passes when no skip is observed, which is the whole point of the control", () => {
    const v = deriveVerdict(base);
    expect(v.pass).toBe(true);
    expect(v.reason).toContain("did NOT skip");
  });

  test("FAILS when a skip is still observed — the harness cannot discriminate", () => {
    const v = deriveVerdict({ ...base, skipForB: true });
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("unconditional skip");
  });

  test("the publish question is N/A here, not false", () => {
    // A `false` would read as "the publish was not attempted", which is a
    // finding. In the control no skip is expected, so nothing should have been
    // published and the question does not apply.
    expect(deriveVerdict(base).skipCheckRunAttempted).toBeNull();
  });
});
