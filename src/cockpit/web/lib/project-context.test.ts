/**
 * Tests for the pure helpers backing project-context.tsx (mt#2418).
 *
 * Bun has no `renderHook` (see lib/tabs.test.tsx / useListControls.test.ts
 * precedent) — these tests exercise the exported pure logic directly; the
 * stateful `ProjectProvider` React integration is manual-QA'd.
 */
import { describe, test, expect } from "bun:test";
import { deriveQueryParam, isKnownSlug, type ProjectSummary } from "./project-context";

describe("deriveQueryParam", () => {
  test("returns undefined for null (All projects)", () => {
    expect(deriveQueryParam(null)).toBeUndefined();
  });

  test("returns { project: slug } for a selected slug", () => {
    expect(deriveQueryParam("edobry/minsky")).toEqual({ project: "edobry/minsky" });
  });
});

describe("isKnownSlug", () => {
  const projects: ProjectSummary[] = [
    { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
    { id: "2", slug: "edobry/other-repo", displayName: null },
  ];

  test("null (All projects) is always known", () => {
    expect(isKnownSlug(projects, null)).toBe(true);
    expect(isKnownSlug([], null)).toBe(true);
  });

  test("a slug present in the project list is known", () => {
    expect(isKnownSlug(projects, "edobry/minsky")).toBe(true);
  });

  test("a slug absent from the project list is not known", () => {
    expect(isKnownSlug(projects, "someone/else")).toBe(false);
  });

  test("any non-null slug is unknown against an empty project list", () => {
    expect(isKnownSlug([], "edobry/minsky")).toBe(false);
  });
});
