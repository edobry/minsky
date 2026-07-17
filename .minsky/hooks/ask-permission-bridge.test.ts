import { describe, test, expect } from "bun:test";
import { extractCommand, buildAllowReason, buildDenyReason } from "./ask-permission-bridge";
import type { AskGrant } from "./ask-grant-store";

const grant: AskGrant = {
  askId: "38b1c0de-1234-4abc-8def-000000000001",
  tool: "Bash",
  commandPattern: "^minsky tasks bulk-edit .*$",
  issuedAt: "2026-07-17T10:00:00.000Z",
  ttlMs: 900000,
  reason: "approved via ask 38b1c0de",
};

describe("extractCommand", () => {
  test("extracts the command for the bridged tools", () => {
    expect(extractCommand("Bash", { command: "echo hi" })).toBe("echo hi");
    expect(extractCommand("mcp__minsky__session_exec", { command: "bun test" })).toBe("bun test");
  });

  test("returns null for other tools and missing/empty commands", () => {
    expect(extractCommand("Edit", { command: "echo hi" })).toBeNull();
    expect(extractCommand("Bash", {})).toBeNull();
    expect(extractCommand("Bash", { command: "" })).toBeNull();
    expect(extractCommand("Bash", { command: 42 as unknown as string })).toBeNull();
  });
});

describe("decision reasons", () => {
  test("allow reason names the askId and one-shot consumption", () => {
    const reason = buildAllowReason(grant);
    expect(reason).toContain(grant.askId);
    expect(reason).toMatch(/one-shot/);
  });

  test("deny reason names the askId and the fabrication signal", () => {
    const reason = buildDenyReason(grant, {
      verdict: "not-approved",
      detail: "ask not found",
    });
    expect(reason).toContain(grant.askId);
    expect(reason).toMatch(/FAILED server-side verification/);
    expect(reason).toMatch(/fabricated or stale/);
  });
});
