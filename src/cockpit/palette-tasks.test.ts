/**
 * sortTasksByRecency tests (mt#2444).
 */
import { describe, test, expect } from "bun:test";
import { sortTasksByRecency } from "./palette-tasks";

describe("sortTasksByRecency", () => {
  test("most recently updated first", () => {
    const sorted = sortTasksByRecency([
      { id: "old", updatedAt: new Date("2025-01-01T00:00:00Z") },
      { id: "new", updatedAt: new Date("2026-06-10T00:00:00Z") },
      { id: "mid", updatedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  test("createdAt is the fallback when updatedAt is missing", () => {
    const sorted = sortTasksByRecency([
      { id: "created-old", createdAt: new Date("2025-06-01T00:00:00Z") },
      { id: "updated-new", updatedAt: new Date("2026-06-01T00:00:00Z") },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["updated-new", "created-old"]);
  });

  test("unstamped tasks sort last and input is not mutated", () => {
    const input = [
      { id: "unstamped" },
      { id: "stamped", updatedAt: new Date("2026-06-01T00:00:00Z") },
    ];
    const sorted = sortTasksByRecency(input);
    expect(sorted.map((t) => t.id)).toEqual(["stamped", "unstamped"]);
    expect(input.map((t) => t.id)).toEqual(["unstamped", "stamped"]);
  });
});
