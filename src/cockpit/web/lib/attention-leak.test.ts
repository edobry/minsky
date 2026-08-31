/**
 * Tests for elsewhereCount (mt#4794) — the cross-project needs-me leak
 * decision shared by the rail Attention item and home's Needs-you region.
 */
import { describe, test, expect } from "bun:test";
import { elsewhereCount } from "./attention-leak";

describe("elsewhereCount", () => {
  test("scoped=0/unscoped=N: leaks the full unscoped total (the mt#4757 audit fixture)", () => {
    expect(elsewhereCount(true, 0, 40)).toBe(40);
  });

  test("scoped=N/unscoped=N (equal): no leak", () => {
    expect(elsewhereCount(true, 40, 40)).toBeNull();
  });

  test("scoped>0 and unscoped>scoped: leaks the difference, not the unscoped total", () => {
    expect(elsewhereCount(true, 5, 45)).toBe(40);
  });

  test("All-projects (no filter active): never leaks, regardless of counts", () => {
    expect(elsewhereCount(false, 0, 40)).toBeNull();
    expect(elsewhereCount(false, 40, 40)).toBeNull();
  });

  test("either count still unresolved: stays quiet rather than flashing a wrong number", () => {
    expect(elsewhereCount(true, undefined, 40)).toBeNull();
    expect(elsewhereCount(true, 0, undefined)).toBeNull();
    expect(elsewhereCount(true, undefined, undefined)).toBeNull();
  });

  test("scoped somehow exceeds unscoped: non-positive diff never renders", () => {
    expect(elsewhereCount(true, 45, 40)).toBeNull();
  });
});
