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
import { parseTaskMetaIds } from "./tasks";

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
