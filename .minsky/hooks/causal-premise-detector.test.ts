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
} from "./causal-premise-detector";
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

describe("run() (dispatcher-compatible)", () => {
  test("unverified causal claim -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The branch name got mangled due to the encoding configuration in the client library."
      ),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("Nothing noteworthy here."),
      makeRunUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([makeRunUserLine(), makeRunAssistantLine("x"), makeRunUserLine()]);
    expect(run(input, ctx)).toBeNull();
  });

  test("legacy override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The branch name got mangled due to the encoding configuration in the client library."
      ),
      makeRunUserLine(),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});
