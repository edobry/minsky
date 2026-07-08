// Tests for the code-mechanism-assertion-detector hook (mt#2486).
//
// Pure-function coverage: detectCodeMechanismAssertion (claim + corpus),
// buildVerificationCorpus (tool inputs + tool_result content), and
// elideBlocksAndQuotes. The canonical case is R9 (PR #1694): a maxBuffer/
// executeCommand behavioral claim made without reading exec.ts.

import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  buildVerificationCorpus,
  elideBlocksAndQuotes,
  OVERRIDE_ENV_VAR,
  INJECTION_ENABLED,
  run,
} from "./code-mechanism-assertion-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// A realistic slice of exec.ts source — what a Read of the file would return.
const EXEC_TS_SOURCE = `export async function executeCommand(command, options = {}) {
  const execOptions = { encoding: "utf8", maxBuffer: 1024 * 1024 * 10, killSignal: "SIGTERM" };
  return promisifiedExec(command, execOptions);
}`;

describe("detectCodeMechanismAssertion", () => {
  test("R9 canonical: maxBuffer/executeCommand behavioral claim with NO same-turn read → fires", () => {
    const text =
      "Diagnosing the pre-commit failure: the 1MB default `maxBuffer` is at its limit, " +
      "and `executeCommand` clamps it — so I shipped a 64MB override.";
    const result = detectCodeMechanismAssertion(text, /* corpus */ "");
    expect(result.matched).toBe(true);
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("executeCommand");
  });

  test("same-turn Read of the symbol's file (source in tool_result corpus) → does NOT fire", () => {
    const text = "`executeCommand` clamps `maxBuffer` to 10MB.";
    // The file source landed in a same-turn tool_result; both symbols appear in it.
    const result = detectCodeMechanismAssertion(text, EXEC_TS_SOURCE);
    expect(result.matched).toBe(false);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("backing via read-class tool INPUT (grep pattern names the symbol) → does NOT fire", () => {
    const text = "The `parseBranchProtectionResponse` helper returns null on a parse error.";
    const result = detectCodeMechanismAssertion(text, "grep -n parseBranchProtectionResponse src/");
    expect(result.matched).toBe(false);
  });

  test("generic prose with no named symbol near a predicate → does NOT fire", () => {
    const text = "The build passed and all 138 tests are green; nothing else to report.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("symbol+predicate only inside a fenced code block → does NOT fire", () => {
    const text =
      "Here is the relevant code:\n\n```ts\nexecuteCommand clamps maxBuffer to 10MB\n```\n\nThat is all.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("symbol+predicate inside a blockquote (quoted, not asserted) → does NOT fire", () => {
    const text = "> executeCommand clamps maxBuffer to 10MB\n\nNoted from the doc.";
    expect(detectCodeMechanismAssertion(text, "").matched).toBe(false);
  });

  test("empty assistant text → does NOT fire", () => {
    expect(detectCodeMechanismAssertion("", "").matched).toBe(false);
  });

  test("a partially-backed turn still fires on the UNread symbol", () => {
    // executeCommand was read (in corpus); maxBuffer's behavior is claimed but
    // the symbol is NOT in the corpus → the unread symbol still fires.
    const text = "`executeCommand` is fine, but `unreadHelper` defaults to retrying forever.";
    const result = detectCodeMechanismAssertion(text, "export function executeCommand() {}");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain("unreadHelper");
  });

  test("backticked file path does NOT yield its extension as a claim symbol (R1)", () => {
    // `exec.ts` must not produce "ts"/"json" as a symbol (the removed
    // last-segment fallback). The full token may appear; the extension must not.
    const text = "The `exec.ts` module returns a config object.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).not.toContain("ts");
    expect(syms).not.toContain("json");
  });
});

describe("mt#2673 — truncated-substring extraction + backed-claim accounting", () => {
  const SESSION_PR_DRIVE = "session_pr_drive";

  test("AT2: window boundary cutting through the identifier yields the full symbol, no truncated tails", () => {
    // Position the identifier so the predicate's ±100-char proximity
    // window starts MID-IDENTIFIER — the 2026-07-07 calibration records'
    // "ion_pr_drive"/"on_pr_drive" bug shape.
    const sym = SESSION_PR_DRIVE;
    const text = `intro text here. ${sym} ${"z".repeat(90)} returns null when the input is missing.`;
    const anchor = text.indexOf("returns");
    // Sanity: the window cut (anchor - 100) lands inside the symbol.
    const symStart = text.indexOf(sym);
    expect(anchor - 100).toBeGreaterThan(symStart);
    expect(anchor - 100).toBeLessThan(symStart + sym.length);

    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain(sym);
    for (const s of syms) {
      expect(s === sym || !sym.endsWith(s)).toBe(true);
    }
    expect(syms).not.toContain("ion_pr_drive");
    expect(syms).not.toContain("on_pr_drive");
  });

  test("AT2: one identifier mention yields exactly one claim for that identifier per predicate", () => {
    const text = "The `session_pr_drive` helper returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(text, "");
    const driveClaims = result.claims.filter((c) => c.symbol.includes("pr_drive"));
    expect(driveClaims.length).toBe(1);
    expect(driveClaims[0]?.symbol).toBe(SESSION_PR_DRIVE);
  });

  test("AT1: symbol present in the verification corpus → no claim logged, backedClaimCount >= 1", () => {
    const text = "`session_pr_drive` returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(
      text,
      "export async function session_pr_drive() { /* read this turn */ }"
    );
    expect(result.claims.map((c) => c.symbol)).not.toContain(SESSION_PR_DRIVE);
    expect(result.backedClaimCount).toBeGreaterThanOrEqual(1);
    expect(result.hadSameTurnRead).toBe(true);
  });

  test("AT1: symbol NOT in the corpus → fires with the claim and backedClaimCount 0", () => {
    const text = "`session_pr_drive` returns null when the PR is already merged.";
    const result = detectCodeMechanismAssertion(text, "unrelated corpus content");
    expect(result.matched).toBe(true);
    expect(result.claims.map((c) => c.symbol)).toContain(SESSION_PR_DRIVE);
    expect(result.backedClaimCount).toBe(0);
    expect(result.hadSameTurnRead).toBe(false);
  });

  test("proper-substring dedup does not eliminate equal-length case variants", () => {
    // Both `maxBuffer` and `MaxBuffer` near a predicate: neither is a PROPER
    // substring of the other, so neither is dropped by the dedup filter.
    const text = "`maxBuffer` and `MaxBuffer` default to 1MB in this module.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("MaxBuffer");
  });

  test("R1: separately-mentioned substring symbols are BOTH kept (`drive` alongside `session_pr_drive`)", () => {
    // PR #1835 R1 blocking finding: dedup must target truncation residues
    // (same-class strict range containment), not distinct mentions that
    // happen to be substrings.
    const text = "`drive` and `session_pr_drive` return null when the target is missing.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("drive");
    expect(syms).toContain(SESSION_PR_DRIVE);
  });

  test("R1: camel sub-identifier inside a backticked dotted token is kept (different class)", () => {
    // Documented behavior (symbolsNear header): `maxBuffer` inside
    // `cfg.maxBuffer` is captured independently — cross-class containment
    // must not dedup it away.
    const text = "The `cfg.maxBuffer` value defaults to 1MB here.";
    const result = detectCodeMechanismAssertion(text, "");
    const syms = result.claims.map((c) => c.symbol);
    expect(syms).toContain("maxBuffer");
    expect(syms).toContain("cfg.maxBuffer");
  });
});

describe("buildVerificationCorpus", () => {
  test("captures read-class tool_use INPUT and tool_result CONTENT; ignores non-read inputs", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "packages/shared/src/exec.ts" } },
            // a non-read tool's input must NOT enter the corpus
            { type: "tool_use", name: "session_commit", input: { message: "secretMessageSymbol" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: EXEC_TS_SOURCE }],
        },
      },
    ];
    const corpus = buildVerificationCorpus(turn);
    expect(corpus).toContain("exec.ts"); // read-class input path
    expect(corpus).toContain("executeCommand"); // tool_result file content
    expect(corpus).not.toContain("secretMessageSymbol"); // non-read input excluded
  });

  test("Bash tool input is NOT collected (Bash is not read-class) (R1)", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "echo unrelatedSymbol" } }],
        },
      },
    ];
    // Bash input string must not enter the corpus → an unread-symbol claim still fires.
    expect(buildVerificationCorpus(turn)).not.toContain("unrelatedSymbol");
  });

  test("assistant-echoed tool_result block is NOT counted as backing (R1)", () => {
    const turn: TranscriptLine[] = [
      {
        // assistant-role line carrying a tool_result-typed block (echo / malformed)
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_result", content: "executeCommand clamps maxBuffer" }],
        },
      },
    ];
    // Role-gating: tool_result content is only authentic on USER-role lines.
    expect(buildVerificationCorpus(turn)).toBe("");
  });

  test("empty turn → empty corpus", () => {
    expect(buildVerificationCorpus([])).toBe("");
  });
});

describe("elideBlocksAndQuotes", () => {
  test("elides fenced blocks and blockquotes but KEEPS inline code", () => {
    const text = "Use `executeCommand` here.\n\n```\nfenced executeCommand\n```\n\n> quoted line";
    const out = elideBlocksAndQuotes(text);
    expect(out).toContain("`executeCommand`"); // inline kept
    expect(out).not.toContain("fenced executeCommand"); // fenced elided
    expect(out).not.toContain("quoted line"); // blockquote elided
    expect(out.length).toBe(text.length); // positions preserved
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
  test("unread code-mechanism claim -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine(
        "The 1MB default `maxBuffer` is at its limit, and `executeCommand` clamps it."
      ),
      makeRunUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
    expect(INJECTION_ENABLED).toBe(false);
    const cal = outcome?.calibration as { claims: Array<{ symbol: string; predicate: string }> };
    expect(cal.claims.map((c) => c.symbol)).toContain("maxBuffer");
  });

  test("no match -> null (silent allow)", () => {
    const transcriptLines = [
      makeRunUserLine(),
      makeRunAssistantLine("The build passed and all tests are green."),
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
      makeRunAssistantLine("`executeCommand` clamps `maxBuffer` to 10MB."),
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
