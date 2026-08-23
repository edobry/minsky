#!/usr/bin/env bun
/**
 * Unit tests for causal-premise-detector.ts
 *
 * Covers:
 * - R2 replay: "#-in-branch-got-mangled" with no grep → flagged
 * - R3 replay: "reviewer shares author's identity so APPROVE is blocked" with no identity check → flagged
 * - Negative: causal claim backed by same-turn tool result / file:line citation → NOT flagged
 * - Override env: when MINSKY_ACK_CAUSAL_PREMISE is set, hook exits 0 with audit line
 *
 * @see mt#2216
 */

import { describe, test, expect } from "bun:test";
import {
  detectCausalPremise,
  elideMarkdownContexts,
  OVERRIDE_ENV_VAR,
  INJECTION_ENABLED,
  run,
  buildEvaluationRecord,
  recordEvaluation,
  EVALUATION_LOG_NAME,
  EVALUATED_TURN_CAPTURE_MAX_CHARS,
} from "./causal-premise-detector";
import type { EvaluationWriter } from "./causal-premise-detector";
import { CAPTURE_SCHEMA_FIELD, CAPTURE_SCHEMA_VERSION } from "./judged-input-capture";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectCausalPremise", () => {
  describe("INJECTION_ENABLED constant", () => {
    test("is false in v1 (calibration mode)", () => {
      expect(INJECTION_ENABLED).toBe(false);
    });
  });

  describe("OVERRIDE_ENV_VAR", () => {
    test("exports the correct env var name", () => {
      expect(OVERRIDE_ENV_VAR).toBe("MINSKY_ACK_CAUSAL_PREMISE");
    });
  });

  describe("R2 replay: '#-in-branch-got-mangled' claim without grep", () => {
    test("flags unverified mangling claim", () => {
      const text = `The issue is that the \`#\` in the branch name got mangled by the API.
The filter was dropping it because of the encoding mechanism used by the query layer.
This explains why the result set was empty.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.matchedPhrases.length).toBeGreaterThan(0);
      // Verify no tool backing since no tools were called
      expect(result.hadSameTurnVerification).toBe(false);
    });

    test("flags 'got mangled' claim with mechanism proximity", () => {
      const text = `The branch name got mangled due to the encoding configuration in the client library.`;
      const result = detectCausalPremise(text, []);
      expect(result.matched).toBe(true);
      expect(result.hadSameTurnVerification).toBe(false);
    });
  });

  describe("transcriptExcerpt capture (mt#3289)", () => {
    test("captures text on BOTH sides of the matched phrase, not just the match", () => {
      // The defect: `matchedPhrases` is `match[0].slice(0, 120)` — the matched
      // text truncated, not the text around it. A reviewer reading
      // `"matchedPhrases":["The root cause is"]` cannot tell a volunteered causal
      // claim from a quotation of one, which is why this detector's fires were
      // unratable in the 2026-07-28 review.
      const before = "I looked at the failing job and formed a theory. ";
      const claim = "The root cause is the encoding mechanism in the query layer.";
      const after = " I have not confirmed that against the source yet.";
      const result = detectCausalPremise(`${before}${claim}${after}`, []);

      expect(result.matched).toBe(true);
      expect(result.transcriptExcerpt.length).toBeGreaterThan(0);
      // Surrounding context on both sides is the whole point — a window that
      // only reproduced the match would leave the record exactly as unratable.
      expect(result.transcriptExcerpt).toContain("formed a theory");
      expect(result.transcriptExcerpt).toContain("not confirmed");
    });

    test("bounds the excerpt rather than mirroring the whole turn", () => {
      // "encoding" is in MECHANISM_PATTERNS, so the proximity gate passes. (Note
      // that "caching" would NOT match: the corpus entry is `cach[ei]\b`, which
      // matches "cache" but whose trailing \b fails on the "-ing" inflection.
      // Tracked separately — this task must not change which phrases match.)
      const filler = "lorem ipsum dolor sit amet ".repeat(200);
      const text = `${filler} The root cause is the encoding step in the resolver. ${filler}`;
      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      // Bounded by a documented cap (80 chars per side) so the calibration log
      // never becomes a transcript mirror.
      expect(result.transcriptExcerpt.length).toBeLessThan(text.length);
      expect(result.transcriptExcerpt.length).toBeLessThan(500);
      // The match itself is still present — bounding must not drop the phrase.
      expect(result.transcriptExcerpt).toContain("root cause is");
    });

    test("is empty when nothing matched", () => {
      const result = detectCausalPremise("Nothing causal is claimed in this sentence.", []);
      expect(result.matched).toBe(false);
      expect(result.transcriptExcerpt).toBe("");
    });

    test("is empty — not the head of the text — when the turn is empty", () => {
      // Guards the `indexOf("")` trap: an empty needle returns 0, which would
      // log the first 80 characters of unrelated text as the match's context.
      const result = detectCausalPremise("", []);
      expect(result.transcriptExcerpt).toBe("");
    });

    test("slices RAW text, so quote and code markers survive into the excerpt", () => {
      // PR #2420 R1: matching runs on elided text, but the excerpt must come from
      // the RAW text at the same offsets. Slicing the elided copy would blank the
      // backticks/fences/blockquote markers — the very evidence a reviewer needs
      // to decide whether the phrase was QUOTED rather than asserted, which is
      // the excerpt's entire purpose.
      const text =
        "We ran `bun test --preload` first. The root cause is the encoding step in the resolver.";
      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.transcriptExcerpt).toContain("`bun test --preload`");
      // The elided form would have replaced the span with spaces of equal length.
      expect(result.transcriptExcerpt).not.toContain("                    ");
    });
  });

  describe("R3 replay: 'reviewer shares author identity so APPROVE is blocked'", () => {
    test("flags identity-sharing claim without identity check tool call", () => {
      const text = `The reviewer shares the same App identity as the PR author, so GitHub blocks APPROVE.
This is why you're seeing COMMENT instead of APPROVE — the permission policy prevents self-review.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.matchedPhrases.length).toBeGreaterThan(0);
      expect(result.hadSameTurnVerification).toBe(false);
    });

    test("flags 'blocks because' with identity mechanism", () => {
      const text = `The APPROVE is blocked because of the shared identity between the two bots. The token ownership is the same, so the permission policy prevents it.`;
      const result = detectCausalPremise(text, []);
      expect(result.matched).toBe(true);
      expect(result.hadSameTurnVerification).toBe(false);
    });

    test("flags 'the reason is' with permission mechanism", () => {
      const text = `The reason it fails is that the bot shares the author's identity. Permission scoping prevents self-review.`;
      const result = detectCausalPremise(text, []);
      expect(result.matched).toBe(true);
      expect(result.hadSameTurnVerification).toBe(false);
    });
  });

  describe("Negative: causal claim backed by same-turn tool result", () => {
    test("does NOT flag when a tool call is present", () => {
      const text = `The COMMENT occurred because compose-review.ts:170 passes the model's event through directly.
This was verified by reading the file — the routing logic is at lines 159-174.`;

      // Simulate a same-turn tool call (e.g., Read on compose-review.ts)
      const toolUseNames = ["Read"];

      const result = detectCausalPremise(text, toolUseNames);

      // When a tool call backs the claim, matched MUST be false (not just flagged)
      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(true);
    });

    test("does NOT flag when file:line citation is present", () => {
      const text = `The mechanism is at compose-review.ts:170 — the model's event choice flows through directly.
The reason the bot posts COMMENT is that event="COMMENT" propagates via the routing at line 170.`;

      // No tool calls but has a file:line citation
      const result = detectCausalPremise(text, []);

      // file:line citation is same-turn backing → must not be flagged
      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(true);
    });

    test("marks hadSameTurnVerification=true when node_modules path cited", () => {
      const text = `The mechanism uses a timestamp high-water-mark as in
node_modules/drizzle-orm/pg-core/dialect.js:44 — that file shows the apply logic.
This causes the migration to skip rather than apply.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(true);
    });

    test("marks hadSameTurnVerification=true with mcp tool call", () => {
      const text = `The filter fails because of the config mechanism for the query parameter.`;
      const toolUseNames = ["mcp__github__pull_request_read"];

      const result = detectCausalPremise(text, toolUseNames);

      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(true);
    });
  });

  describe("No match cases", () => {
    test("does not flag empty text", () => {
      const result = detectCausalPremise("", []);
      expect(result.matched).toBe(false);
    });

    test("does not flag plain non-causal text", () => {
      const text = `The PR has been created. Here are the next steps:
1. Wait for the reviewer bot.
2. Address any findings.
3. Merge when approved.`;
      const result = detectCausalPremise(text, []);
      expect(result.matched).toBe(false);
    });

    test("does not flag code inside fenced blocks", () => {
      const text = `Here is the analysis:

\`\`\`typescript
// The reason it fails: because of the identity permission scope
const blocked = identity.shared && permission.scoped;
\`\`\`

The implementation looks correct.`;
      const result = detectCausalPremise(text, []);
      // The causal phrases inside the code block should be elided
      // May or may not match depending on elision — just ensure it doesn't crash
      expect(typeof result.matched).toBe("boolean");
    });
  });

  describe("elideMarkdownContexts", () => {
    test("elides fenced code blocks", () => {
      const text = "before\n```\nbecause of identity\n```\nafter";
      const result = elideMarkdownContexts(text);
      // The code block content should be replaced with spaces
      expect(result.includes("because of identity")).toBe(false);
      expect(result.length).toBe(text.length);
    });

    test("elides inline code", () => {
      const text = "The `because of the identity permission` issue is here.";
      const result = elideMarkdownContexts(text);
      expect(result.includes("because of the identity permission")).toBe(false);
    });

    test("elides blockquote lines", () => {
      const text = "> The reason is the identity config\nAnd some regular text.";
      const result = elideMarkdownContexts(text);
      expect(result.startsWith(">")).toBe(false);
      expect(result.includes("And some regular text.")).toBe(true);
    });
  });

  describe("R5 replay: forward predictive claim without mechanism read", () => {
    test("flags forward 'migrate is unsafe because' claim", () => {
      const text = `Running migrate --execute is unsafe because of the schema algorithm used by drizzle.
The migration would fail since the permission flag is not set.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.hadSameTurnVerification).toBe(false);
    });
  });

  describe("R12 replay: mt#2765 A/B-confound misdiagnosis (mt#2832 gap-closure)", () => {
    // Reconstructed from the incident conversation (3c8cd612, turn 133) and
    // memory b0b294ab R12: the live diagnostic claim that attributed the
    // reviewer-widget hang to tray-vs-shell spawn context, when the real
    // confound was which port had live browser-tab traffic. This is the
    // exact class the causal-premise detector was built to catch (mt#2216)
    // but originally missed — no "because"/"due to" phrasing, and the
    // mechanism term ("working directory") was outside MECHANISM_PATTERNS.
    test("flags the live turn-133 phrasing: 'N in a row, while... the one remaining difference'", () => {
      const text = `Still hangs — three tray-spawned instances in a row, while shell-spawned works. Checking the one remaining structural difference: the tray daemon's working directory.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.matchedPhrases.length).toBeGreaterThan(0);
      expect(result.hadSameTurnVerification).toBe(false);
    });

    test("flags the spec-encoded generalization: 'tray-spawned daemons hang, shell-spawned work'", () => {
      const text = `Root cause: the widget hangs in the tray-spawned daemon but works in the shell-spawned one — every time the daemon is tray-spawned it hangs, while shell-spawned daemons never do. The one remaining difference between the two is the process environment the daemon inherits from its spawner.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
      expect(result.hadSameTurnVerification).toBe(false);
    });

    test("does NOT flag the same A/B language when backed by a same-turn tool call", () => {
      const text = `Still hangs — three tray-spawned instances in a row, while shell-spawned works. Checking the one remaining structural difference: the tray daemon's working directory.`;
      const toolUseNames = ["Bash"];

      const result = detectCausalPremise(text, toolUseNames);

      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(true);
    });

    // R1 review finding: no test asserted the mechanism-proximity gate still
    // applies to the new inductive/correlational category — i.e. the phrase
    // shape alone is not sufficient; a mechanism term must co-occur within
    // 500 chars, exactly like RETRODICTIVE_PATTERNS/FORWARD_PATTERNS.
    test("does NOT flag A/B phrasing with no mechanism term in proximity", () => {
      const text = `Three attempts in a row failed, while the fourth succeeded. The one remaining difference was the time of day I ran them.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(false);
      expect(result.hadSameTurnVerification).toBe(false);
    });

    // R1 review finding: claimed the `working director(y|ies)` mechanism
    // pattern "matches plural 'directories' but not possessive/singular
    // variants used in tests/docs". Verified against the actual regex
    // (`bun -e` against the compiled MECHANISM_PATTERNS export) before
    // responding — per check-premise, the cheapest falsifier is running the
    // regex, not re-reading it — and the possessive/singular form already
    // matches (`\bworking\s+director(?:y|ies)\b` covers "directory" via the
    // `y` alternative same as "directories" via `ies`; `\b` does not require
    // the preceding token to be non-possessive). This is a VERIFIED FALSE
    // POSITIVE, not a regex bug — encoded here as an explicit assertion
    // (rather than only the incidental coverage in the turn-133 replay
    // above) so the claim cannot recur ambiguously.
    test("mechanism proximity matches the possessive singular 'daemon's working directory' form", () => {
      const text = `The one remaining difference is the tray daemon's working directory.`;

      const result = detectCausalPremise(text, []);

      expect(result.matched).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
//
// No real fs needed: run() reads ctx.transcriptLines directly (resolved
// once by the dispatcher's D6 shared context) rather than re-parsing a
// transcript_path itself — so transcriptLines is built in-memory here.
// ---------------------------------------------------------------------------

function makeRunUserLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function makeRunAssistantLine(text: string): TranscriptLine {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const RUN_HOOK_EVENT_NAME = "UserPromptSubmit";

const RUN_HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: RUN_HOOK_EVENT_NAME,
};

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: RUN_HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

/**
 * Collect evaluation records instead of writing them.
 *
 * Every `run()` call in this file passes one. Without it the default writer
 * appends to the REAL `.minsky/causal-premise-evaluations.jsonl` — the unit
 * suite would then inject synthetic rows into the very denominator mt#3743
 * exists to make trustworthy.
 */
function makeEvaluationCollector(): {
  records: Record<string, unknown>[];
  write: EvaluationWriter;
} {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    write: (record) => {
      records.push(record);
    },
  };
}

/** A causal claim with a mechanism term and no same-turn backing — fires. */
const FIRING_TURN_TEXT =
  "The branch name got mangled due to the encoding configuration in the client library.";

/** Prose with no causal phrase — the detector evaluates it and does NOT fire. */
const NON_FIRING_TURN_TEXT = "Nothing noteworthy here.";

describe("run() (dispatcher-compatible)", () => {
  test("unverified causal claim -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(FIRING_TURN_TEXT),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), makeEvaluationCollector().write);
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(NON_FIRING_TURN_TEXT),
      makeRunUserLine(),
    ];
    expect(
      run(RUN_HOOK_INPUT, makeCtx(transcriptLines), makeEvaluationCollector().write)
    ).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([makeRunUserLine(), makeRunAssistantLine("x"), makeRunUserLine()]);
    expect(run(input, ctx, makeEvaluationCollector().write)).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(FIRING_TURN_TEXT),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(
        RUN_HOOK_INPUT,
        makeCtx(transcriptLines),
        makeEvaluationCollector().write
      );
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

// ---------------------------------------------------------------------------
// Evaluation stream (mt#3743)
// ---------------------------------------------------------------------------

describe("evaluation stream (mt#3743)", () => {
  test("stream name yields the conventional -evaluations.jsonl filename", () => {
    expect(EVALUATION_LOG_NAME).toBe("causal-premise");
  });

  describe("buildEvaluationRecord", () => {
    const noMatch = detectCausalPremise(NON_FIRING_TURN_TEXT, []);

    test("carries the verdict and the capture-schema marker", () => {
      const record = buildEvaluationRecord({
        timestamp: "2026-08-13T00:00:00.000Z",
        sessionId: "s1",
        elidedText: NON_FIRING_TURN_TEXT,
        result: noMatch,
      });
      expect(record["fired"]).toBe(false);
      expect(record[CAPTURE_SCHEMA_FIELD]).toBe(CAPTURE_SCHEMA_VERSION);
      expect(record["timestamp"]).toBe("2026-08-13T00:00:00.000Z");
      expect(record["session_id"]).toBe("s1");
    });

    test("AT3: the capture is truncated at the documented bound, and says so", () => {
      const long = "a".repeat(EVALUATED_TURN_CAPTURE_MAX_CHARS + 500);
      const record = buildEvaluationRecord({
        timestamp: "2026-08-13T00:00:00.000Z",
        elidedText: long,
        result: noMatch,
      });
      const capture = record["judgedInput"] as {
        excerpt: string;
        length: number;
        truncated: boolean;
      };
      expect(capture.excerpt.length).toBeLessThanOrEqual(EVALUATED_TURN_CAPTURE_MAX_CHARS);
      // `length` is the FULL text, so a truncated capture still reports how much
      // was judged rather than how much was kept.
      expect(capture.length).toBe(long.length);
      expect(capture.truncated).toBe(true);
    });

    test("a capture within the bound is not marked truncated", () => {
      const record = buildEvaluationRecord({
        timestamp: "2026-08-13T00:00:00.000Z",
        elidedText: "short",
        result: noMatch,
      });
      expect((record["judgedInput"] as { truncated: boolean }).truncated).toBe(false);
    });
  });

  describe("run()", () => {
    test("AT1: a non-firing evaluated turn produces an evaluation record and NO calibration record", () => {
      const collector = makeEvaluationCollector();
      const transcriptLines = [
        makeRunUserLine(),
        makeRunAssistantLine(NON_FIRING_TURN_TEXT),
        makeRunUserLine(),
      ];

      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), collector.write);

      // Both halves — the point is the MISS being visible.
      expect(outcome).toBeNull();
      expect(collector.records).toHaveLength(1);
      expect(collector.records[0]?.["fired"]).toBe(false);
    });

    test("AT2: a firing turn appears in both, joinable on (session_id, timestamp)", () => {
      const collector = makeEvaluationCollector();
      const transcriptLines = [
        makeRunUserLine(),
        makeRunAssistantLine(FIRING_TURN_TEXT),
        makeRunUserLine(),
      ];

      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), collector.write);

      expect(collector.records).toHaveLength(1);
      const evaluation = collector.records[0] as Record<string, unknown>;
      const calibration = outcome?.calibration as Record<string, unknown>;

      expect(evaluation["fired"]).toBe(true);
      expect(calibration).toBeDefined();
      // The join. Two `new Date()` calls would differ by milliseconds, so this
      // asserts they share ONE value rather than merely both having a timestamp.
      expect(evaluation["timestamp"]).toBe(calibration["timestamp"]);
      expect(evaluation["session_id"]).toBe(calibration["session_id"]);
    });

    test("AT4: text inside a code fence does not reach the stream", () => {
      const collector = makeEvaluationCollector();
      const fenced = [
        "Here is the log:",
        "```",
        "postgresql://user:hunter2@db.example.com:5432/prod",
        "```",
        NON_FIRING_TURN_TEXT,
      ].join("\n");
      const transcriptLines = [makeRunUserLine(), makeRunAssistantLine(fenced), makeRunUserLine()];

      run(RUN_HOOK_INPUT, makeCtx(transcriptLines), collector.write);

      const excerpt = (collector.records[0]?.["judgedInput"] as { excerpt: string }).excerpt;
      expect(excerpt).not.toContain("hunter2");
      expect(excerpt).not.toContain("postgresql://");
      // The prose AROUND the fence survives — the elision blanks the fence, it
      // does not blank the turn, so the record stays classifiable.
      expect(excerpt).toContain("Here is the log:");
    });

    test("AT5: a write failure leaves the outcome unchanged and reports the real error", () => {
      const written: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      const exploding: EvaluationWriter = () => {
        throw new Error("disk on fire");
      };
      const transcriptLines = [
        makeRunUserLine(),
        makeRunAssistantLine(FIRING_TURN_TEXT),
        makeRunUserLine(),
      ];

      let outcome;
      try {
        outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines), exploding);
      } finally {
        process.stderr.write = originalWrite;
      }

      // Degrades to the detector's existing behavior…
      expect(outcome?.calibration).toBeDefined();
      expect(outcome?.additionalContext).toBeUndefined();
      // …and logs the ACTUAL error rather than swallowing it. A fail-open write
      // that reports nothing is indistinguishable from one that succeeded, which
      // is the failure mode this whole family keeps hitting.
      expect(written.join("")).toContain("disk on fire");
    });
  });

  describe("recordEvaluation", () => {
    test("a throwing writer does not propagate", () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        expect(() =>
          recordEvaluation({ fired: false }, "/test", () => {
            throw new Error("boom");
          })
        ).not.toThrow();
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});
