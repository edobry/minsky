/**
 * Tests for the emission wiring (DetectionSignal + AskIntent + signature).
 *
 * Acceptance:
 *   - buildEvidenceSignature is deterministic across calls with identical input.
 *   - buildEvidenceSignature differs when (reason, path) changes.
 *   - buildDetectionSignal sets kind = "direction.decide" and severity per table.
 *   - emitAskIntent produces an AskIntent with the metadata round-trip.
 *
 * Reference: mt#1575 §Acceptance Tests; mt#1574 router-bridge.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  buildEvidenceSignature,
  buildDetectionSignal,
  emitAskIntent,
  DETECTOR_ID,
  DETECTOR_VERSION,
  __TEST_ONLY,
} from "./emit";
import type { ActionDescriptor } from "./coverage";
import type { DetectionContext } from "../types";

const FIXTURE_FILE_PATH = "src/options.json";

function makeAction(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    reason: "new-config-key",
    detail: `Edit to ${FIXTURE_FILE_PATH} introduces a new config key`,
    filePath: FIXTURE_FILE_PATH,
    ...overrides,
  };
}

function makeContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    surface: "pre-tool",
    agentId: "claude-code:proc:abc123",
    sessionId: "session-uuid-001",
    parentTaskId: "mt#1575",
    toolCall: {
      toolName: "Edit",
      params: { file_path: FIXTURE_FILE_PATH },
    },
    ...overrides,
  } as DetectionContext;
}

describe("buildEvidenceSignature", () => {
  it("is deterministic across identical inputs", () => {
    const a = makeAction();
    const b = makeAction();
    expect(buildEvidenceSignature(a)).toBe(buildEvidenceSignature(b));
  });

  it("changes when reason differs", () => {
    const a = makeAction({ reason: "new-config-key" });
    const b = makeAction({ reason: "new-dependency" });
    expect(buildEvidenceSignature(a)).not.toBe(buildEvidenceSignature(b));
  });

  it("changes when filePath basename differs", () => {
    const a = makeAction({ filePath: "src/a.ts" });
    const b = makeAction({ filePath: "src/b.ts" });
    expect(buildEvidenceSignature(a)).not.toBe(buildEvidenceSignature(b));
  });

  it("treats moves of same basename as the same signature", () => {
    const a = makeAction({ filePath: "src/foo.ts" });
    const b = makeAction({ filePath: "lib/foo.ts" });
    expect(buildEvidenceSignature(a)).toBe(buildEvidenceSignature(b));
  });

  it("differentiates tests/ vs production paths via prefix", () => {
    const prod = makeAction({ filePath: "src/foo.ts" });
    const test = makeAction({ filePath: "src/__tests__/foo.ts" });
    expect(buildEvidenceSignature(prod)).not.toBe(buildEvidenceSignature(test));
  });

  it("returns a 16-char hex digest", () => {
    const sig = buildEvidenceSignature(makeAction());
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles missing filePath", () => {
    const sig = buildEvidenceSignature({ reason: "new-file", detail: "no path" });
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildDetectionSignal", () => {
  it("sets suspectedKind to direction.decide", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", { file_path: "src/options.json" });
    expect(signal.suspectedKind).toBe("direction.decide");
  });

  it("uses high severity for new-dependency", () => {
    const action = makeAction({ reason: "new-dependency", filePath: "package.json" });
    const signal = buildDetectionSignal(action, "Edit", {});
    expect(signal.severity).toBe("high");
  });

  it("uses high severity for new-config-key", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    expect(signal.severity).toBe("high");
  });

  it("uses low severity for new-file", () => {
    const action = makeAction({ reason: "new-file", filePath: "src/new.ts" });
    const signal = buildDetectionSignal(action, "Write", {});
    expect(signal.severity).toBe("low");
  });

  it("populates detectorId and detectorVersion from the constants", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    expect(signal.detectorId).toBe(DETECTOR_ID);
    expect(signal.detectorVersion).toBe(DETECTOR_VERSION);
  });

  it("produces a tool-call evidence entry", () => {
    const params = { file_path: "src/foo.ts", new_string: "x" };
    const signal = buildDetectionSignal(makeAction(), "Edit", params);
    const toolCallEvidence = signal.evidence.find((e) => e.kind === "tool-call");
    expect(toolCallEvidence).toBeDefined();
    expect(toolCallEvidence?.payload).toEqual({ toolName: "Edit", params });
  });

  it("produces a policy-gap evidence entry", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    const gap = signal.evidence.find((e) => e.kind === "policy-gap");
    expect(gap).toBeDefined();
  });

  it("populates suggestedQuestion with reason-specific phrasing", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    expect(signal.suggestedQuestion).toContain("config default");
  });

  it("includes a file contextRef when filePath is set", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    expect(signal.contextRefs).toHaveLength(1);
    expect(signal.contextRefs[0]?.kind).toBe("file");
  });

  it("returns empty contextRefs when filePath is absent", () => {
    const action = makeAction({ filePath: undefined });
    const signal = buildDetectionSignal(action, "Edit", {});
    expect(signal.contextRefs).toHaveLength(0);
  });

  it("provides three suggestedOptions", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    expect(signal.suggestedOptions).toHaveLength(3);
  });
});

describe("emitAskIntent", () => {
  it("returns an AskIntent with kind direction.decide", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    const intent = emitAskIntent(signal, makeContext());
    expect(intent.kind).toBe("direction.decide");
  });

  it("includes detector id + severity in metadata", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    const intent = emitAskIntent(signal, makeContext());
    expect(intent.metadata.detectorId).toBe(DETECTOR_ID);
    expect(intent.metadata.severity).toBe("high");
  });

  it("forwards parentTaskId from context", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    const intent = emitAskIntent(signal, makeContext({ parentTaskId: "mt#1575" }));
    expect(intent.parentTaskId).toBe("mt#1575");
  });

  it("forwards sessionId as parentSessionId", () => {
    const signal = buildDetectionSignal(makeAction(), "Edit", {});
    const intent = emitAskIntent(signal, makeContext({ sessionId: "sess-xyz" }));
    expect(intent.parentSessionId).toBe("sess-xyz");
  });
});

describe("internal helpers", () => {
  it("extractPathSignature returns basename for plain paths", () => {
    expect(__TEST_ONLY.extractPathSignature("src/foo.ts")).toBe("foo.ts");
  });

  it("extractPathSignature prefixes special dirs", () => {
    expect(__TEST_ONLY.extractPathSignature("src/__tests__/foo.ts")).toBe("__tests__:foo.ts");
    expect(__TEST_ONLY.extractPathSignature("src/migrations/0001.sql")).toBe("migrations:0001.sql");
  });

  it("extractPathSignature handles backslash separators (Windows / mixed) — PR #951 R1 fix", () => {
    const forward = __TEST_ONLY.extractPathSignature("src/foo.ts");
    const back = __TEST_ONLY.extractPathSignature("src\\foo.ts");
    const mixed = __TEST_ONLY.extractPathSignature("src\\sub/foo.ts");
    expect(forward).toBe("foo.ts");
    expect(back).toBe("foo.ts");
    expect(mixed).toBe("foo.ts");
  });

  it("extractPathSignature recognises special dirs under backslash separators", () => {
    expect(__TEST_ONLY.extractPathSignature("src\\__tests__\\foo.ts")).toBe("__tests__:foo.ts");
    expect(__TEST_ONLY.extractPathSignature("src\\migrations\\0001.sql")).toBe(
      "migrations:0001.sql"
    );
  });

  it("formatQuestion is non-empty for every filter reason", () => {
    const reasons: Array<keyof typeof __TEST_ONLY.SEVERITY_BY_REASON> = [
      "new-file",
      "new-dependency",
      "new-config-key",
      "new-user-facing-string",
      "new-top-level-export",
    ];
    for (const r of reasons) {
      const q = __TEST_ONLY.formatQuestion({ reason: r, detail: "d", filePath: "x" }, "x");
      expect(q.length).toBeGreaterThan(0);
    }
  });
});
