/**
 * Tests for the pure helpers backing project-context.tsx (mt#2418).
 *
 * Bun has no `renderHook` (see lib/tabs.test.tsx / useListControls.test.ts
 * precedent) — these tests exercise the exported pure logic directly; the
 * stateful `ProjectProvider` React integration is manual-QA'd.
 */
import { describe, test, expect } from "bun:test";
import {
  deriveQueryParam,
  isKnownSlug,
  shouldShowProjectIndicator,
  projectLabelById,
  type ProjectSummary,
} from "./project-context";

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

/** Shared two-project fixture for the mt#4729 badge-helper suites below. */
const TWO_PROJECTS_FIXTURE: ProjectSummary[] = [
  { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
  { id: "2", slug: "edobry/peezombie", displayName: null },
];

describe("shouldShowProjectIndicator (mt#4729)", () => {
  const one: ProjectSummary[] = [{ id: "1", slug: "edobry/minsky", displayName: "Minsky" }];

  test("shows when 2+ projects exist and none is selected (All projects)", () => {
    expect(shouldShowProjectIndicator(TWO_PROJECTS_FIXTURE, null)).toBe(true);
  });

  test("suppresses when only one project is known, even unselected", () => {
    expect(shouldShowProjectIndicator(one, null)).toBe(false);
  });

  test("suppresses when zero projects are known", () => {
    expect(shouldShowProjectIndicator([], null)).toBe(false);
  });

  test("suppresses when a single project is explicitly selected, even with 2+ known", () => {
    expect(shouldShowProjectIndicator(TWO_PROJECTS_FIXTURE, "edobry/minsky")).toBe(false);
  });
});

describe("projectLabelById (mt#4729)", () => {
  const projects = TWO_PROJECTS_FIXTURE;

  test("returns displayName when set", () => {
    expect(projectLabelById(projects, "1")).toBe("Minsky");
  });

  test("falls back to slug when displayName is null", () => {
    expect(projectLabelById(projects, "2")).toBe("edobry/peezombie");
  });

  test("returns null for a null projectId", () => {
    expect(projectLabelById(projects, null)).toBeNull();
  });

  test("returns null for a projectId naming no known project", () => {
    expect(projectLabelById(projects, "unknown-uuid")).toBeNull();
  });
});
