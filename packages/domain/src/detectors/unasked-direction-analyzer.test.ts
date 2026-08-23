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
import { z } from "zod";
import {
  UnaskedDirectionAnalyzer,
  findingToDetectionSignal,
  describeSampling,
  selectAnalysisWindow,
  DETECTOR_ID,
  DETECTOR_VERSION,
  __TEST_ONLY,
  type AnalyzerOutput,
  type UnaskedDirectionFinding,
} from "./unasked-direction-analyzer";
import type { TranscriptMessage } from "../provenance/transcript-service";
import { NON_TEXT_MARKER, resolveMessageText } from "../provenance/transcript-content";
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

    expect(out.findings).toEqual(expected.findings);
    expect(out.summary).toEqual(expected.summary);
  });

  it("attaches the sampling record to the run (mt#4235 SC4)", async () => {
    const analyzer = new UnaskedDirectionAnalyzer(makeStubCompletionService(makeAnalyzerOutput()));

    const out = await analyzer.analyzeTranscript(
      [makeMessage("user", "spec say"), makeMessage("assistant", "ok done")],
      { sessionId: "s2" }
    );

    expect(out.sampling).toEqual({
      strategy: "text-bearing-even",
      totalMessages: 2,
      textBearingMessages: 2,
      analyzedMessages: 2,
      emptyTextRatio: 0,
      nonTextRatio: 0,
      firstIndex: 0,
      lastIndex: 1,
    });
  });

  it("records the sampling even on the empty-transcript short-circuit", async () => {
    const analyzer = new UnaskedDirectionAnalyzer(makeStubCompletionService(makeAnalyzerOutput()));
    const out = await analyzer.analyzeTranscript([], { sessionId: "s1" });

    // A run that read nothing must still SAY it read nothing, rather than producing a
    // record indistinguishable from a session the analyzer genuinely found quiet.
    expect(out.sampling.totalMessages).toBe(0);
    expect(out.sampling.analyzedMessages).toBe(0);
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

    // The prompt states how many it sampled, and renders exactly that many lines.
    expect(prompt).toContain(
      `${__TEST_ONLY.TRANSCRIPT_MESSAGE_CAP} of ${many.length} text-bearing messages`
    );
    expect(prompt).toContain("sampled evenly across the whole session");
    const rendered = prompt.split("\n").filter((line) => /^\[\d+] (Human|Agent):/.test(line));
    expect(rendered).toHaveLength(__TEST_ONLY.TRANSCRIPT_MESSAGE_CAP);
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

// ---------------------------------------------------------------------------
// The STORED shape (mt#4196)
// ---------------------------------------------------------------------------

/**
 * Every fixture above uses `makeMessage`, which builds the flat legacy shape
 * `{ type, role, content }`. Zero prod rows have that shape. That is why this whole file
 * passed for months while 496 of 496 real runs rendered as `[non-text content]`: the
 * fixtures encode the same assumption the reader made, so they can never disagree with it.
 *
 * These fixtures match what prod actually stores — the raw harness line, text nested at
 * `message.content` — sampled 2026-08-17 across the 40 most-recently-ingested rows.
 */
function makeStoredMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content: undefined, message: { role: type, content } };
}

describe("summarizeMessage on the stored transcript shape (mt#4196)", () => {
  it("AT1 — renders the text of a stored-shape string message", () => {
    const text = __TEST_ONLY.summarizeMessage(makeStoredMessage("user", "add a queue"), 0);
    expect(text).toContain("add a queue");
    expect(text).not.toContain(NON_TEXT_MARKER);
  });

  it("AT2 — concatenates text blocks from a stored-shape block array", () => {
    const msg = makeStoredMessage("assistant", [
      { type: "text", text: "chose" },
      { type: "tool_use", name: "Edit" },
      { type: "text", text: "Redis" },
    ]);
    const text = __TEST_ONLY.summarizeMessage(msg, 0);
    expect(text).toContain("chose Redis");
    expect(text).not.toContain(NON_TEXT_MARKER);
  });

  it("AT3 — still renders the legacy flat shape unchanged", () => {
    const text = __TEST_ONLY.summarizeMessage(makeMessage("user", "legacy text"), 0);
    expect(text).toContain("legacy text");
  });

  it("AT4 — a whole prompt built from stored-shape messages carries real text", () => {
    // The end of the chain, which no prior test reached: what the model actually receives.
    const messages = [
      makeStoredMessage("user", "please add caching"),
      makeStoredMessage("assistant", "added an in-memory LRU"),
      makeStoredMessage("user", "why LRU?"),
    ];
    const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });
    expect(prompt).toContain("please add caching");
    expect(prompt).toContain("added an in-memory LRU");
    expect(prompt).not.toContain(NON_TEXT_MARKER);
  });

  it("AT4 — the pre-fix rendering is the blindness signature, and is detectable", () => {
    // A transcript of stored-shape rows read the OLD way (flat `.content` only) renders
    // entirely as markers. Reading `.content` directly is what produced this.
    const storedRows = Array.from({ length: 5 }, (_, i) => makeStoredMessage("user", `msg ${i}`));
    const asTheOldCodeSawThem = storedRows.map((m) => m.content);
    expect(asTheOldCodeSawThem.every((c) => c === undefined)).toBe(true);

    const prompt = __TEST_ONLY.buildUserPrompt(storedRows, { sessionId: "s1" });
    expect(prompt).not.toContain(NON_TEXT_MARKER);
  });
});

// ---------------------------------------------------------------------------
// Window SELECTION (mt#4235)
// ---------------------------------------------------------------------------

/**
 * A tool-use-only assistant message — a real block array with no `text` block.
 *
 * This is the shape mt#4235 is about, and it is NOT the mt#4196 shape: extraction
 * SUCCEEDS here and returns `""`, so `nonTextRatio` correctly does not count it. Measured
 * over 20 real transcripts, 75–93% of every head-60 window was this.
 */
function makeToolUseOnlyMessage(name = "Edit"): TranscriptMessage {
  return makeStoredMessage("assistant", [{ type: "tool_use", name, input: {} }]);
}

describe("selectAnalysisWindow (mt#4235)", () => {
  const CAP = __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP;

  it("AT3 — reaches text-bearing messages sitting past a head of tool-use-only ones", () => {
    // The session shape the measurement found: a long tool-use preamble, decisions later.
    const preamble = Array.from({ length: CAP + 40 }, () => makeToolUseOnlyMessage());
    const decisions = [
      makeStoredMessage("assistant", "picked an in-memory LRU over Redis"),
      makeStoredMessage("user", "why LRU?"),
    ];
    const messages = [...preamble, ...decisions];

    // The pre-mt#4235 window over this same transcript carries no prose at all — so the
    // old rule could not have seen the decision no matter what the model did with it.
    const headWindow = messages.slice(0, CAP);
    expect(headWindow.every((m) => resolveMessageText(m).text.trim() === "")).toBe(true);

    const selected = selectAnalysisWindow(messages);
    expect(selected).toHaveLength(decisions.length);
    expect(selected.every(({ message }) => resolveMessageText(message).text.trim() !== "")).toBe(
      true
    );

    const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });
    expect(prompt).toContain("picked an in-memory LRU over Redis");
    expect(prompt).toContain("why LRU?");
  });

  it("spans first to last text-bearing message when it has to subsample", () => {
    // 3x the cap in text-bearing messages, so the selector must drop some. The end of a
    // session is where its decisions land, so the last one must survive.
    const messages = Array.from({ length: CAP * 3 }, (_, i) =>
      makeStoredMessage(i % 2 === 0 ? "user" : "assistant", `decision ${i}`)
    );

    const selected = selectAnalysisWindow(messages);

    expect(selected).toHaveLength(CAP);
    expect(selected[0]?.index).toBe(0);
    expect(selected[selected.length - 1]?.index).toBe(messages.length - 1);
    // Chronological and without duplicates — a repeated pick would silently shrink the
    // effective window.
    const indices = selected.map((s) => s.index);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("labels messages by TRANSCRIPT position, so evidenceMessages stay resolvable", () => {
    const messages = [
      makeToolUseOnlyMessage(),
      makeToolUseOnlyMessage(),
      makeStoredMessage("user", "the actual decision"),
    ];

    const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });

    // Position 3 in the transcript, not position 1 in the window.
    expect(prompt).toContain("[3] Human: the actual decision");
  });

  it("takes every text-bearing message when there are fewer than the cap", () => {
    const messages = [
      makeStoredMessage("user", "one"),
      makeToolUseOnlyMessage(),
      makeStoredMessage("assistant", "two"),
    ];

    expect(selectAnalysisWindow(messages).map((s) => s.index)).toEqual([0, 2]);
  });

  it("falls back to the head when nothing in the transcript carries text", () => {
    const messages = Array.from({ length: CAP + 5 }, () => makeToolUseOnlyMessage());

    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);

    expect(selected).toHaveLength(CAP);
    expect(sampling.strategy).toBe("head-fallback");
    expect(sampling.textBearingMessages).toBe(0);
    expect(sampling.emptyTextRatio).toBe(1);
  });
});

describe("describeSelection — the prompt's own account of its window (PR #3153 R1)", () => {
  const CAP = __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP;

  it("does not claim even sampling on the head-fallback path", () => {
    // R1: the note was inferred from `selected.length < messages.length`, which is TRUE here
    // and made the prompt say "sampled evenly across the whole session, skipping messages
    // with no text" — false twice over. This window is the unfiltered head and skipped nothing.
    const messages = Array.from({ length: CAP + 5 }, () => makeToolUseOnlyMessage());
    const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });

    expect(prompt).not.toContain("sampled evenly");
    expect(prompt).not.toContain("skipping messages with no text");
    expect(prompt).toContain("this is the head of the transcript, not a sample");
    expect(prompt).toContain("no message in this transcript carried extractable text");
  });

  it("says 'all' rather than 'sampled' when every text-bearing message fits", () => {
    const messages = [
      makeStoredMessage("user", "one"),
      makeToolUseOnlyMessage(),
      makeStoredMessage("assistant", "two"),
    ];
    const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });

    expect(prompt).toContain("all 2 text-bearing messages shown");
    expect(prompt).not.toContain("sampled evenly");
  });

  it("reads the recorded strategy, not the window's length", () => {
    // The three notes are a function of `sampling` alone — so the prompt and the stored
    // record cannot disagree about how the window was chosen.
    expect(
      __TEST_ONLY.describeSelection({
        strategy: "head-fallback",
        totalMessages: 100,
        textBearingMessages: 0,
        analyzedMessages: 60,
        emptyTextRatio: 1,
        nonTextRatio: 0,
        firstIndex: 0,
        lastIndex: 59,
      })
    ).toContain("not a sample");

    expect(
      __TEST_ONLY.describeSelection({
        strategy: "text-bearing-even",
        totalMessages: 500,
        textBearingMessages: 200,
        analyzedMessages: 60,
        emptyTextRatio: 0,
        nonTextRatio: 0,
        firstIndex: 0,
        lastIndex: 499,
      })
    ).toBe("60 of 200 text-bearing messages, sampled evenly across the whole session");
  });
});

describe("describeSampling (mt#4235 SC4)", () => {
  const CAP = __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP;

  it("reports a window shape that distinguishes a thin run from a full one", () => {
    // The exact pair SC4 names: 2 text-bearing messages vs a full window. A record that
    // rendered these identically is what made 496 zero-finding runs uninterpretable.
    const thin = [
      ...Array.from({ length: CAP }, () => makeToolUseOnlyMessage()),
      makeStoredMessage("user", "a"),
      makeStoredMessage("user", "b"),
    ];
    const full = Array.from({ length: CAP }, (_, i) => makeStoredMessage("user", `m${i}`));

    const thinSampling = describeSampling(thin, selectAnalysisWindow(thin));
    const fullSampling = describeSampling(full, selectAnalysisWindow(full));

    expect(thinSampling.analyzedMessages).toBe(2);
    expect(fullSampling.analyzedMessages).toBe(CAP);
    expect(thinSampling).not.toEqual(fullSampling);
  });

  it("drops the empty-text ratio the head window would have reported", () => {
    // Head window: 60 empty. New window: the 6 that carry prose. Same transcript.
    const messages = [
      ...Array.from({ length: CAP }, () => makeToolUseOnlyMessage()),
      ...Array.from({ length: 6 }, (_, i) => makeStoredMessage("user", `decision ${i}`)),
    ];

    const headWindow = messages.slice(0, CAP);
    const headEmptyRatio =
      headWindow.filter((m) => resolveMessageText(m).text.trim() === "").length / headWindow.length;

    const sampling = describeSampling(messages, selectAnalysisWindow(messages));

    expect(headEmptyRatio).toBe(1);
    expect(sampling.emptyTextRatio).toBe(0);
  });
});

describe("analyzerOutputSchema, as the provider actually receives it (mt#4317)", () => {
  /**
   * Pins the emitted JSON Schema, not the Zod object — the emitted document is what the
   * provider is sent, and the two can diverge on a Zod upgrade.
   *
   * This is control #3 of mt#4317's investigation into why the model returns objects
   * missing a required field. That whole line of work rests on the model BEING TOLD both
   * fields are mandatory; if this conversion ever stopped emitting `required`, the
   * symptom would be indistinguishable from the model ignoring an instruction it was
   * given, and every conclusion drawn from that point on would be wrong. There is no
   * other assertion anywhere that the conversion carries `required` at all.
   *
   * Field ORDER is deliberately not asserted. It was measured to matter greatly on one
   * corpus (15/40 vs 5/40, p = 0.0063) and then not at all on the next (5/40 vs 6/40,
   * p = 1.0), so pinning it would freeze a property the evidence does not currently
   * support.
   */
  const emitted = z.toJSONSchema(__TEST_ONLY.analyzerOutputSchema, { target: "draft-07" }) as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };

  it("marks both top-level fields required", () => {
    expect(emitted.required).toEqual(expect.arrayContaining(["findings", "summary"]));
    expect(emitted.required).toHaveLength(2);
  });

  it("emits both top-level properties", () => {
    expect(Object.keys(emitted.properties).sort()).toEqual(["findings", "summary"]);
  });

  it("closes the object, so an extra field is a schema violation rather than ignored", () => {
    expect(emitted.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The truncation parameter (mt#4370)
// ---------------------------------------------------------------------------

/**
 * `MESSAGE_TRUNCATE_CHARS` became a DEFAULT rather than a fixed constant so mt#4370's harness
 * can render one transcript at several truncations inside a single run. Two properties have to
 * hold for that to be a measurement rather than a change: production must be unaffected, and
 * the parameter must actually move the thing being dosed.
 *
 * The first is the one worth a test. A default parameter that silently changed the shipped
 * prompt would make every figure the experiment produces a measurement of the wrong baseline —
 * and nothing else in this file would fail, because every other test passes no argument.
 */
describe("per-message truncation is a parameter with production's value as its default (mt#4370)", () => {
  const long = "y".repeat(1_000);

  it("renders identically to the no-argument call when passed production's own value", () => {
    const withDefault = __TEST_ONLY.summarizeMessage(makeMessage("user", long), 0);
    const explicit = __TEST_ONLY.summarizeMessage(
      makeMessage("user", long),
      0,
      __TEST_ONLY.MESSAGE_TRUNCATE_CHARS
    );
    expect(explicit).toBe(withDefault);
  });

  it("shortens the rendered message when passed a smaller value", () => {
    const at400 = __TEST_ONLY.summarizeMessage(makeMessage("user", long), 0, 400);
    const at150 = __TEST_ONLY.summarizeMessage(makeMessage("user", long), 0, 150);
    expect(at150.length).toBeLessThan(at400.length);
    // The dose is the point: roughly the difference between the two caps, not an arbitrary cut.
    expect(at400.length - at150.length).toBe(250);
  });

  it("leaves a message already shorter than the cap untouched — the dosage floor", () => {
    const short = makeMessage("user", "short enough");
    expect(__TEST_ONLY.summarizeMessage(short, 0, 50)).toBe(
      __TEST_ONLY.summarizeMessage(short, 0, 400)
    );
  });

  it("threads the value through buildUserPrompt, so the whole prompt is dosed", () => {
    const messages = [makeMessage("user", long), makeMessage("assistant", long)];
    const full = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" });
    const dosed = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" }, 150);
    expect(dosed.length).toBeLessThan(full.length);
    // Two messages, each cut by 250 chars.
    expect(full.length - dosed.length).toBe(500);
  });

  it("leaves the SELECTION invariant — the sampling figures cannot score this lever", () => {
    // The finding that reshaped mt#4370's criteria: truncation runs after selection, so
    // `describeSampling`'s fields are invariant under it by construction. A future edit that
    // moved truncation before selection would silently make mt#4235's coverage figures start
    // responding to this lever, and the two tasks' measurements would stop meaning what they say.
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", long)
    );
    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);
    for (const truncate of [400, 200, 150, 50]) {
      const prompt = __TEST_ONLY.buildUserPrompt(messages, { sessionId: "s1" }, truncate);
      const rendered = prompt.split("\n").filter((line) => /^\[\d+] (Human|Agent):/.test(line));
      expect(rendered).toHaveLength(sampling.analyzedMessages);
    }
  });
});
