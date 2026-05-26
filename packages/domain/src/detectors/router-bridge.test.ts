/**
 * Tests for the router bridge — signalToAskIntent.
 *
 * Acceptance test AT1: a synthetic DetectionSignal is converted to an AskIntent
 * with kind, requestor, title, metadata.detectorId, metadata.severity, and
 * metadata.evidence correctly populated.
 *
 * Reference: mt#1574 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import { signalToAskIntent } from "./router-bridge";
import type { DetectionSignal, DetectionContext } from "./types";

const DETECTOR_ID = "policy-coverage";
const DETECTOR_VERSION = "v1";
const SUMMARY = "Unasked architectural decision detected";
const SESSION_ID = "session-uuid-001";
const SESSION_ID_2 = "session-uuid-002";

function makeSignal(overrides: Partial<DetectionSignal> = {}): DetectionSignal {
  return {
    detectorId: DETECTOR_ID,
    detectorVersion: DETECTOR_VERSION,
    suspectedKind: "direction.decide",
    severity: "medium",
    summary: SUMMARY,
    evidence: [
      {
        kind: "file-range",
        payload: { file: "src/foo.ts", lineStart: 10, lineEnd: 20 },
      },
    ],
    contextRefs: [{ kind: "task", ref: "mt#1574" }],
    ...overrides,
  };
}

function makeContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    surface: "pre-tool",
    agentId: "claude-code:proc:abc123",
    sessionId: SESSION_ID,
    parentTaskId: "mt#1574",
    toolCall: {
      toolName: "Write",
      params: { file_path: "src/new-module.ts", content: "..." },
    },
    ...overrides,
  } as DetectionContext;
}

describe("signalToAskIntent", () => {
  describe("AT1: correct AskIntent shape from synthetic signal", () => {
    it("populates kind from suspectedKind", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.kind).toBe("direction.decide");
    });

    it("populates requestor from ctx.agentId", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.requestor).toBe("claude-code:proc:abc123");
    });

    it("populates title from signal.summary", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.title).toBe(SUMMARY);
    });

    it("populates metadata.detectorId from signal.detectorId", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.metadata.detectorId).toBe(DETECTOR_ID);
    });

    it("populates metadata.severity from signal.severity", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.metadata.severity).toBe("medium");
    });

    it("populates metadata.evidence from signal.evidence", () => {
      const signal = makeSignal();
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.metadata.evidence).toEqual(signal.evidence);
    });

    it("sets classifierVersion to detectorId@detectorVersion", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.classifierVersion).toBe(`${DETECTOR_ID}@${DETECTOR_VERSION}`);
    });

    it("uses suggestedQuestion as question when provided", () => {
      const signal = makeSignal({ suggestedQuestion: "Should we use pattern X or Y?" });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.question).toBe("Should we use pattern X or Y?");
    });

    it("falls back to summary as question when suggestedQuestion is absent", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.question).toBe(SUMMARY);
    });

    it("propagates suggestedOptions as options", () => {
      const opts = [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
      ];
      const signal = makeSignal({ suggestedOptions: opts });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.options).toEqual(opts);
    });

    it("propagates contextRefs", () => {
      const signal = makeSignal({
        contextRefs: [
          { kind: "task", ref: "mt#1574" },
          { kind: "file", ref: "src/foo.ts" },
        ],
      });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.contextRefs).toEqual(signal.contextRefs);
    });

    it("propagates parentTaskId from context", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext({ parentTaskId: "mt#9999" }));
      expect(intent.parentTaskId).toBe("mt#9999");
    });

    it("propagates sessionId as parentSessionId", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext({ sessionId: "sess-abc" }));
      expect(intent.parentSessionId).toBe("sess-abc");
    });

    it("handles authorization.approve suspectedKind", () => {
      const signal = makeSignal({ suspectedKind: "authorization.approve" });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.kind).toBe("authorization.approve");
    });

    it("handles high severity", () => {
      const signal = makeSignal({ severity: "high" });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.metadata.severity).toBe("high");
    });

    it("handles low severity", () => {
      const signal = makeSignal({ severity: "low" });
      const intent = signalToAskIntent(signal, makeContext());
      expect(intent.metadata.severity).toBe("low");
    });
  });

  describe("post-merge surface context", () => {
    it("produces valid intent from post-merge context shape", () => {
      const ctx: DetectionContext = {
        surface: "post-merge",
        agentId: "haiku:proc:xyz789",
        sessionId: SESSION_ID_2,
        transcript: { content: "agent said stuff", sessionId: SESSION_ID_2 },
      };
      const intent = signalToAskIntent(makeSignal(), ctx);
      expect(intent.requestor).toBe("haiku:proc:xyz789");
      expect(intent.parentSessionId).toBe(SESSION_ID_2);
    });
  });

  describe("missing optional fields", () => {
    it("omits options when suggestedOptions is absent", () => {
      const intent = signalToAskIntent(makeSignal(), makeContext());
      expect(intent.options).toBeUndefined();
    });

    it("omits parentTaskId when absent from context", () => {
      const ctx = makeContext({ parentTaskId: undefined });
      const intent = signalToAskIntent(makeSignal(), ctx);
      expect(intent.parentTaskId).toBeUndefined();
    });

    it("omits parentSessionId when sessionId absent from context", () => {
      const ctx = makeContext({ sessionId: undefined });
      const intent = signalToAskIntent(makeSignal(), ctx);
      expect(intent.parentSessionId).toBeUndefined();
    });
  });
});
