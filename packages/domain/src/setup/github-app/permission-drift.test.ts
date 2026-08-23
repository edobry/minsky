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

/**
 * The permission set the live `minsky-ai` App actually holds, read from
 * `GET /app` on 2026-08-19 (mt#3264). Used as the "healthy" baseline so a test
 * asserting no-drift describes a real installation rather than a set invented
 * to match the constant.
 */
const LIVE_APP_PERMISSIONS: Record<string, string> = {
  actions: "write",
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  workflows: "write",
};

describe("detectPermissionDrift", () => {
  it("reports no drift when all required permissions are met exactly", () => {
    const result = detectPermissionDrift({ ...LIVE_APP_PERMISSIONS });
    expect(result.hasDrift).toBe(false);
    expect(result.missing).toHaveLength(0);
  });

  it("reports no drift when actual permissions exceed the requirement", () => {
    const result = detectPermissionDrift({
      ...LIVE_APP_PERMISSIONS,
      pull_requests: "admin",
      metadata: "write",
    });
    expect(result.hasDrift).toBe(false);
  });

  it("flags contents:read as drift when contents:write is required (mt#3210 case)", () => {
    const result = detectPermissionDrift({ ...LIVE_APP_PERMISSIONS, contents: "read" });
    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "contents", required: "write", actual: "read" }]);
  });

  it("flags an entirely absent permission", () => {
    const result = detectPermissionDrift({ pull_requests: "write" });
    expect(result.hasDrift).toBe(true);
    const scopes = result.missing.map((m) => m.scope).sort();
    expect(scopes).toEqual(["actions", "contents", "metadata", "workflows"]);
    const contentsEntry = result.missing.find((m) => m.scope === "contents");
    expect(contentsEntry?.actual).toBeUndefined();
  });

  // mt#3264: the two cases the check was blind to for the whole of mt#3218's life.
  // Before `workflows`/`actions` joined REQUIRED_APP_PERMISSIONS, both of these
  // returned hasDrift:false — `config.doctor` reported "permissions match" on an
  // App that could not push a workflow file at all, which is the originating
  // incident.
  it("flags an absent workflows permission (mt#3264 originating incident)", () => {
    const withoutWorkflows = { ...LIVE_APP_PERMISSIONS };
    delete withoutWorkflows.workflows;

    const result = detectPermissionDrift(withoutWorkflows);

    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "workflows", required: "write", actual: undefined }]);
  });

  it("flags workflows:read as drift when workflows:write is required", () => {
    const result = detectPermissionDrift({ ...LIVE_APP_PERMISSIONS, workflows: "read" });

    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "workflows", required: "write", actual: "read" }]);
  });

  it("flags an absent actions permission", () => {
    const withoutActions = { ...LIVE_APP_PERMISSIONS };
    delete withoutActions.actions;

    const result = detectPermissionDrift(withoutActions);

    expect(result.hasDrift).toBe(true);
    expect(result.missing).toEqual([{ scope: "actions", required: "write", actual: undefined }]);
  });

  it("reports no drift against the live App's permission set (read 2026-08-19)", () => {
    // Guards the direction the other cases cannot: that the required set has not
    // drifted ABOVE what the real installation grants, which would make
    // `config.doctor` report a permanent false failure.
    const result = detectPermissionDrift(LIVE_APP_PERMISSIONS);
    expect(result.missing).toEqual([]);
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
    const drift = detectPermissionDrift({ ...LIVE_APP_PERMISSIONS, contents: "read" });
    const message = formatPermissionDriftMessage("minsky-ai", drift);
    expect(message).toContain("https://github.com/settings/apps/minsky-ai/permissions");
    expect(message).toContain("contents");
    expect(message).toContain('needs "write"');
    expect(message).toContain('currently "read"');
    expect(message).toMatch(/accept/i);
  });

  it("returns a matches message when there is no drift", () => {
    const drift = detectPermissionDrift(LIVE_APP_PERMISSIONS);
    const message = formatPermissionDriftMessage("minsky-ai", drift);
    expect(message).toMatch(/match/i);
    expect(message).not.toContain("settings/apps");
  });
});
