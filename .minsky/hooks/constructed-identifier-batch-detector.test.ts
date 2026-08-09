import { describe, expect, test } from "bun:test";
import {
  MINT_TOOL_NAMES,
  CONSUME_TOOL_SPECS,
  extractToolUseBlocksByMessage,
  detectBatchedMintAndConsume,
  detectConsumeBeforeMint,
  buildReminder,
  buildConsumeBeforeMintReminder,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
  type BatchMatch,
  type ToolUseBlock,
} from "./constructed-identifier-batch-detector";
import { captureArtifact } from "./judged-input-capture";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { extractDistinctPhrases } from "../../src/domain/calibration/calibration-sweep";

/** Shared so the excerpt and its judged-capture cannot drift apart (mt#2900). */
const COMMIT_MESSAGE_EXCERPT = "fix(mt#9999): resolve the bug";

// ---------------------------------------------------------------------------
// Tool-name constants (custom/no-magic-string-duplication — each of these is
// reused across many test cases below; a single source of truth avoids a
// typo-drift risk across the duplicates).
// ---------------------------------------------------------------------------

const TASKS_CREATE = "mcp__minsky__tasks_create";
const SESSION_START = "mcp__minsky__session_start";
const SESSION_COMMIT = "mcp__minsky__session_commit";
const SESSION_PR_CREATE = "mcp__minsky__session_pr_create";
const SESSION_PR_EDIT = "mcp__minsky__session_pr_edit";
const ASKS_CREATE = "mcp__minsky__asks_create";
const MEMORY_CREATE = "mcp__minsky__memory_create";
const TASKS_SPEC_PATCH = "mcp__minsky__tasks_spec_patch";
const TASKS_STATUS_GET = "mcp__minsky__tasks_status_get";
const SESSION_GET = "mcp__minsky__session_get";

// ---------------------------------------------------------------------------
// Transcript fixture helpers
// ---------------------------------------------------------------------------

function makeUserLine(text = "test user message"): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } } as TranscriptLine;
}

/** One assistant message carrying multiple tool_use blocks — a real parallel batch. */
function makeBatchedAssistantLine(
  calls: Array<{ name: string; input: Record<string, unknown> }>
): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "tool_use", name: c.name, input: c.input })),
    },
  } as TranscriptLine;
}

/** One assistant message carrying exactly one tool_use block. */
function makeSingleAssistantLine(name: string, input: Record<string, unknown>): TranscriptLine {
  return makeBatchedAssistantLine([{ name, input }]);
}

function makeToolResultLine(): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
  } as TranscriptLine;
}

// ---------------------------------------------------------------------------
// extractToolUseBlocksByMessage — the "same tool block" grouping
// ---------------------------------------------------------------------------

describe("extractToolUseBlocksByMessage", () => {
  test("groups multiple tool_use blocks from one assistant message together", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "x" } },
        { name: SESSION_COMMIT, input: { message: "feat: x" } },
      ]),
    ];
    const groups = extractToolUseBlocksByMessage(turn);
    expect(groups.length).toBe(1);
    expect(groups[0]?.length).toBe(2);
  });

  test("separate assistant messages (a tool-result round-trip apart) produce separate groups", () => {
    const turn: TranscriptLine[] = [
      makeSingleAssistantLine(TASKS_CREATE, { title: "x" }),
      makeToolResultLine(),
      makeSingleAssistantLine(SESSION_COMMIT, { message: "feat: x" }),
    ];
    const groups = extractToolUseBlocksByMessage(turn);
    expect(groups.length).toBe(2);
    expect(groups[0]?.length).toBe(1);
    expect(groups[1]?.length).toBe(1);
  });

  test("assistant text-only message (no tool_use) is excluded", () => {
    const turn: TranscriptLine[] = [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      } as TranscriptLine,
    ];
    expect(extractToolUseBlocksByMessage(turn)).toEqual([]);
  });

  // PR #2244 R1: explicit regression proving a non-assistant line's tool_use-
  // shaped content is NEVER extracted, regardless of `type`/`message.role`
  // combination -- direct empirical evidence for the assistant-line
  // discriminator (isAssistantLine), not just code-reading.
  test("a non-assistant line carrying a tool_use-shaped block is NEVER extracted", () => {
    const nonAssistantShapes: TranscriptLine[] = [
      // type is neither "assistant" nor matches role; role is "user"
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_use", name: TASKS_CREATE, input: {} }] },
      } as TranscriptLine,
      // type undefined, role is something other than "assistant"
      {
        message: { role: "system", content: [{ type: "tool_use", name: TASKS_CREATE, input: {} }] },
      } as TranscriptLine,
      // type is some non-assistant tag, message entirely absent
      { type: "tool_use", name: TASKS_CREATE, input: {} } as TranscriptLine,
    ];
    for (const line of nonAssistantShapes) {
      expect(extractToolUseBlocksByMessage([line])).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Category membership
// ---------------------------------------------------------------------------

describe("category definitions", () => {
  test("MINT_TOOL_NAMES covers both MCP-prefixed and bare forms", () => {
    expect(MINT_TOOL_NAMES.has(TASKS_CREATE)).toBe(true);
    expect(MINT_TOOL_NAMES.has("tasks_create")).toBe(true);
    expect(MINT_TOOL_NAMES.has(SESSION_START)).toBe(true);
    expect(MINT_TOOL_NAMES.has(SESSION_PR_CREATE)).toBe(true);
    expect(MINT_TOOL_NAMES.has(ASKS_CREATE)).toBe(true);
    expect(MINT_TOOL_NAMES.has(MEMORY_CREATE)).toBe(true);
  });

  test("MINT_TOOL_NAMES excludes read-only tools", () => {
    expect(MINT_TOOL_NAMES.has(TASKS_STATUS_GET)).toBe(false);
    expect(MINT_TOOL_NAMES.has(SESSION_GET)).toBe(false);
  });

  test("CONSUME_TOOL_SPECS names the documented field for each tool", () => {
    const byName = (n: string): string | undefined =>
      CONSUME_TOOL_SPECS.find((s) => s.names.includes(n))?.field;
    expect(byName(SESSION_COMMIT)).toBe("message");
    expect(byName(SESSION_PR_CREATE)).toBe("body");
    expect(byName(SESSION_PR_EDIT)).toBe("body");
    expect(byName(TASKS_SPEC_PATCH)).toBe("content");
    expect(byName(MEMORY_CREATE)).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// detectBatchedMintAndConsume — Acceptance Test 1 shape (mint + consume batched)
// ---------------------------------------------------------------------------

describe("diversity axis (mt#3781)", () => {
  // Driven through `run()` — the dispatcher-facing entry point that actually
  // builds the record in production — rather than the module-private projection.
  const calibrationFor = (message: string): { matches: Array<Record<string, unknown>> } => {
    const outcome = run(
      RUN_HOOK_INPUT,
      makeCtx([
        makeUserLine(),
        makeBatchedAssistantLine([
          { name: TASKS_CREATE, input: { title: "Fix the bug" } },
          { name: SESSION_COMMIT, input: { message } },
        ]),
        makeUserLine(),
      ])
    );
    return outcome?.calibration as { matches: Array<Record<string, unknown>> };
  };

  // AT1 for THIS detector. It is categorical, so two fires of the same
  // (mint, consume, field) shape are one pattern however different their text —
  // the exact case a text-valued `phrase` could never collapse.
  test("AT1: two fires of the same tool shape collapse to one distinct phrase", () => {
    const parsed = [
      calibrationFor("fix(mt#1): first commit message"),
      calibrationFor("chore(mt#2): an entirely different message"),
    ].map(
      (r) => JSON.parse(JSON.stringify(r)) as Parameters<typeof extractDistinctPhrases>[0][number]
    );

    expect(extractDistinctPhrases(parsed).size).toBe(1);
  });

  // AT2 — the judged text is still recoverable, via mt#3607's capture, so
  // moving `phrase` off the excerpt costs the record no classifiability.
  test("AT2: the judged text survives under the capture, not under `phrase`", () => {
    const cal = calibrationFor("fix(mt#1): a distinctive commit message") as {
      matches: Array<{ phrase: string; judged?: { excerpt: string } }>;
    };

    expect(cal.matches[0]?.judged?.excerpt).toContain("a distinctive commit message");
    expect(cal.matches[0]?.phrase).not.toContain("a distinctive commit message");
    expect(cal.matches[0]?.phrase).toBe(`${TASKS_CREATE}|${SESSION_COMMIT}|message`);
  });
});

describe("detectBatchedMintAndConsume — positive cases", () => {
  test("AT1: tasks_create batched with session_commit fires a match", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "Fix the bug" } },
        {
          name: SESSION_COMMIT,
          input: { message: "fix(mt#9999): resolve the bug", all: true },
        },
      ]),
    ];
    const matches = detectBatchedMintAndConsume(turn);
    expect(matches.length).toBe(1);
    expect(matches[0]).toMatchObject({
      mintTool: TASKS_CREATE,
      consumeTool: SESSION_COMMIT,
      consumeField: "message",
    });
  });

  test("session_start batched with a session_pr_create body fires a match", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: SESSION_START, input: { task: "mt#1" } },
        { name: SESSION_PR_CREATE, input: { title: "x", body: "## Summary\n..." } },
      ]),
    ];
    const matches = detectBatchedMintAndConsume(turn);
    expect(matches.some((m) => m.mintTool === SESSION_START)).toBe(true);
  });

  test("asks_create batched with memory_create content fires a match", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: ASKS_CREATE, input: { question: "?" } },
        { name: MEMORY_CREATE, input: { name: "x", content: "notes about ask" } },
      ]),
    ];
    const matches = detectBatchedMintAndConsume(turn);
    expect(matches.some((m) => m.mintTool === ASKS_CREATE)).toBe(true);
  });

  test("tasks_spec_patch as consumer is detected", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "child" } },
        {
          name: TASKS_SPEC_PATCH,
          input: { taskId: "mt#1", content: "// ... existing code ...\nrelates to child" },
        },
      ]),
    ];
    const matches = detectBatchedMintAndConsume(turn);
    expect(matches.some((m) => m.consumeTool === TASKS_SPEC_PATCH)).toBe(true);
  });

  test("deduplicates repeated (mintTool, consumeTool, field) triples within one batch", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "a" } },
        { name: TASKS_CREATE, input: { title: "b" } },
        { name: SESSION_COMMIT, input: { message: "feat: a and b" } },
      ]),
    ];
    const matches = detectBatchedMintAndConsume(turn);
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectBatchedMintAndConsume — Acceptance Test 2 shape (independent reads, no match)
// ---------------------------------------------------------------------------

describe("detectBatchedMintAndConsume — negative cases", () => {
  test("AT2: two independent read-only calls in one batch produce no match", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_STATUS_GET, input: { taskId: "mt#1" } },
        { name: SESSION_GET, input: { task: "mt#1" } },
      ]),
    ];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("a mint call alone (no consumer in the batch) produces no match", () => {
    const turn: TranscriptLine[] = [makeSingleAssistantLine(TASKS_CREATE, { title: "x" })];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("a consumer call alone (no mint in the batch) produces no match", () => {
    const turn: TranscriptLine[] = [
      makeSingleAssistantLine(SESSION_COMMIT, { message: "fix: unrelated" }),
    ];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("mint and consume in SEPARATE messages (tool-result round-trip between) do not fire", () => {
    // By the time the second message is composed, the first call's real
    // result is already in hand -- not the batching failure this guards.
    const turn: TranscriptLine[] = [
      makeSingleAssistantLine(TASKS_CREATE, { title: "x" }),
      makeToolResultLine(),
      makeSingleAssistantLine(SESSION_COMMIT, {
        message: "fix(mt#1234): now referencing the real returned id",
      }),
    ];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("a call that is both mint and consume (session_pr_create alone) does not self-pair", () => {
    const turn: TranscriptLine[] = [
      makeSingleAssistantLine(SESSION_PR_CREATE, { title: "x", body: "## Summary" }),
    ];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("an empty/whitespace-only consumer field does not fire", () => {
    const turn: TranscriptLine[] = [
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "x" } },
        { name: SESSION_COMMIT, input: { message: "   " } },
      ]),
    ];
    expect(detectBatchedMintAndConsume(turn)).toEqual([]);
  });

  test("empty turn produces no match", () => {
    expect(detectBatchedMintAndConsume([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildReminder (SC2 — names the specific minting + consuming calls)
// ---------------------------------------------------------------------------

describe("buildReminder", () => {
  test("names the specific minting call and consuming call, and states the rule", () => {
    const matches: BatchMatch[] = [
      {
        mintTool: TASKS_CREATE,
        consumeTool: SESSION_COMMIT,
        consumeField: "message",
        excerpt: COMMIT_MESSAGE_EXCERPT,
        judged: captureArtifact(COMMIT_MESSAGE_EXCERPT),
      },
    ];
    const reminder = buildReminder(matches);
    expect(reminder).toContain(TASKS_CREATE);
    expect(reminder).toContain(SESSION_COMMIT);
    expect(reminder).toContain("message");
    expect(reminder).toContain("read the minting call's real result");
    expect(reminder).toContain(OVERRIDE_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// Calibration gate
// ---------------------------------------------------------------------------

describe("calibration gate", () => {
  test("ships calibration-first: INJECTION_ENABLED is false (mt#3125 SC3)", () => {
    expect(INJECTION_ENABLED).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2 — mt#2652)
// ---------------------------------------------------------------------------

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
  test("AT1: batched mint+consume -> calibration record, NO additionalContext (calibration-first)", () => {
    const transcriptLines: TranscriptLine[] = [
      makeUserLine(),
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "Fix the bug" } },
        { name: SESSION_COMMIT, input: { message: "fix(mt#9999): resolve" } },
      ]),
      makeUserLine(),
    ];
    const outcome = run(RUN_HOOK_INPUT, makeCtx(transcriptLines));
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as {
      matches: Array<{ category: string; phrase: string; mintTool: string; consumeTool: string }>;
    };
    expect(
      cal.matches.some((m) => m.mintTool === TASKS_CREATE && m.consumeTool === SESSION_COMMIT)
    ).toBe(true);
  });

  test("AT2: two independent reads batched -> null (no calibration record)", () => {
    const transcriptLines: TranscriptLine[] = [
      makeUserLine(),
      makeBatchedAssistantLine([
        { name: TASKS_STATUS_GET, input: { taskId: "mt#1" } },
        { name: SESSION_GET, input: { task: "mt#1" } },
      ]),
      makeUserLine(),
    ];
    expect(run(RUN_HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: RUN_HOOK_EVENT_NAME,
    };
    const ctx = makeCtx([
      makeUserLine(),
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "x" } },
        { name: SESSION_COMMIT, input: { message: "y" } },
      ]),
      makeUserLine(),
    ]);
    expect(run(input, ctx)).toBeNull();
  });

  test("override env var suppresses detection and returns an audit line", () => {
    const transcriptLines: TranscriptLine[] = [
      makeUserLine(),
      makeBatchedAssistantLine([
        { name: TASKS_CREATE, input: { title: "x" } },
        { name: SESSION_COMMIT, input: { message: "y" } },
      ]),
      makeUserLine(),
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

// ---------------------------------------------------------------------------
// Type-shape smoke check (unused-import guard for ToolUseBlock)
// ---------------------------------------------------------------------------

describe("ToolUseBlock shape", () => {
  test("has name and input fields", () => {
    const block: ToolUseBlock = { name: TASKS_CREATE, input: { title: "x" } };
    expect(block.name).toBe(TASKS_CREATE);
  });
});

// ---------------------------------------------------------------------------
// Consume-before-mint pass (mt#3340)
//
// The batch pass above only pairs calls inside ONE assistant message. These
// cover the reversed ORDERING across messages — a write naming an id, then a
// mint producing one — which nothing guarded before.
// ---------------------------------------------------------------------------

const SESSION_EDIT_FILE = "mcp__minsky__session_edit_file";
const SESSION_WRITE_FILE = "mcp__minsky__session_write_file";

/** Written-id fixtures — the literal appears in several cases, so it is shared
 * (custom/no-magic-string-duplication).
 */
const COMMENT_WITH_WRITTEN_ID = "// tracked in mt#3336";
const DOCBLOCK_WITH_WRITTEN_ID = "/** tracked in mt#3336. */";

/** An assistant tool_use block carrying an `id`, so a tool_result can correlate. */
function makeIdentifiedAssistantLine(
  name: string,
  input: Record<string, unknown>,
  id: string
): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input, id }],
    },
  } as TranscriptLine;
}

/** A user-role line carrying the tool_result for `toolUseId`. */
function makeMintResultLine(toolUseId: string, payload: unknown): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(payload) }],
    },
  } as TranscriptLine;
}

describe("detectConsumeBeforeMint (mt#3340)", () => {
  test("AT1: a file write naming an id, then a mint that returns a different one", () => {
    const turn = [
      makeSingleAssistantLine(SESSION_EDIT_FILE, {
        path: "src/x.test.tsx",
        content: DOCBLOCK_WITH_WRITTEN_ID,
      }),
      makeIdentifiedAssistantLine(TASKS_CREATE, { title: "Some task" }, "tu_1"),
      makeMintResultLine("tu_1", { taskId: "mt#3338" }),
    ];

    const matches = detectConsumeBeforeMint(turn, "");
    expect(matches.length).toBe(1);
    expect(matches[0]?.writtenId).toBe("mt#3336");
    expect(matches[0]?.mintedId).toBe("mt#3338");
    expect(matches[0]?.consumeTool).toBe(SESSION_EDIT_FILE);
    expect(matches[0]?.mintTool).toBe(TASKS_CREATE);
  });

  test("AT2: correct order (mint, read the result, THEN reference it) does not match", () => {
    const turn = [
      makeIdentifiedAssistantLine(TASKS_CREATE, { title: "Some task" }, "tu_1"),
      makeMintResultLine("tu_1", { taskId: "mt#3338" }),
      makeSingleAssistantLine(SESSION_COMMIT, { message: "fix(mt#3338): real reference" }),
    ];

    expect(detectConsumeBeforeMint(turn, "")).toEqual([]);
  });

  test("AT3: an id-shaped token with no mint anywhere in the turn does not match", () => {
    const turn = [
      makeSingleAssistantLine(SESSION_WRITE_FILE, {
        path: "docs/x.md",
        content: "See mt#1234 for background.",
      }),
    ];

    expect(detectConsumeBeforeMint(turn, "")).toEqual([]);
  });

  test("an id the agent could have READ earlier is not a construction", () => {
    const turn = [
      makeSingleAssistantLine(SESSION_EDIT_FILE, {
        path: "src/x.ts",
        content: "// related: mt#3336",
      }),
      makeIdentifiedAssistantLine(TASKS_CREATE, { title: "Some task" }, "tu_1"),
      makeMintResultLine("tu_1", { taskId: "mt#3338" }),
    ];

    // mt#3336 appears in prior transcript content — it had a source.
    expect(detectConsumeBeforeMint(turn, '{"taskId":"mt#3336"}')).toEqual([]);
  });

  test("a match still reports without the minted id when the result is unparseable", () => {
    const turn = [
      makeSingleAssistantLine(SESSION_EDIT_FILE, {
        path: "src/x.ts",
        content: COMMENT_WITH_WRITTEN_ID,
      }),
      makeSingleAssistantLine(TASKS_CREATE, { title: "Some task" }),
    ];

    const matches = detectConsumeBeforeMint(turn, "");
    expect(matches.length).toBe(1);
    expect(matches[0]?.writtenId).toBe("mt#3336");
    expect(matches[0]?.mintedId).toBeUndefined();
  });

  test("the reminder names both the written token and the real id", () => {
    const text = buildConsumeBeforeMintReminder([
      {
        consumeTool: SESSION_EDIT_FILE,
        consumeField: "content",
        writtenId: "mt#3336",
        mintTool: TASKS_CREATE,
        mintedId: "mt#3338",
        excerpt: DOCBLOCK_WITH_WRITTEN_ID,
        judged: captureArtifact(DOCBLOCK_WITH_WRITTEN_ID),
      },
    ]);
    expect(text).toContain("mt#3336");
    expect(text).toContain("mt#3338");
    expect(text).toContain("mt#3340");
  });
});

// ---------------------------------------------------------------------------
// PR #2418 R1 — the two blocking findings, pinned.
// ---------------------------------------------------------------------------

describe("detectConsumeBeforeMint — cross-message only (PR #2418 R1)", () => {
  test("a mint in the SAME message as the write is the batch pass's territory, not this one", () => {
    const turn = [
      makeBatchedAssistantLine([
        { name: SESSION_EDIT_FILE, input: { path: "src/x.ts", content: COMMENT_WITH_WRITTEN_ID } },
        { name: TASKS_CREATE, input: { title: "Some task" } },
      ]),
    ];

    // This pass stays silent...
    expect(detectConsumeBeforeMint(turn, "")).toEqual([]);
    // ...while the batch pass still reports the same-message pairing.
    expect(detectBatchedMintAndConsume(turn).length).toBeGreaterThan(0);
  });

  test("an id returned by a tool_result EARLIER IN THE SAME TURN counts as a source", () => {
    const turn = [
      makeIdentifiedAssistantLine(TASKS_CREATE, { title: "First task" }, "tu_0"),
      makeMintResultLine("tu_0", { taskId: "mt#3336" }),
      // The write now references an id it genuinely read from the result above.
      makeSingleAssistantLine(SESSION_EDIT_FILE, {
        path: "src/x.ts",
        content: COMMENT_WITH_WRITTEN_ID,
      }),
      makeIdentifiedAssistantLine(TASKS_CREATE, { title: "Second task" }, "tu_1"),
      makeMintResultLine("tu_1", { taskId: "mt#3338" }),
    ];

    // Before the R1 fix this matched: tool_result lines were never accumulated
    // into the prior-source text, so a genuinely-read id looked constructed.
    expect(detectConsumeBeforeMint(turn, "")).toEqual([]);
  });
});
