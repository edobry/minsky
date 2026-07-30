/**
 * Tests for the shared destructive-override contract (mt#3021 SC4 / AT6).
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  isValidDestructiveOverride,
  resolveDestructiveOverride,
  recordDestructiveOverride,
  DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR,
} from "./destructive-override";

describe("isValidDestructiveOverride", () => {
  test("undefined is invalid", () => {
    expect(isValidDestructiveOverride(undefined)).toBe(false);
  });
  test("null is invalid", () => {
    expect(isValidDestructiveOverride(null)).toBe(false);
  });
  test("empty-string reason is invalid", () => {
    expect(isValidDestructiveOverride({ reason: "" })).toBe(false);
  });
  test("whitespace-only reason is invalid", () => {
    expect(isValidDestructiveOverride({ reason: "   " })).toBe(false);
  });
  test("a genuine reason string is valid", () => {
    expect(isValidDestructiveOverride({ reason: "recovering an abandoned session" })).toBe(true);
  });
});

describe("resolveDestructiveOverride", () => {
  const originalEnv = process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR];
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR];
    } else {
      process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR] = originalEnv;
    }
  });

  test("explicit reason wins over env var", () => {
    process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR] = "env reason";
    const result = resolveDestructiveOverride("explicit reason");
    expect(result).toEqual({ reason: "explicit reason" });
  });

  test("falls back to the env var when no explicit reason is supplied", () => {
    process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR] = "env reason";
    const result = resolveDestructiveOverride(undefined);
    expect(result).toEqual({ reason: "env reason" });
  });

  test("returns undefined when neither source is present", () => {
    delete process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR];
    expect(resolveDestructiveOverride(undefined)).toBeUndefined();
  });

  test("an empty explicit reason falls through to the env var, not treated as valid on its own", () => {
    process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR] = "env reason";
    expect(resolveDestructiveOverride("   ")).toEqual({ reason: "env reason" });
  });

  test("a whitespace-only env var does not satisfy the override", () => {
    process.env[DESTRUCTIVE_OVERRIDE_REASON_ENV_VAR] = "   ";
    expect(resolveDestructiveOverride(undefined)).toBeUndefined();
  });
});

describe("recordDestructiveOverride (AT6: queryable audit record carrying the reason)", () => {
  test("emits a guard.overridden system event with guard + reason + details in the payload", async () => {
    const insertValues = mock(() => Promise.resolve());
    const fakeDb = { insert: () => ({ values: insertValues }) } as any;
    const provider = { getDatabaseConnection: async () => fakeDb } as any;

    const result = await recordDestructiveOverride({
      guard: "session-commit-mass-deletion",
      reason: "intentional directory-rename cutover",
      details: { deletionCount: 150, threshold: 100 },
      persistenceProvider: provider,
      relatedSessionId: "session-abc",
      relatedTaskId: "mt#3021",
    });

    expect(result).toBe(true);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.eventType).toBe("guard.overridden");
    expect(insertedRow.payload).toMatchObject({
      guard: "session-commit-mass-deletion",
      reason: "intentional directory-rename cutover",
      deletionCount: 150,
      threshold: 100,
    });
    expect(insertedRow.relatedSessionId).toBe("session-abc");
    expect(insertedRow.relatedTaskId).toBe("mt#3021");
  });

  test("without a persistence provider, degrades to a no-op (never throws)", async () => {
    await expect(
      recordDestructiveOverride({ guard: "session-delete-git-state", reason: "test" })
    ).resolves.toBe(false);
  });
});
