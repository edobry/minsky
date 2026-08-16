/**
 * Tests for the peek URL codec (mt#3694).
 *
 * The codec is the whole URL contract for the side peek, so these cover both
 * halves: the wire format (round-trips, the `#`-in-task-id case, held markers,
 * untrusted input) and the pane-list ALGEBRA that encodes the settled
 * interaction model — ordinary open replaces, a held pane survives.
 */
import { describe, test, expect } from "bun:test";
import {
  encodePeekPanes,
  decodePeekPanes,
  openPane,
  holdPane,
  closePane,
  samePane,
  MAX_DECODED_PANES,
  type PeekPane,
} from "./peek-codec";

const TASK: PeekPane = { type: "task", id: "mt#3694", held: false };
const MEMORY: PeekPane = {
  type: "memory",
  id: "fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a",
  held: false,
};
const ASK: PeekPane = { type: "ask", id: "0a1b2c3d-0000-0000-0000-000000000000", held: false };

describe("peek-codec wire format", () => {
  test("no panes encode to null, so the param is deleted rather than left empty", () => {
    expect(encodePeekPanes([])).toBeNull();
  });

  test("round-trips a task id containing '#'", () => {
    const encoded = encodePeekPanes([TASK]);
    expect(encoded).toBe("task:mt%233694");
    expect(decodePeekPanes(encoded)).toEqual([TASK]);
  });

  test("round-trips an ordered multi-pane list, preserving order and hold flags", () => {
    const panes = [{ ...TASK, held: true }, MEMORY];
    const encoded = encodePeekPanes(panes);
    expect(encoded).toBe(`*task:mt%233694,memory:${MEMORY.id}`);
    expect(decodePeekPanes(encoded)).toEqual(panes);
  });

  test("decodes empty / absent input to no panes", () => {
    expect(decodePeekPanes(null)).toEqual([]);
    expect(decodePeekPanes(undefined)).toEqual([]);
    expect(decodePeekPanes("")).toEqual([]);
  });
});

describe("peek-codec treats the URL as untrusted", () => {
  test("drops an unknown entity type but keeps the valid panes around it", () => {
    expect(decodePeekPanes(`task:mt%233694,wormhole:xyz,memory:${MEMORY.id}`)).toEqual([
      TASK,
      MEMORY,
    ]);
  });

  test("drops a pane with no type separator", () => {
    expect(decodePeekPanes("task:mt%233694,garbage")).toEqual([TASK]);
  });

  test("drops a pane with an empty id", () => {
    expect(decodePeekPanes("task:mt%233694,memory:")).toEqual([TASK]);
  });

  test("drops a pane whose id is a malformed percent-escape rather than throwing", () => {
    expect(() => decodePeekPanes("memory:%zz")).not.toThrow();
    expect(decodePeekPanes("task:mt%233694,memory:%zz")).toEqual([TASK]);
  });

  test("collapses a duplicated entity to one pane", () => {
    expect(decodePeekPanes("task:mt%233694,task:mt%233694")).toEqual([TASK]);
  });

  test("bounds pane count so a hand-crafted URL cannot mount unboundedly many", () => {
    const many = Array.from({ length: MAX_DECODED_PANES + 5 }, (_, i) => `task:mt%23${i}`).join(
      ","
    );
    expect(decodePeekPanes(many)).toHaveLength(MAX_DECODED_PANES);
  });
});

describe("openPane — the default click REPLACES", () => {
  test("opening into an empty assembly adds the first pane", () => {
    expect(openPane([], { type: "task", id: "mt#3694" })).toEqual([TASK]);
  });

  test("replaces the last pane when it is not held", () => {
    expect(openPane([TASK], { type: "memory", id: MEMORY.id })).toEqual([MEMORY]);
  });

  test("appends beside a HELD pane instead of replacing it", () => {
    const held = { ...TASK, held: true };
    expect(openPane([held], { type: "memory", id: MEMORY.id })).toEqual([held, MEMORY]);
  });

  test("replaces only the last pane, leaving held panes before it untouched", () => {
    const held = { ...TASK, held: true };
    expect(openPane([held, MEMORY], { type: "ask", id: ASK.id })).toEqual([held, ASK]);
  });

  test("re-opening an entity already on screen does not mount a second copy", () => {
    const held = { ...TASK, held: true };
    expect(openPane([held, MEMORY], { type: "task", id: "mt#3694" })).toEqual([held]);
  });
});

describe("holdPane / closePane", () => {
  test("holding marks exactly the addressed pane", () => {
    expect(holdPane([TASK, MEMORY], 0)).toEqual([{ ...TASK, held: true }, MEMORY]);
  });

  test("holding an out-of-range index is a no-op", () => {
    expect(holdPane([TASK], 5)).toEqual([TASK]);
  });

  test("closing defaults to the last pane", () => {
    expect(closePane([TASK, MEMORY])).toEqual([TASK]);
  });

  test("closing the only pane empties the assembly", () => {
    expect(closePane([TASK])).toEqual([]);
  });

  test("closing RELEASES the new last pane, so the next open replaces rather than appends", () => {
    // Without the release, a held pane left in the last slot would make the
    // next ordinary click append — an accumulating stack by accident.
    const assembly = [{ ...TASK, held: true }, MEMORY];
    const afterClose = closePane(assembly, 1);
    expect(afterClose).toEqual([TASK]);
    expect(openPane(afterClose, { type: "ask", id: ASK.id })).toEqual([ASK]);
  });

  test("closing an out-of-range index is a no-op", () => {
    expect(closePane([TASK], 9)).toEqual([TASK]);
  });
});

describe("samePane", () => {
  test("matches on type and id, ignoring hold state", () => {
    const heldTask: PeekPane = { ...TASK, held: true };
    expect(samePane(TASK, heldTask)).toBe(true);
    expect(samePane(TASK, MEMORY)).toBe(false);
    expect(samePane({ type: "task", id: "x" }, { type: "memory", id: "x" })).toBe(false);
  });
});
