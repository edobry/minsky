/**
 * mapDeploymentRecordToEvent tests (mt#2537) — the deploy.live / deploy.fail
 * status-to-event mapping used by the `deployment.wait-for-latest` execute
 * handler's best-effort system-event emit.
 */
import { describe, test, expect } from "bun:test";
import { mapDeploymentRecordToEvent } from "./deployment";
import type { DeploymentRecord } from "@minsky/domain/deployment";

function record(status: DeploymentRecord["status"]): DeploymentRecord {
  return {
    id: "dep-1",
    status,
    commitHash: "abc123",
    commitMessage: "test commit",
    createdAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    durationMs: 300_000,
    url: null,
  };
}

describe("mapDeploymentRecordToEvent (mt#2537)", () => {
  test("SUCCESS maps to deploy.live with phase 'live'", () => {
    const event = mapDeploymentRecordToEvent(record("SUCCESS"), "reviewer");
    expect(event.eventType).toBe("deploy.live");
    expect(event.payload).toEqual({ phase: "live", service: "reviewer", status: "SUCCESS" });
  });

  test("FAILED maps to deploy.fail with phase 'fail'", () => {
    const event = mapDeploymentRecordToEvent(record("FAILED"), "reviewer");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload).toEqual({ phase: "fail", service: "reviewer", status: "FAILED" });
  });

  test("CRASHED maps to deploy.fail", () => {
    const event = mapDeploymentRecordToEvent(record("CRASHED"), "site");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload.status).toBe("CRASHED");
  });

  test("CANCELLED maps to deploy.fail (not 'live' for this bridge)", () => {
    const event = mapDeploymentRecordToEvent(record("CANCELLED"), "site");
    expect(event.eventType).toBe("deploy.fail");
    expect(event.payload.status).toBe("CANCELLED");
  });

  test("service is passed through as undefined when not provided", () => {
    const event = mapDeploymentRecordToEvent(record("SUCCESS"), undefined);
    expect(event.payload.service).toBeUndefined();
  });
});
