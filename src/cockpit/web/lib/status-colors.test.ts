/**
 * Tests for the shared task-status color mapping (mt#2909).
 */
import { describe, expect, test } from "bun:test";
import { statusStyle, type TaskStatus } from "./status-colors";

const ALL_STATUSES: TaskStatus[] = [
  "TODO",
  "PLANNING",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
];

const HEX_PATTERN = /#[0-9a-fA-F]{6}/;

describe("statusStyle", () => {
  test.each(ALL_STATUSES)("returns a background/border/color triple for %s", (status) => {
    const style = statusStyle(status);
    expect(style.background.length).toBeGreaterThan(0);
    expect(style.border.length).toBeGreaterThan(0);
    expect(style.color.length).toBeGreaterThan(0);
  });

  test.each(ALL_STATUSES)(
    "%s resolves to a semantic oklch(var(--...)) token, not raw hex",
    (status) => {
      const style = statusStyle(status);
      for (const value of [style.background, style.border, style.color]) {
        expect(HEX_PATTERN.test(value)).toBe(false);
        expect(value).toContain("oklch(var(--");
      }
    }
  );

  test("is case-insensitive", () => {
    expect(statusStyle("done")).toEqual(statusStyle("DONE"));
    expect(statusStyle("In-Review")).toEqual(statusStyle("IN-REVIEW"));
  });

  test("COMPLETED is retired (mt#2919) — falls back to TODO like any unrecognized status", () => {
    expect(statusStyle("COMPLETED")).toEqual(statusStyle("TODO"));
    expect(statusStyle("completed")).toEqual(statusStyle("TODO"));
  });

  test("falls back to TODO styling for an unknown status", () => {
    expect(statusStyle("SOME-UNKNOWN-STATUS")).toEqual(statusStyle("TODO"));
  });

  test("trims surrounding whitespace before matching", () => {
    expect(statusStyle("  DONE  ")).toEqual(statusStyle("DONE"));
    expect(statusStyle("\tin-review\n")).toEqual(statusStyle("IN-REVIEW"));
  });

  test("status token families follow cockpit-design SKILL.md §Status color conventions", () => {
    expect(statusStyle("READY").background).toContain("--primary");
    expect(statusStyle("IN-REVIEW").border).toContain("--warn-amber");
    expect(statusStyle("BLOCKED").border).toContain("--warn-red");
    expect(statusStyle("DONE").border).toContain("--liveness-healthy");
    expect(statusStyle("TODO").background).toContain("--muted");
  });
});
