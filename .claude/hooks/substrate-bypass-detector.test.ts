/* eslint-disable custom/no-real-fs-in-tests -- the hook reads real transcript files via fs.readFileSync and E2E tests must write real transcript JSONL files so Bun.spawn can read them */
/* eslint-disable custom/no-magic-string-duplication -- test fixture strings (transcript text, heading names, section markers) are intentionally repeated across test cases for clarity and isolation */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectVerbalCommitment,
  detectSkillBypass,
  detectDbSubstrateBypass,
  parseTranscript,
  extractLastAssistantTurn,
  OVERRIDE_ENV_VAR,
} from "./substrate-bypass-detector";
import type { ClaudeHookInput } from "./types";

// ---------------------------------------------------------------------------
// Transcript JSONL helpers
// ---------------------------------------------------------------------------

type TranscriptLine = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  name?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
};

function makeUserLine(): TranscriptLine {
  return { type: "user", message: { role: "user", content: "test user message" } };
}

function makeAssistantLine(text: string): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function makeToolUseLine(toolName: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "tool_use",
    name: toolName,
    input,
  };
}

function buildTranscriptJSONL(lines: TranscriptLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

/**
 * Build a minimal hook input with a transcript at the given path.
 */
function makeHookInput(transcriptPath: string): ClaudeHookInput {
  return {
    session_id: "test-session-001",
    transcript_path: transcriptPath,
    cwd: "/test",
    hook_event_name: "UserPromptSubmit",
  };
}

/**
 * Invoke the hook script via Bun.spawn and return { exitCode, stdout, stderr }.
 */
async function invokeHook(
  input: ClaudeHookInput,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const hookPath = new URL("substrate-bypass-detector.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Fixture setup: temp dir for transcript files
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "substrate-bypass-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writeTranscript(lines: TranscriptLine[]): string {
  const path = join(tmpDir, "transcript.jsonl");
  writeFileSync(path, buildTranscriptJSONL(lines), "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// Unit tests: detectVerbalCommitment
// ---------------------------------------------------------------------------

describe("detectVerbalCommitment", () => {
  test('matches "I\'d update memory X" without memory_update tool call', () => {
    const turnLines: TranscriptLine[] = [
      makeAssistantLine("I'd update memory X to reflect this new finding."),
    ];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
    expect(result.matchedPhrase).toBeTruthy();
    expect(result.canonicalSubstrate).toBeTruthy();
  });

  test('silent when "I\'d update memory X" AND same-turn memory_update tool call', () => {
    const turnLines: TranscriptLine[] = [
      makeAssistantLine("I'd update memory X to reflect this."),
      makeToolUseLine("mcp__minsky__memory_update", { id: "abc", content: "updated" }),
    ];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(false);
  });

  test('matches "I will update X" without execution', () => {
    const turnLines = [makeAssistantLine("I will update the task spec with this decision.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "I should update X" without execution', () => {
    const turnLines = [makeAssistantLine("I should update the memory entry for this.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "I\'ll save X" without execution', () => {
    const turnLines = [makeAssistantLine("I'll save this finding to memory.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "I\'d save X" without execution', () => {
    const turnLines = [makeAssistantLine("I'd save this to a memory entry.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "I\'ll write X" without execution', () => {
    const turnLines = [makeAssistantLine("I'll write the implementation notes.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "going forward I\'ll X" without execution', () => {
    const turnLines = [makeAssistantLine("Going forward I'll remember to do this check.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "next session I\'ll X" without execution', () => {
    const turnLines = [makeAssistantLine("Next session I'll look into this further.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "I should file X" without tasks_create', () => {
    const turnLines = [makeAssistantLine("I should file a bug for this issue.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
    // canonical substrate should point to tasks_create for "file"
    expect(result.canonicalSubstrate).toContain("tasks_create");
  });

  test('matches "I\'d file X" without tasks_create', () => {
    const turnLines = [makeAssistantLine("I'd file a task to track this.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(true);
  });

  test("silent when no verbal commitment patterns present", () => {
    const turnLines = [makeAssistantLine("The implementation is complete. All tests pass.")];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent when Edit tool is used (execution present)", () => {
    const turnLines = [
      makeAssistantLine("I'll write this to the file."),
      makeToolUseLine("Edit", { file_path: "/some/file.ts", content: "new content" }),
    ];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent when memory_create is used (execution present)", () => {
    const turnLines = [
      makeAssistantLine("I'd save this finding."),
      makeToolUseLine("mcp__minsky__memory_create", { name: "test", content: "data" }),
    ];
    const result = detectVerbalCommitment(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent on empty turn", () => {
    const result = detectVerbalCommitment([]);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: detectSkillBypass
// ---------------------------------------------------------------------------

describe("detectSkillBypass", () => {
  test("matches inline retro shape with 2+ section headings, no Skill tool call", () => {
    const retroText = [
      "## Acknowledgment",
      "I made an error here.",
      "",
      "## Root cause",
      "I anchored on X without verifying Y.",
      "",
      "## Fixes",
      "Going forward I will use the /retrospective skill.",
    ].join("\n");
    const turnLines = [makeAssistantLine(retroText)];
    const result = detectSkillBypass(turnLines);
    expect(result.matched).toBe(true);
    expect(result.canonicalSubstrate).toContain("retrospective");
  });

  test("silent when inline retro shape AND same-turn Skill tool with retrospective", () => {
    const retroText = [
      "## Acknowledgment",
      "I made an error.",
      "",
      "## Root Cause",
      "The root cause was X.",
    ].join("\n");
    const turnLines = [
      makeAssistantLine(retroText),
      makeToolUseLine("Skill", { skill: "retrospective", args: "" }),
    ];
    const result = detectSkillBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent with only one retro heading (not enough for trigger)", () => {
    const turnLines = [makeAssistantLine("## Root cause\nSomething went wrong.")];
    const result = detectSkillBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent on normal assistant text without retro headers", () => {
    const turnLines = [makeAssistantLine("The implementation is complete. Tests pass.")];
    const result = detectSkillBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test("matches with H1 heading variants", () => {
    const retroText = [
      "# Retrospective:",
      "This is a retrospective.",
      "",
      "# Fixes",
      "Here are the fixes.",
    ].join("\n");
    const turnLines = [makeAssistantLine(retroText)];
    const result = detectSkillBypass(turnLines);
    expect(result.matched).toBe(true);
  });

  test("silent on empty turn", () => {
    const result = detectSkillBypass([]);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: detectDbSubstrateBypass
// ---------------------------------------------------------------------------

describe("detectDbSubstrateBypass", () => {
  test('matches "v1 reads JSONL directly" near "transcript"', () => {
    const turnLines = [
      makeAssistantLine(
        "The current implementation v1 reads JSONL directly from the transcript file path."
      ),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(true);
    expect(result.canonicalSubstrate).toContain("agent_transcripts");
  });

  test('matches "read JSONL directly" near "transcript"', () => {
    const turnLines = [
      makeAssistantLine("We read JSONL directly from the transcript. This is inefficient."),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "extend the DB later" near "transcript"', () => {
    const turnLines = [
      makeAssistantLine("We can extend the DB later. For now let's parse the transcript directly."),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(true);
  });

  test('matches "DB doesn\'t have" near "transcript"', () => {
    const turnLines = [
      makeAssistantLine(
        "The DB doesn't have the transcript data yet, so we'll use the JSONL files."
      ),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(true);
  });

  test('silent when "read JSONL" not near "transcript" (>300 chars apart)', () => {
    const paddingA = "x".repeat(400);
    const paddingB = "y".repeat(400);
    const turnLines = [
      makeAssistantLine(
        `We read JSONL directly.${paddingA}The transcript system is separate.${paddingB}`
      ),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test('silent when neither "transcript" nor any bypass phrase present', () => {
    const turnLines = [
      makeAssistantLine("The implementation is complete. No JSONL reading involved."),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test('silent when bypass phrase present but "transcript" absent', () => {
    const turnLines = [
      makeAssistantLine("We read JSONL directly from the log file for post-processing."),
    ];
    const result = detectDbSubstrateBypass(turnLines);
    expect(result.matched).toBe(false);
  });

  test("silent on empty turn", () => {
    const result = detectDbSubstrateBypass([]);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseTranscript + extractLastAssistantTurn
// ---------------------------------------------------------------------------

describe("parseTranscript", () => {
  test("parses valid JSONL into array of objects", () => {
    const transcriptPath = writeTranscript([makeUserLine(), makeAssistantLine("Hello!")]);
    const parsed = parseTranscript(transcriptPath);
    expect(parsed.length).toBe(2);
  });

  test("skips malformed lines gracefully", () => {
    const path = join(tmpDir, "malformed.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(makeUserLine()),
        "NOT_VALID_JSON",
        JSON.stringify(makeAssistantLine("ok")),
      ].join("\n")
    );
    const parsed = parseTranscript(path);
    expect(parsed.length).toBe(2);
  });

  test("returns [] for missing file", () => {
    const parsed = parseTranscript("/nonexistent/path/file.jsonl");
    expect(parsed).toEqual([]);
  });

  test("returns [] for empty file", () => {
    const path = join(tmpDir, "empty.jsonl");
    writeFileSync(path, "");
    const parsed = parseTranscript(path);
    expect(parsed).toEqual([]);
  });
});

describe("extractLastAssistantTurn", () => {
  test("returns [] when fewer than 2 user messages", () => {
    const lines = [makeUserLine(), makeAssistantLine("Hello!")];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
  });

  test("returns lines between second-to-last and last user message", () => {
    const user1 = makeUserLine();
    const assist1 = makeAssistantLine("First response.");
    const user2 = makeUserLine();
    const assist2 = makeAssistantLine("Second response.");
    const user3 = makeUserLine(); // current prompt

    const lines = [user1, assist1, user2, assist2, user3];
    const turn = extractLastAssistantTurn(lines);
    expect(turn.length).toBe(1);
    expect(turn[0]).toBe(assist2);
  });

  test("returns [] for empty transcript", () => {
    expect(extractLastAssistantTurn([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end tests via Bun.spawn
// ---------------------------------------------------------------------------

describe("main() end-to-end via Bun.spawn", () => {
  test("emits additionalContext when verbal commitment detected", async () => {
    const transcriptLines = [
      makeUserLine(),
      makeAssistantLine("I'd update memory X to reflect this finding."),
      makeUserLine(), // current prompt
    ];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("substrate-bypass");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("verbal-commitment");
  });

  test("silent when verbal commitment AND same-turn memory_update", async () => {
    const transcriptLines = [
      makeUserLine(),
      makeAssistantLine("I'd update memory X to reflect this."),
      makeToolUseLine("mcp__minsky__memory_update", { id: "abc" }),
      makeUserLine(),
    ];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(""); // No output = silent
  });

  test("emits additionalContext for inline retro shape without Skill tool", async () => {
    const retroText = [
      "## Acknowledgment",
      "I made an error.",
      "",
      "## Root Cause",
      "The root cause was X.",
      "",
      "## Fixes",
      "Here are the fixes.",
    ].join("\n");
    const transcriptLines = [makeUserLine(), makeAssistantLine(retroText), makeUserLine()];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("skill-bypass");
  });

  test("silent when inline retro shape AND Skill tool with retrospective", async () => {
    const retroText = [
      "## Acknowledgment",
      "I made an error.",
      "",
      "## Root Cause",
      "The root cause was X.",
    ].join("\n");
    const transcriptLines = [
      makeUserLine(),
      makeAssistantLine(retroText),
      makeToolUseLine("Skill", { skill: "retrospective" }),
      makeUserLine(),
    ];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("emits additionalContext for DB-substrate bypass", async () => {
    const transcriptLines = [
      makeUserLine(),
      makeAssistantLine("The current approach v1 reads JSONL directly from the transcript file."),
      makeUserLine(),
    ];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("db-substrate-bypass");
  });

  test("override env var suppresses additionalContext and emits audit on stdout", async () => {
    const transcriptLines = [
      makeUserLine(),
      makeAssistantLine("I'd update memory X to reflect this finding."),
      makeUserLine(),
    ];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout, stderr } = await invokeHook(input, {
      [OVERRIDE_ENV_VAR]: "1",
    });
    expect(exitCode).toBe(0);
    // Audit line on stdout per spec ("audit logging to stdout (matches
    // sibling-hook convention)"); not valid JSON, so Claude Code's parser
    // will not read it as a HookOutput envelope. The substantive assertion
    // is that no additionalContext JSON envelope was emitted.
    expect(stdout).toContain("[substrate-bypass-detector] OVERRIDE:");
    expect(stdout).toContain("ack=1");
    expect(stdout).not.toContain("additionalContext");
    expect(stderr.trim()).toBe("");
  });

  test("malformed JSONL in middle — fail-open: exits 0, warns on stderr, NO additionalContext", async () => {
    const goodLine1 = JSON.stringify(makeUserLine());
    const badLine = "THIS_IS_NOT_JSON{{{}}}";
    const goodLine2 = JSON.stringify(makeAssistantLine("I'd update memory X."));
    const goodLine3 = JSON.stringify(makeUserLine());

    const path = join(tmpDir, "malformed-mid.jsonl");
    writeFileSync(path, [goodLine1, badLine, goodLine2, goodLine3].join("\n"));
    const input = makeHookInput(path);

    // The hook should fail-open: only 1 user message (the good lines produce 2,
    // but the malformed line is skipped). The partial parse still succeeds;
    // if there are 2 user messages, detection runs. Either way exits 0.
    const { exitCode } = await invokeHook(input);
    expect(exitCode).toBe(0);
  });

  test("missing transcript_path → exits 0 silently", async () => {
    const input: ClaudeHookInput = {
      session_id: "test-session",
      cwd: "/test",
      hook_event_name: "UserPromptSubmit",
      // transcript_path omitted intentionally
    };

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("empty transcript → exits 0 silently", async () => {
    const path = join(tmpDir, "empty.jsonl");
    writeFileSync(path, "");
    const input = makeHookInput(path);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("first-turn-of-session (only system + user lines, no prior assistant turn) → silent", async () => {
    // Only one user line — extractLastAssistantTurn returns []
    const transcriptLines = [makeUserLine()];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("transcript with only system + user messages (no assistant turn before current prompt) → silent", async () => {
    // Two user messages but no assistant turn between them
    const transcriptLines = [makeUserLine(), makeUserLine()];
    const transcriptPath = writeTranscript(transcriptLines);
    const input = makeHookInput(transcriptPath);

    const { exitCode, stdout } = await invokeHook(input);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
