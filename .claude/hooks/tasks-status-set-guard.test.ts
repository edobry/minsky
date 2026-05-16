import { describe, expect, it } from "bun:test";
import { checkTransition, type CheckDeps } from "./tasks-status-set-guard";

const fixedReader = (status: string | null, kind: string | null = null): CheckDeps => ({
  readCurrentTask: () => (status === null ? null : { status, kind }),
});

const TARGET = "mcp__minsky__tasks_status_set";

describe("checkTransition — non-target tools", () => {
  it("allows other tools regardless of input", () => {
    const r = checkTransition(
      "mcp__minsky__tasks_create",
      { taskId: "mt#1", status: "DONE" },
      fixedReader("TODO")
    );
    expect(r.decision).toBe("allow");
  });

  it("allows Bash and Write", () => {
    expect(checkTransition("Bash", { command: "ls" }, fixedReader(null)).decision).toBe("allow");
    expect(checkTransition("Write", { path: "/tmp/x" }, fixedReader(null)).decision).toBe("allow");
  });
});

describe("checkTransition — input shape", () => {
  it("allows when taskId is missing", () => {
    expect(checkTransition(TARGET, { status: "READY" }, fixedReader("TODO")).decision).toBe(
      "allow"
    );
  });

  it("allows when status is missing", () => {
    expect(checkTransition(TARGET, { taskId: "mt#1" }, fixedReader("TODO")).decision).toBe("allow");
  });

  it("allows when taskId is empty", () => {
    expect(
      checkTransition(TARGET, { taskId: "", status: "READY" }, fixedReader("TODO")).decision
    ).toBe("allow");
  });

  it("allows when status is empty", () => {
    expect(
      checkTransition(TARGET, { taskId: "mt#1", status: "" }, fixedReader("TODO")).decision
    ).toBe("allow");
  });
});

describe("checkTransition — invalid requested status", () => {
  it("denies when requested status is not in the enum", () => {
    const r = checkTransition(TARGET, { taskId: "mt#1", status: "INVALID" }, fixedReader("TODO"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("not a valid TaskStatus");
    expect(r.reason).toContain("INVALID");
  });

  it("denies when requested status is lowercase (case-sensitive enum)", () => {
    const r = checkTransition(TARGET, { taskId: "mt#1", status: "ready" }, fixedReader("TODO"));
    expect(r.decision).toBe("deny");
  });
});

describe("checkTransition — read-failure fail-open", () => {
  it("allows when readCurrentTask returns null", () => {
    const r = checkTransition(TARGET, { taskId: "mt#1", status: "DONE" }, fixedReader(null));
    expect(r.decision).toBe("allow");
  });

  it("allows when current status is not a valid enum value", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "DONE" },
      fixedReader("UNKNOWN_STATE")
    );
    expect(r.decision).toBe("allow");
  });
});

describe("checkTransition — allowed transitions", () => {
  // Mirror src/domain/tasks/status-transitions.ts:VALID_TRANSITIONS
  const allowed: Array<[string, string]> = [
    ["TODO", "PLANNING"],
    ["TODO", "CLOSED"],
    ["PLANNING", "READY"],
    ["PLANNING", "TODO"],
    ["PLANNING", "BLOCKED"],
    ["PLANNING", "CLOSED"],
    ["READY", "PLANNING"],
    ["READY", "BLOCKED"],
    ["READY", "CLOSED"],
    ["IN-PROGRESS", "IN-REVIEW"],
    ["IN-PROGRESS", "BLOCKED"],
    ["IN-PROGRESS", "PLANNING"],
    ["IN-PROGRESS", "CLOSED"],
    ["IN-REVIEW", "IN-PROGRESS"],
    ["IN-REVIEW", "DONE"],
    ["IN-REVIEW", "BLOCKED"],
    ["IN-REVIEW", "CLOSED"],
    ["DONE", "CLOSED"],
    ["BLOCKED", "TODO"],
    ["BLOCKED", "PLANNING"],
    ["BLOCKED", "READY"],
    ["BLOCKED", "CLOSED"],
    ["CLOSED", "TODO"],
  ];

  for (const [from, to] of allowed) {
    it(`allows ${from} -> ${to}`, () => {
      const r = checkTransition(TARGET, { taskId: "mt#1", status: to }, fixedReader(from));
      expect(r.decision).toBe("allow");
    });
  }
});

describe("checkTransition — disallowed transitions", () => {
  // Regression case from the originating mt#1470 incident.
  it("denies IN-REVIEW -> PLANNING (mt#1470 regression)", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1470", status: "PLANNING" },
      fixedReader("IN-REVIEW")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("IN-REVIEW");
    expect(r.reason).toContain("PLANNING");
    expect(r.reason).toContain("mt#1470");
  });

  it("denies IN-REVIEW -> READY (the second mt#1470 violation)", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1470", status: "READY" },
      fixedReader("IN-REVIEW")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("IN-REVIEW");
    expect(r.reason).toContain("READY");
  });

  it("denies READY -> IN-PROGRESS (session_start-only)", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "IN-PROGRESS" },
      fixedReader("READY")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("session_start");
  });

  it("denies PLANNING -> IN-PROGRESS (must go through READY)", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "IN-PROGRESS" },
      fixedReader("PLANNING")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("READY");
  });

  it("denies DONE -> any non-CLOSED", () => {
    for (const target of ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "BLOCKED"]) {
      const r = checkTransition(TARGET, { taskId: "mt#1", status: target }, fixedReader("DONE"));
      expect(r.decision).toBe("deny");
    }
  });

  it("allows DONE -> CLOSED (the only legitimate exit from DONE)", () => {
    const r = checkTransition(TARGET, { taskId: "mt#1", status: "CLOSED" }, fixedReader("DONE"));
    expect(r.decision).toBe("allow");
  });

  it("denies TODO -> READY (must go through PLANNING)", () => {
    const r = checkTransition(TARGET, { taskId: "mt#1", status: "READY" }, fixedReader("TODO"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("TODO");
  });

  it("denies CLOSED -> non-TODO (only reopen path)", () => {
    for (const target of ["PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED"]) {
      const r = checkTransition(TARGET, { taskId: "mt#1", status: target }, fixedReader("CLOSED"));
      expect(r.decision).toBe("deny");
    }
  });

  it("includes 'reconcile' guidance in denial reason", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "PLANNING" },
      fixedReader("IN-REVIEW")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("reconcile");
  });
});

describe("checkTransition — kind-aware dispatch (mt#1862)", () => {
  const withKind = (status: string | null, kind: string | null): CheckDeps => ({
    readCurrentTask: () => (status === null ? null : { status, kind }),
  });

  it("allows PLANNING -> IN-PROGRESS for kind=umbrella", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1862", status: "IN-PROGRESS" },
      withKind("PLANNING", "umbrella")
    );
    expect(r.decision).toBe("allow");
  });

  it("denies PLANNING -> IN-PROGRESS for kind=implementation (special-case message)", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "IN-PROGRESS" },
      withKind("PLANNING", "implementation")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("PLANNING");
    expect(r.reason).toContain("IN-PROGRESS");
    expect(r.reason).toContain("session_start");
  });

  it("allows IN-PROGRESS -> COMPLETED for kind=umbrella", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1862", status: "COMPLETED" },
      withKind("IN-PROGRESS", "umbrella")
    );
    expect(r.decision).toBe("allow");
  });

  it("denies IN-PROGRESS -> COMPLETED for kind=implementation", () => {
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "COMPLETED" },
      withKind("IN-PROGRESS", "implementation")
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("IN-PROGRESS");
    expect(r.reason).toContain("COMPLETED");
  });

  it("allows PLANNING -> READY for kind=implementation (mirror of existing impl path)", () => {
    // Sanity check that adding kind doesn't break the existing implementation paths.
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "READY" },
      withKind("PLANNING", "implementation")
    );
    expect(r.decision).toBe("allow");
  });

  it("fail-open: kind reader returns null → validator defaults to implementation", () => {
    // When the kind read fails, the validator's DEFAULT_KIND ("implementation")
    // applies. The transition is then judged under implementation rules. For
    // PLANNING -> IN-PROGRESS this means deny (session_start-only).
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "IN-PROGRESS" },
      withKind("PLANNING", null)
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("session_start");
  });

  it("kind field present but null in the dep result → validator defaults to implementation", () => {
    // When the CLI returns a task without a `kind` field (legacy shape, etc.),
    // the dep returns `{ status, kind: null }`. The hook treats kind=null as
    // undefined and the validator's DEFAULT_KIND ("implementation") applies.
    const depsKindNull: CheckDeps = {
      readCurrentTask: () => ({ status: "PLANNING", kind: null }),
    };
    const r = checkTransition(
      TARGET,
      { taskId: "mt#1", status: "IN-PROGRESS" },
      depsKindNull
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("session_start");
  });
});