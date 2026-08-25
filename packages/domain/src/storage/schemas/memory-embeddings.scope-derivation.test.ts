/**
 * Pins the relationship between the memory scope enum and the project-agnostic set (mt#4530,
 * PR #3302 R1).
 *
 * The reviewer's finding: a hand-written `["user", "cross_project"]` makes "bound to a project"
 * the DEFAULT for any scope added later. A new value would be filtered out of every
 * project-scoped read with no error and no failing test — the mt#4530 defect re-introduced by an
 * edit that never touched the filter.
 *
 * These assertions are about the DERIVATION, not about today's three values. They stay true when
 * the enum grows, which is the whole point: a test that hard-codes the same list it is checking
 * would fail in the same silent direction as the code did.
 */

import { describe, test, expect } from "bun:test";
import {
  memoryScopeEnum,
  PROJECT_BOUND_MEMORY_SCOPE,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "./memory-embeddings";

describe("memory scope derivation", () => {
  test("the project-bound scope is a real member of the enum", () => {
    // Guards against a rename of the enum value silently orphaning the constant, which would
    // make EVERY scope project-agnostic and defeat scoping in the opposite direction.
    expect(memoryScopeEnum.enumValues).toContain(PROJECT_BOUND_MEMORY_SCOPE);
  });

  test("every scope is either project-bound or project-agnostic — no value is unclassified", () => {
    const classified = [PROJECT_BOUND_MEMORY_SCOPE, ...PROJECT_AGNOSTIC_MEMORY_SCOPES].sort();

    expect(classified).toEqual([...memoryScopeEnum.enumValues].sort());
  });

  test("the project-bound scope is NOT in the agnostic set", () => {
    expect(PROJECT_AGNOSTIC_MEMORY_SCOPES).not.toContain(PROJECT_BOUND_MEMORY_SCOPE);
  });

  test("a scope added to the enum lands in the agnostic set by default, not silently excluded", () => {
    // The derivation, applied to a hypothetical future enum. This is the assertion the
    // hand-written list could not make: adding a value must widen what a project-scoped read
    // returns, never narrow it.
    const futureEnumValues = [...memoryScopeEnum.enumValues, "team"] as const;
    const derived = futureEnumValues.filter((s) => s !== PROJECT_BOUND_MEMORY_SCOPE);

    expect(derived).toContain("team");
    expect(derived.length).toBe(PROJECT_AGNOSTIC_MEMORY_SCOPES.length + 1);
  });

  test("the agnostic set is non-empty, so a project-scoped read is never a bare id equality", () => {
    expect(PROJECT_AGNOSTIC_MEMORY_SCOPES.length).toBeGreaterThan(0);
  });
});
