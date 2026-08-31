import { describe, expect, test } from "bun:test";

import {
  applyUpdateAssociationsSemantics,
  buildAssociationsUpdate,
  classifyRecord,
  correctedRefs,
  planToken,
  sameRefs,
  type PlanEntry,
} from "./rederive-memory-associations";

/**
 * Fixtures are VERBATIM from the two live records that motivated mt#4765, not paraphrases.
 * Both are `quoted-only`: each names a task inside a markdown code span while DISCUSSING the
 * extractor's behaviour, and the shipped write path minted a permanent association from it.
 */
const MEM_1340_FIRING_LINE = "- `Retire when mt#1541 ships.` → HIT";
const MEM_1340_PROSE = [
  "- **mem#386** (`eba0d69d`) — `## Budget`'s second retirement condition named an extension to a",
  "  DELETED detector (mt#1541 CLOSED, deleted by mt#4197); replacement condition written.",
].join("\n");
const MEM_1208_FIRING_SENTENCE =
  "mem#484 matched `retire when mt#2056 ships` — a sentence in which mem#484 **quotes a " +
  "different memory's** budget criterion while narrating an incident.";

describe("classifyRecord — discrimination control (mt#4765 AT2, AT3)", () => {
  test("mem#1340's firing line classifies quoted-only, not grounded", () => {
    const c = classifyRecord({
      storedRefs: ["mt#1541"],
      content: `${MEM_1340_FIRING_LINE}\n${MEM_1340_PROSE}`,
    });
    expect(c.refs).toEqual([{ ref: "mt#1541", verdict: "quoted-only" }]);
  });

  test("mem#1340's ordinary prose mention alone yields no ref at all", () => {
    // The bare prose naming mt#1541 is not a retirement clause in any pattern, quoted or not.
    const c = classifyRecord({ storedRefs: ["mt#1541"], content: MEM_1340_PROSE });
    expect(c.refs).toEqual([{ ref: "mt#1541", verdict: "not-derivable" }]);
  });

  test("a genuine unquoted retirement clause classifies grounded — the opposite verdict", () => {
    const c = classifyRecord({
      storedRefs: ["mt#4321"],
      content: "## Budget\n\nRetire when mt#4321 ships.",
    });
    expect(c.refs).toEqual([{ ref: "mt#4321", verdict: "grounded" }]);
  });

  test("one record, one true ref and one quoted ref, judged independently (mem#1208 shape)", () => {
    const c = classifyRecord({
      storedRefs: ["mt#2056", "mt#4454"],
      content: `${MEM_1208_FIRING_SENTENCE}\n\nBudget: retire when mt#4454 ships.`,
    });
    expect(c.refs).toEqual([
      { ref: "mt#2056", verdict: "quoted-only" },
      { ref: "mt#4454", verdict: "grounded" },
    ]);
    expect(correctedRefs(c)).toEqual(["mt#4454"]);
  });

  test("the description is scanned too, matching the read path's haystack", () => {
    const c = classifyRecord({
      storedRefs: ["mt#1709"],
      content: "body with no clause",
      description: "Tracking: mt#1709",
    });
    expect(c.refs).toEqual([{ ref: "mt#1709", verdict: "grounded" }]);
  });

  test("reports a grounded ref the record does not store (recall gap)", () => {
    const c = classifyRecord({
      storedRefs: [],
      content: "Retire when mt#5555 ships.",
    });
    expect(c.unstoredGrounded).toEqual(["mt#5555"]);
  });
});

describe("correctedRefs", () => {
  test("drops only quoted-only refs; not-derivable is preserved", () => {
    // not-derivable is ambiguous by construction — a stored ref may be an author DECLARATION,
    // which is byte-identical to a derived one. Dropping it would delete real associations.
    const c = classifyRecord({
      storedRefs: ["mt#2056", "mt#9998"],
      content: `${MEM_1208_FIRING_SENTENCE}\n\nnothing about mt#9998 here`,
    });
    expect(c.refs.map((r) => r.verdict)).toEqual(["quoted-only", "not-derivable"]);
    expect(correctedRefs(c)).toEqual(["mt#9998"]);
  });
});

/**
 * mt#4796. The first live corrective run reported "Applied: 9" and changed 4 records: every
 * correction that emptied `tracksTask` was a silent no-op, because the script DELETED the key and
 * `MemoryService.update` merges rather than replaces.
 *
 * These run the payload through the service's REAL semantics. A fake that just assigned the
 * payload would pass with the bug present, which is the whole reason
 * `applyUpdateAssociationsSemantics` mirrors `memory-service.ts:935-944` instead of stubbing it.
 */
describe("buildAssociationsUpdate — removal against update()'s merge semantics", () => {
  test("emptying the ref list REMOVES the key from the stored map", () => {
    const stored = { tracksTask: ["mt#1541"] };
    const result = applyUpdateAssociationsSemantics(stored, buildAssociationsUpdate([]));
    expect(result.tracksTask).toBeUndefined();
  });

  test("deleting the key instead would be a silent no-op — the shipped bug", () => {
    // The pre-fix payload: key absent entirely. Reaches neither the merge nor the removal branch.
    const stored = { tracksTask: ["mt#1541"] };
    const buggyPayload: Record<string, string[]> = {};
    const result = applyUpdateAssociationsSemantics(stored, buggyPayload);
    expect(result.tracksTask).toEqual(["mt#1541"]);
  });

  test("dropping one ref while keeping another writes the remaining list", () => {
    const stored = { tracksTask: ["mt#2056", "mt#4454"] };
    const result = applyUpdateAssociationsSemantics(stored, buildAssociationsUpdate(["mt#4454"]));
    expect(result.tracksTask).toEqual(["mt#4454"]);
  });

  test("association types this task does not touch survive the correction", () => {
    const stored = { tracksTask: ["mt#2056"], relatedTask: ["mt#1709", "mt#4386"] };
    const result = applyUpdateAssociationsSemantics(stored, buildAssociationsUpdate([]));
    expect(result.tracksTask).toBeUndefined();
    expect(result.relatedTask).toEqual(["mt#1709", "mt#4386"]);
  });

  test("the payload names ONLY tracksTask, so a concurrent write cannot be clobbered", () => {
    // PR #3505 R1. Re-sending other keys with their scan-time values would overwrite whatever a
    // concurrent writer put there. The merge already preserves them, so the minimal payload is
    // both sufficient and safer.
    expect(Object.keys(buildAssociationsUpdate(["mt#1"]))).toEqual(["tracksTask"]);
    expect(Object.keys(buildAssociationsUpdate([]))).toEqual(["tracksTask"]);
  });

  test("a key changed concurrently between scan and write survives", () => {
    // Stored state at WRITE time carries a relatedTask the scan never saw.
    const storedAtWriteTime = { tracksTask: ["mt#2056"], relatedTask: ["mt#9999"] };
    const result = applyUpdateAssociationsSemantics(storedAtWriteTime, buildAssociationsUpdate([]));
    expect(result.relatedTask).toEqual(["mt#9999"]);
  });
});

describe("sameRefs — set comparison, not sequence comparison", () => {
  test("ignores order", () => {
    expect(sameRefs(["mt#2", "mt#1"], ["mt#1", "mt#2"])).toBe(true);
  });

  test("still distinguishes different contents and lengths", () => {
    expect(sameRefs(["mt#1"], ["mt#2"])).toBe(false);
    expect(sameRefs(["mt#1"], ["mt#1", "mt#2"])).toBe(false);
    expect(sameRefs([], ["mt#1"])).toBe(false);
  });

  test("two empty lists match", () => {
    expect(sameRefs([], [])).toBe(true);
  });

  test("does not mutate its arguments", () => {
    const a = ["mt#2", "mt#1"];
    sameRefs(a, ["mt#1", "mt#2"]);
    expect(a).toEqual(["mt#2", "mt#1"]);
  });
});

describe("planToken", () => {
  const entry: PlanEntry = {
    id: "a",
    shortId: "mem#1",
    name: "n",
    before: ["mt#1", "mt#2"],
    after: ["mt#2"],
    dropped: ["mt#1"],
  };

  test("is stable across entry ordering", () => {
    const other: PlanEntry = { ...entry, id: "b", shortId: "mem#2" };
    expect(planToken([entry, other])).toBe(planToken([other, entry]));
  });

  test("changes when the change set changes", () => {
    expect(planToken([entry])).not.toBe(planToken([{ ...entry, after: [] }]));
  });

  test("an empty plan has a stable token", () => {
    expect(planToken([])).toBe(planToken([]));
  });
});
