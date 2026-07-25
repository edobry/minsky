/**
 * Tests for GitHub App permission drift detection.
 *
 * @see mt#3218
 */

import { describe, it, expect } from "bun:test";
import {
  detectPermissionDrift,
  formatPermissionDriftMessage,
  githubAppSettingsUrl,
  REQUIRED_APP_PERMISSIONS,
} from "./permission-drift";

describe("detectPermissionDrift", () => {
  it("reports no drift when all required permissions are met exactly", () => {
    const result = detectPermissionDrift({
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    });
    expect(result.hasDrift).toBe(false);
    expect(result.missing).toHaveLength(0);
  });

  it("reports no drift when actual permissions exceed the requirement", () => {
    const result = detectPermissionDrift({
      pull_requests: "admin",
      contents: "write",
      metadata: "write",
    });
    expect(result.hasDrift).toBe(false);
  });

  it("flags contents:read as drift when contents:write is required (mt#3210 case)", () => {
    const result = detectPermissionDrift({
      pull_requests: "write",
      contents: "read",
      metadata: "read",
    });
    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "contents", required: "write", actual: "read" }]);
  });

  it("flags an entirely absent permission", () => {
    const result = detectPermissionDrift({ pull_requests: "write" });
    expect(result.hasDrift).toBe(true);
    const scopes = result.missing.map((m) => m.scope).sort();
    expect(scopes).toEqual(["contents", "metadata"]);
    const contentsEntry = result.missing.find((m) => m.scope === "contents");
    expect(contentsEntry?.actual).toBeUndefined();
  });

  it("supports a custom required-permission set", () => {
    const result = detectPermissionDrift({ actions: "read" }, [
      { scope: "actions", level: "write" },
    ]);
    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "actions", required: "write", actual: "read" }]);
  });

  it("REQUIRED_APP_PERMISSIONS includes contents:write (mt#1477/mt#3210)", () => {
    const contents = REQUIRED_APP_PERMISSIONS.find((p) => p.scope === "contents");
    expect(contents?.level).toBe("write");
  });
});

describe("githubAppSettingsUrl", () => {
  it("builds the exact settings URL from the App slug", () => {
    expect(githubAppSettingsUrl("minsky-ai")).toBe(
      "https://github.com/settings/apps/minsky-ai/permissions"
    );
  });
});

describe("formatPermissionDriftMessage", () => {
  it("names the settings URL and the specific permission on drift", () => {
    const drift = detectPermissionDrift({
      pull_requests: "write",
      contents: "read",
      metadata: "read",
    });
    const message = formatPermissionDriftMessage("minsky-ai", drift);
    expect(message).toContain("https://github.com/settings/apps/minsky-ai/permissions");
    expect(message).toContain("contents");
    expect(message).toContain('needs "write"');
    expect(message).toContain('currently "read"');
    expect(message).toMatch(/accept/i);
  });

  it("returns a matches message when there is no drift", () => {
    const drift = detectPermissionDrift({
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    });
    const message = formatPermissionDriftMessage("minsky-ai", drift);
    expect(message).toMatch(/match/i);
    expect(message).not.toContain("settings/apps");
  });
});
