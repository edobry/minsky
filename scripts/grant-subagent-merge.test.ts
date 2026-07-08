import { describe, expect, it } from "bun:test";
import { buildGrantFromArgs } from "./grant-subagent-merge";

const NOW_ISO = "2026-07-07T20:00:00.000Z";

describe("buildGrantFromArgs", () => {
  it("returns null when --task is missing", () => {
    expect(buildGrantFromArgs({}, NOW_ISO)).toBeNull();
  });

  it("builds a grant with default ttl (30 min) and agentScope ('any') when only --task is given", () => {
    const grant = buildGrantFromArgs({ task: "mt#2651" }, NOW_ISO);
    expect(grant).not.toBeNull();
    expect(grant?.taskId).toBe("mt2651"); // normalized
    expect(grant?.agentScope).toBe("any");
    expect(grant?.ttlMs).toBe(30 * 60 * 1000);
    expect(grant?.issuedAt).toBe(NOW_ISO);
  });

  it("honors --ttl-minutes", () => {
    const grant = buildGrantFromArgs({ task: "mt#2651", "ttl-minutes": "45" }, NOW_ISO);
    expect(grant?.ttlMs).toBe(45 * 60 * 1000);
  });

  it("returns null for a non-positive --ttl-minutes", () => {
    expect(buildGrantFromArgs({ task: "mt#2651", "ttl-minutes": "0" }, NOW_ISO)).toBeNull();
    expect(buildGrantFromArgs({ task: "mt#2651", "ttl-minutes": "-5" }, NOW_ISO)).toBeNull();
  });

  it("returns null for a non-numeric --ttl-minutes", () => {
    expect(buildGrantFromArgs({ task: "mt#2651", "ttl-minutes": "abc" }, NOW_ISO)).toBeNull();
  });

  it("honors --agent-scope", () => {
    const grant = buildGrantFromArgs({ task: "mt#2651", "agent-scope": "agent-123" }, NOW_ISO);
    expect(grant?.agentScope).toBe("agent-123");
  });

  it("passes through --issued-by and --reason", () => {
    const grant = buildGrantFromArgs(
      { task: "mt#2651", "issued-by": "main-agent session abc", reason: "burndown wave 3" },
      NOW_ISO
    );
    expect(grant?.issuedBy).toBe("main-agent session abc");
    expect(grant?.reason).toBe("burndown wave 3");
  });

  it("normalizes the task id (strips # and lowercases)", () => {
    const grant = buildGrantFromArgs({ task: "MT#2651" }, NOW_ISO);
    expect(grant?.taskId).toBe("mt2651");
  });
});
