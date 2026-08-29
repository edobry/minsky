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
  projectLabelBySlug,
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

/**
 * Shared two-project fixture for the mt#4729 badge-helper suites below.
 * Typed as a tuple (not a bare array) so destructuring below is provably
 * non-undefined without a `!` assertion.
 */
const TWO_PROJECTS_FIXTURE: [ProjectSummary, ProjectSummary] = [
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

describe("projectLabelBySlug (mt#4729)", () => {
  const projects = TWO_PROJECTS_FIXTURE;
  const [minsky, peezombie] = projects;

  test("returns displayName when the shell knows a project by that slug", () => {
    expect(projectLabelBySlug(projects, minsky.slug)).toBe("Minsky");
  });

  test("falls back to the slug itself when displayName is null", () => {
    expect(projectLabelBySlug(projects, peezombie.slug)).toBe(peezombie.slug);
  });

  test("returns null for a null slug", () => {
    expect(projectLabelBySlug(projects, null)).toBeNull();
  });

  test("returns the slug itself (not null) for a slug the shell's project list doesn't include", () => {
    expect(projectLabelBySlug(projects, "someone/else")).toBe("someone/else");
  });
});
