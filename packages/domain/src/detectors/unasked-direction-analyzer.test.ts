/**
 * Tests for the UnaskedDirectionAnalyzer.
 *
 * Acceptance:
 *   - Empty transcript → empty findings, no AI call
 *   - Schema-valid AI output is returned as-is
 *   - findingToDetectionSignal lifts a finding to the mt#1574 signal shape
 *   - Internal helpers (prompt builder, message summarizer) behave
 *
 * Note: live-AI behavior (golden / negative transcript scenarios) is exercised
 * by the post-merge hook live-verification path, not in these unit tests.
 *
 * Reference: mt#1543 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import {
  UnaskedDirectionAnalyzer,
  findingToDetectionSignal,
  DETECTOR_ID,
  DETECTOR_VERSION,
  __TEST_ONLY,
  type AnalyzerOutput,
  type UnaskedDirectionFinding,
} from "./unasked-direction-analyzer";
import type { TranscriptMessage } from "../provenance/transcript-service";
import type { DefaultAICompletionService } from "../ai/completion-service";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMessage(type: "user" | "assistant", content: string): TranscriptMessage {
  return { type, role: type, content };
}

function makeFinding(overrides: Partial<UnaskedDirectionFinding> = {}): UnaskedDirectionFinding {
  return {
    label: "chose Redis over Postgres for queue backend",
    rationale: "Spec did not name a queue backend; Redis was selected without policy citation.",
    severity: "medium",
    evidenceMessages: [12, 14],
    suggestedSignature: "ts:dependency:redis|ioredis|bullmq",
    ...overrides,
  };
}

function makeAnalyzerOutput(findings: UnaskedDirectionFinding[] = [makeFinding()]): AnalyzerOutput {
  return {
    findings,
    summary: `Session produced ${findings.length} unasked-direction finding(s).`,
  };
}

/**
 * Stub completion service. `generateObject` returns whatever output the
 * test injected; never makes a real network call.
 */
function makeStubCompletionService(output: AnalyzerOutput): DefaultAICompletionService {
  return {
    generateObject: async () => output,
  } as unknown as DefaultAICompletionService;
}

// ---------------------------------------------------------------------------
// Analyzer.analyzeTranscript
// ---------------------------------------------------------------------------

describe("UnaskedDirectionAnalyzer.analyzeTranscript", () => {
  it("short-circuits on empty transcript without calling the AI", async () => {
    let called = false;
    const stub = {
      generateObject: async () => {
        called = true;
        return makeAnalyzerOutput();
      },
    } as unknown as DefaultAICompletionService;

    const analyzer = new UnaskedDirectionAnalyzer(stub);
    const out = await analyzer.analyzeTranscript([], { sessionId: "s1" });

    expect(called).toBe(false);
    expect(out.findings).toEqual([]);
    expect(out.summary).toBe("No transcript messages available.");
  });

  it("returns the AI output unchanged when transcript has messages", async () => {
    const expected = makeAnalyzerOutput([makeFinding(), makeFinding({ severity: "high" })]);
    const analyzer = new UnaskedDirectionAnalyzer(makeStubCompletionService(expected));

    const out = await analyzer.analyzeTranscript(
      [makeMessage("user", "spec say"), makeMessage("assistant", "ok done")],
      { sessionId: "s2", taskId: "mt#1543" }
    );

    expect(out).toEqual(expected);
  });

  it("propagates AI errors", async () => {
    const failing = {
      generateObject: async () => {
        throw new Error("api went down");
      },
    } as unknown as DefaultAICompletionService;
    const analyzer = new UnaskedDirectionAnalyzer(failing);

    await expect(
      analyzer.analyzeTranscript([makeMessage("user", "x")], { sessionId: "s3" })
    ).rejects.toThrow("api went down");
  });
});

// ---------------------------------------------------------------------------
// findingToDetectionSignal
// ---------------------------------------------------------------------------

describe("findingToDetectionSignal", () => {
  it("sets suspectedKind to direction.decide", () => {
    const signal = findingToDetectionSignal(makeFinding(), { sessionId: "s1" });
    expect(signal.suspectedKind).toBe("direction.decide");
  });

  it("propagates severity", () => {
    const signal = findingToDetectionSignal(makeFinding({ severity: "high" }), { sessionId: "s1" });
    expect(signal.severity).toBe("high");
  });

  it("populates detectorId and detectorVersion from the constants", () => {
    const signal = findingToDetectionSignal(makeFinding(), { sessionId: "s1" });
    expect(signal.detectorId).toBe(DETECTOR_ID);
    expect(signal.detectorVersion).toBe(DETECTOR_VERSION);
  });

  it("emits trajectory-step + diff-snippet evidence entries", () => {
    const signal = findingToDetectionSignal(makeFinding(), { sessionId: "s1" });
    const kinds = signal.evidence.map((e) => e.kind);
    expect(kinds).toContain("trajectory-step");
    expect(kinds).toContain("diff-snippet");
  });

  it("includes a task contextRef when taskId is set", () => {
    const signal = findingToDetectionSignal(makeFinding(), {
      sessionId: "s1",
      taskId: "mt#1543",
    });
    expect(signal.contextRefs).toHaveLength(1);
    expect(signal.contextRefs[0]?.kind).toBe("task");
    expect(signal.contextRefs[0]?.ref).toBe("mt#1543");
  });

  it("returns empty contextRefs when taskId is absent", () => {
    const signal = findingToDetectionSignal(makeFinding(), { sessionId: "s1" });
    expect(signal.contextRefs).toHaveLength(0);
  });

  it("uses the rationale as suggestedQuestion", () => {
    const finding = makeFinding({ rationale: "specific phrasing matters" });
    const signal = findingToDetectionSignal(finding, { sessionId: "s1" });
    expect(signal.suggestedQuestion).toBe("specific phrasing matters");
  });
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  it("includes the session ID and task context", () => {
    const prompt = __TEST_ONLY.buildUserPrompt([makeMessage("user", "hello")], {
      sessionId: "s1",
      taskId: "mt#1543",
    });
    expect(prompt).toContain("s1");
    expect(prompt).toContain("mt#1543");
  });

  it("notes the no-task case explicitly", () => {
    const prompt = __TEST_ONLY.buildUserPrompt([makeMessage("user", "hello")], { sessionId: "s1" });
    expect(prompt).toContain("session-level analysis");
  });

  it("caps the transcript at the message-cap constant", () => {
    const many = Array.from({ length: __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP + 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `msg ${i}`)
    );
    const prompt = __TEST_ONLY.buildUserPrompt(many, { sessionId: "s1" });
    // The prompt mentions the cap explicitly
    expect(prompt).toContain(`first ${__TEST_ONLY.TRANSCRIPT_MESSAGE_CAP}`);
  });
});

describe("summarizeMessage", () => {
  it("renders a Human role for user messages", () => {
    const text = __TEST_ONLY.summarizeMessage(makeMessage("user", "hi"), 0);
    expect(text).toMatch(/Human/);
  });

  it("renders an Agent role for assistant messages", () => {
    const text = __TEST_ONLY.summarizeMessage(makeMessage("assistant", "hi"), 0);
    expect(text).toMatch(/Agent/);
  });

  it("truncates long content", () => {
    const long = "x".repeat(__TEST_ONLY.MESSAGE_TRUNCATE_CHARS + 50);
    const text = __TEST_ONLY.summarizeMessage(makeMessage("user", long), 0);
    expect(text.length).toBeLessThan(long.length + 100);
  });

  it("extracts text from structured content blocks", () => {
    const msg: TranscriptMessage = {
      type: "user",
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", source: "..." },
      ] as unknown as TranscriptMessage["content"],
    };
    const text = __TEST_ONLY.summarizeMessage(msg, 0);
    expect(text).toContain("hello");
  });
});
