/**
 * Tests for the pure query-parsing helper backing GET /api/tasks/meta
 * (mt#3174). The route itself calls `getServerTaskService()` directly (no DI
 * seam, matching the existing untested-at-this-layer convention for
 * /api/tasks/ids and /api/tasks/:id in this file — no routes/tasks.test.ts
 * predates this one) and `mock.module` is banned in this codebase (see
 * `shared-persistence.test.ts`, `events-broker-init.test.ts`), so the
 * ids-parsing logic is extracted into a pure, directly-testable function
 * instead. Data-layer correctness (the actual label resolution) is covered
 * by `../task-title-cache.test.ts`'s `getTaskMeta` suite.
 */
import { describe, test, expect } from "bun:test";
import { parseTaskMetaIds, selectLiveDrivenSession } from "./tasks";

describe("parseTaskMetaIds", () => {
  test("splits a comma-separated ids param", () => {
    expect(parseTaskMetaIds("mt%231,mt%232")).toEqual(["mt#1", "mt#2"]);
  });

  test("trims whitespace around segments", () => {
    expect(parseTaskMetaIds("mt%231, mt%232 ")).toEqual(["mt#1", "mt#2"]);
  });

  test("drops empty segments (trailing/leading/double commas)", () => {
    expect(parseTaskMetaIds(",mt%231,,mt%232,")).toEqual(["mt#1", "mt#2"]);
  });

  test("a single id with no comma", () => {
    expect(parseTaskMetaIds("mt%231")).toEqual(["mt#1"]);
  });

  test("missing param → empty array", () => {
    expect(parseTaskMetaIds(undefined)).toEqual([]);
  });

  test("empty string param → empty array", () => {
    expect(parseTaskMetaIds("")).toEqual([]);
  });

  test("non-string param (e.g. an array, from a malformed request) → empty array", () => {
    expect(parseTaskMetaIds(["mt#1", "mt#2"])).toEqual([]);
  });

  test("malformed percent-encoding in a segment degrades that segment to dropped, not a thrown error", () => {
    expect(parseTaskMetaIds("mt%231,%E0%A4%A")).toEqual(["mt#1"]);
  });
});

/**
 * mt#3400 — the rules deciding whether a task page offers a one-hop return to
 * a live driven session.
 *
 * Stand-in collaborators keep these tests about the RULES: `normalize` models
 * the display-form canonicalization the route passes `formatTaskIdForDisplay`
 * for, and `isTerminal` mirrors `isTerminalStatus`'s real membership
 * (exited/crashed/unrecoverable) rather than re-importing the host module.
 */
describe("selectLiveDrivenSession (mt#3400)", () => {
  type Rec = {
    localId: string;
    taskId: string | null;
    status: "spawned" | "running" | "reconnecting" | "exited" | "crashed" | "unrecoverable";
    startedAt: string;
  };

  const normalize = (id: string) =>
    id
      .trim()
      .toLowerCase()
      .replace(/^task#/, "mt#");
  const isTerminal = (s: Rec["status"]) =>
    s === "exited" || s === "crashed" || s === "unrecoverable";

  const rec = (over: Partial<Rec> & Pick<Rec, "localId">): Rec => ({
    taskId: "mt#3400",
    status: "running",
    startedAt: "2026-07-30T10:00:00.000Z",
    ...over,
  });

  test("returns the live session bound to the task", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-1" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-1");
  });

  test("no records → null", () => {
    expect(selectLiveDrivenSession([], "mt#3400", normalize, isTerminal)).toBeNull();
  });

  test("a session bound to a DIFFERENT task is never returned", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-other", taskId: "mt#9999" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found).toBeNull();
  });

  test("an untasked scratch session (null taskId) is never returned", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-scratch", taskId: null })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found).toBeNull();
  });

  test.each([["exited"], ["crashed"], ["unrecoverable"]] as const)(
    "a %s session never hijacks the action",
    (status) => {
      const found = selectLiveDrivenSession(
        [rec({ localId: "ds-done", status })],
        "mt#3400",
        normalize,
        isTerminal
      );
      expect(found).toBeNull();
    }
  );

  // The originating incident's exact state: the daemon restarted, so the record
  // was rebuilt as a "reconnecting" placeholder. It IS reachable — attaching
  // resumes it — so excluding it would reintroduce the reported bug.
  test.each([["spawned"], ["running"], ["reconnecting"]] as const)(
    "a %s session qualifies as returnable",
    (status) => {
      const found = selectLiveDrivenSession(
        [rec({ localId: "ds-live", status })],
        "mt#3400",
        normalize,
        isTerminal
      );
      expect(found?.localId).toBe("ds-live");
    }
  );

  test("ids are compared through normalize, so a display-form difference still matches", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-1", taskId: "TASK#3400" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-1");
  });

  test("newest-started wins when a task has been driven more than once", () => {
    const found = selectLiveDrivenSession(
      [
        rec({ localId: "ds-old", startedAt: "2026-07-30T09:00:00.000Z" }),
        rec({ localId: "ds-new", startedAt: "2026-07-30T18:00:00.000Z" }),
        rec({ localId: "ds-mid", startedAt: "2026-07-30T12:00:00.000Z" }),
      ],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-new");
  });

  test("a newer TERMINAL session does not shadow an older live one", () => {
    const found = selectLiveDrivenSession(
      [
        rec({ localId: "ds-live", startedAt: "2026-07-30T09:00:00.000Z" }),
        rec({ localId: "ds-dead", status: "exited", startedAt: "2026-07-30T18:00:00.000Z" }),
      ],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-live");
  });

  // PR #2448 R1 — the comparator must be total. Cast at the call site because
  // the malformed shapes below are exactly what the type system forbids and a
  // non-TS caller could still hand over.
  test("a record with a missing startedAt sorts last instead of throwing", () => {
    const malformed = [
      { localId: "ds-nostart", taskId: "mt#3400", status: "running" },
      rec({ localId: "ds-ok", startedAt: "2026-07-30T09:00:00.000Z" }),
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found?.localId).toBe("ds-ok");
  });

  test("a non-string startedAt sorts last instead of throwing", () => {
    const malformed = [
      { localId: "ds-numeric", taskId: "mt#3400", status: "running", startedAt: 12345 },
      rec({ localId: "ds-ok", startedAt: "2026-07-30T09:00:00.000Z" }),
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found?.localId).toBe("ds-ok");
  });

  test("an all-malformed candidate set still returns a record rather than throwing", () => {
    const malformed = [
      { localId: "ds-a", taskId: "mt#3400", status: "running" },
      { localId: "ds-b", taskId: "mt#3400", status: "running" },
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found).not.toBeNull();
  });

  test("does not mutate the caller's array (the registry's own list)", () => {
    const records = [
      rec({ localId: "ds-old", startedAt: "2026-07-30T09:00:00.000Z" }),
      rec({ localId: "ds-new", startedAt: "2026-07-30T18:00:00.000Z" }),
    ];
    selectLiveDrivenSession(records, "mt#3400", normalize, isTerminal);
    expect(records.map((r) => r.localId)).toEqual(["ds-old", "ds-new"]);
  });
});
