/**
 * Tests for persistence configuration schema validation.
 *
 * Covers the ms-scale migration error messages added in mt#1201 Round 2.
 */
import { describe, it, expect } from "bun:test";
import { persistenceConfigSchema } from "./persistence";

const CONNECTION_STRING = "postgresql://user:pass@host/db";

function parseTimeout(field: "connectTimeout" | "idleTimeout", value: number) {
  return persistenceConfigSchema.safeParse({
    backend: "postgres",
    postgres: {
      connectionString: CONNECTION_STRING,
      [field]: value,
    },
  });
}

describe("persistenceConfigSchema — connectTimeout ms-scale migration error", () => {
  it("connectTimeout: 30000 fails with custom migration message", () => {
    const result = parseTimeout("connectTimeout", 30000);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).toContain("connectTimeout is now in seconds");
      expect(message).toContain("30 s");
      expect(message).toContain("connectTimeout: 30");
    }
  });

  it("connectTimeout: 5000 fails with custom migration message (5 s suggestion)", () => {
    const result = parseTimeout("connectTimeout", 5000);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).toContain("connectTimeout is now in seconds");
      expect(message).toContain("5 s");
      expect(message).toContain("connectTimeout: 5");
    }
  });

  it("connectTimeout: 350 fails with standard out-of-range error (not ms-scale message)", () => {
    const result = parseTimeout("connectTimeout", 350);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).not.toContain("is now in seconds");
    }
  });

  it("connectTimeout: 30 passes validation", () => {
    const result = parseTimeout("connectTimeout", 30);
    expect(result.success).toBe(true);
  });
});

describe("persistenceConfigSchema — idleTimeout ms-scale migration error", () => {
  it("idleTimeout: 60000 fails with custom migration message (60 s suggestion)", () => {
    const result = parseTimeout("idleTimeout", 60000);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).toContain("idleTimeout is now in seconds");
      expect(message).toContain("60 s");
      expect(message).toContain("idleTimeout: 60");
    }
  });

  it("idleTimeout: 5000 fails with custom migration message (5 s suggestion)", () => {
    const result = parseTimeout("idleTimeout", 5000);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).toContain("idleTimeout is now in seconds");
      expect(message).toContain("5 s");
      expect(message).toContain("idleTimeout: 5");
    }
  });

  it("idleTimeout: 700 fails with standard out-of-range error (not ms-scale message)", () => {
    const result = parseTimeout("idleTimeout", 700);
    expect(result.success).toBe(false);
    if (!result.success) {
      const firstIssue = result.error.issues.at(0);
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message ?? "";
      expect(message).not.toContain("is now in seconds");
    }
  });

  it("idleTimeout: 60 passes validation", () => {
    const result = parseTimeout("idleTimeout", 60);
    expect(result.success).toBe(true);
  });
});
