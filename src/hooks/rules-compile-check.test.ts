/**
 * Unit tests for `classifyCompileCheckError` — the discriminating logic that
 * distinguishes genuine `rules compile --check` staleness from unrelated
 * compile-command failures (e.g., "Developer setup incomplete").
 *
 * These tests cover the two acceptance-test scenarios from mt#1940:
 *   1. Setup-missing: non-zero exit WITHOUT the stale marker → surfaces the
 *      actual error, does NOT suggest "regenerate".
 *   2. Genuine staleness: non-zero exit WITH the stale marker in stdout →
 *      shows the staleness message and the regenerate command.
 */
import { describe, test, expect } from "bun:test";
import { classifyCompileCheckError } from "./pre-commit";

/** Substring emitted by classifyCompileCheckError for non-staleness compile failures. */
const NOT_STALENESS_MARKER = "not a staleness issue";

/** Build the exact STALE marker line the CLI emits for a target (see classifyCompileCheckError). */
function staleMarker(target: string): string {
  return `[rules compile --check] Target "${target}" is STALE`;
}

/** Build the exact EXCEEDS SIZE BUDGET marker line the CLI emits for a target (mt#2802). */
function budgetExceededMarker(target: string): string {
  return `[rules compile --check] Target "${target}" EXCEEDS SIZE BUDGET`;
}

/**
 * Build a mock exec error matching the shape Node.js `promisify(exec)` throws
 * when the subprocess exits non-zero.
 */
function makeExecError(opts: {
  stdout?: string;
  stderr?: string;
  message?: string;
}): Error & { stdout: string; stderr: string } {
  const err = new Error(opts.message ?? "Command failed") as Error & {
    stdout: string;
    stderr: string;
  };
  err.stdout = opts.stdout ?? "";
  err.stderr = opts.stderr ?? "";
  return err;
}

describe("classifyCompileCheckError — mt#1940 acceptance tests", () => {
  describe("Acceptance test 1: setup-incomplete error (not staleness)", () => {
    test("reports the actual error, not a staleness message", () => {
      // Simulates: `bun run src/cli.ts rules compile --check --target agents.md`
      // exiting non-zero because setup is incomplete.
      // The CLI emits "Validation error: Developer setup incomplete. Run `minsky setup` first."
      // to stderr, and NO stale marker to stdout.
      const error = makeExecError({
        stderr: "Validation error: Developer setup incomplete. Run `minsky setup` first.",
        stdout: "",
      });

      const result = classifyCompileCheckError(error, "agents.md");

      // Must NOT tell the operator to regenerate — that won't fix a setup gap
      const allOutput = result.logLines.join("\n");
      expect(allOutput).not.toContain("regenerate");
      expect(allOutput).not.toContain("is stale");

      // Must surface the actual underlying error
      expect(allOutput).toContain("Developer setup incomplete");

      // Must tell operator to run setup (BLOCKING #1 requirement)
      expect(allOutput).toContain("setup --client");

      // Message should also reflect the error
      expect(result.message).toContain("failed");
      expect(result.message).not.toContain("is stale");
    });

    test("uses stdout when stderr is empty", () => {
      // Some error outputs come through stdout instead of stderr
      const error = makeExecError({
        stdout: "Error: configuration file missing",
        stderr: "",
      });

      const result = classifyCompileCheckError(error, "claude.md");

      const allOutput = result.logLines.join("\n");
      expect(allOutput).toContain("configuration file missing");
      expect(allOutput).not.toContain("regenerate");
    });

    test("falls back to error.message when stdout and stderr are empty", () => {
      const error = makeExecError({
        stdout: "",
        stderr: "",
        message: "spawn ENOENT",
      });

      const result = classifyCompileCheckError(error, "cursor-rules");

      const allOutput = result.logLines.join("\n");
      expect(allOutput).toContain("spawn ENOENT");
      expect(allOutput).not.toContain("regenerate");
    });
  });

  describe("Acceptance test 2: genuine staleness", () => {
    test("reports staleness and suggests regenerate command", () => {
      // Simulates: the CLI emits the staleness marker to stdout, then exits non-zero.
      // compile-migrate-commands.ts emits:
      //   log.cli('[rules compile --check] Target "agents.md" is STALE')
      //   log.cli('  Stale file: /path/AGENTS.md')
      //   log.cli('  Run "minsky rules compile --target agents.md" to regenerate.')
      const error = makeExecError({
        stdout: [
          staleMarker("agents.md"),
          "  Stale file: /workspace/AGENTS.md",
          '  Run "minsky rules compile --target agents.md" to regenerate.',
        ].join("\n"),
        stderr: '❌ rules compile --check: target "agents.md" is stale (/workspace/AGENTS.md)',
      });

      const result = classifyCompileCheckError(error, "agents.md");

      // Must suggest regenerating
      const allOutput = result.logLines.join("\n");
      expect(allOutput).toContain("regenerate");
      expect(allOutput).toContain("is stale");

      // Must NOT claim this is a "compile failed" error
      expect(allOutput).not.toContain(NOT_STALENESS_MARKER);
      expect(allOutput).not.toContain("Fix the error above");

      // Message should describe staleness
      expect(result.message).toContain("stale");
      expect(result.message).toContain("agents.md");
    });
  });

  describe("Acceptance test 3: distinct messages for the two cases", () => {
    test("setup-error message and staleness message are distinguishable", () => {
      const setupError = makeExecError({
        stderr: "Validation error: Developer setup incomplete.",
        stdout: "",
      });
      const stalenessError = makeExecError({
        stdout: staleMarker("claude.md"),
        stderr: "",
      });

      const setupResult = classifyCompileCheckError(setupError, "claude.md");
      const stalenessResult = classifyCompileCheckError(stalenessError, "claude.md");

      // The two messages must be different
      expect(setupResult.message).not.toBe(stalenessResult.message);

      // Setup message must contain error indicator
      expect(setupResult.message).toContain("failed");

      // Staleness message must contain stale indicator
      expect(stalenessResult.message).toContain("stale");
    });
  });

  describe("BLOCKING #1 — setup-incomplete remediation message", () => {
    test("setup-incomplete stderr triggers minsky setup --client hint", () => {
      const error = makeExecError({
        stderr: "Validation error: Developer setup incomplete. Run `minsky setup` first.",
        stdout: "",
      });

      const result = classifyCompileCheckError(error, "agents.md");
      const allOutput = result.logLines.join("\n");

      // Must NOT suggest regenerating
      expect(allOutput).not.toContain("regenerate");

      // Must tell operator to run minsky setup --client
      expect(allOutput).toContain("setup --client");

      // Must surface the actual error detail
      expect(allOutput).toContain("Developer setup incomplete");
    });

    test("setup-incomplete match is case-insensitive", () => {
      const error = makeExecError({
        stderr: "validation error: developer setup incomplete",
        stdout: "",
      });

      const result = classifyCompileCheckError(error, "claude.md");
      const allOutput = result.logLines.join("\n");

      expect(allOutput).toContain("setup --client");
    });

    test("setup-incomplete in stdout also triggers hint", () => {
      // Some error outputs come through stdout
      const error = makeExecError({
        stdout: "Validation error: Developer setup incomplete. Please run setup.",
        stderr: "",
      });

      const result = classifyCompileCheckError(error, "cursor-rules");
      const allOutput = result.logLines.join("\n");

      expect(allOutput).toContain("setup --client");
      expect(allOutput).not.toContain("regenerate");
    });
  });

  describe("BLOCKING #2 — line-anchored stale detection for correct target only", () => {
    test("stale-looking note for previous run does NOT classify as stale", () => {
      // Near-miss: contains 'STALE' and '[rules compile --check]' but
      // it is a diagnostic note, not the exact per-target stale marker.
      const error = makeExecError({
        stdout: "[rules compile --check] note: previous run detected STALE files",
        stderr: "",
      });

      const result = classifyCompileCheckError(error, "agents.md");
      const allOutput = result.logLines.join("\n");

      // Must NOT be treated as genuine staleness
      expect(allOutput).not.toContain("is stale");
      // Must be treated as a compile failure
      expect(allOutput).toContain(NOT_STALENESS_MARKER);
    });

    test("stale marker for a DIFFERENT target does NOT classify as stale", () => {
      // stdout has the stale marker for "claude.md" but we are checking "agents.md"
      const error = makeExecError({
        stdout: staleMarker("claude.md"),
        stderr: "",
      });

      const result = classifyCompileCheckError(error, "agents.md");
      const allOutput = result.logLines.join("\n");

      // Must NOT classify as staleness for agents.md
      expect(allOutput).toContain(NOT_STALENESS_MARKER);
      expect(allOutput).not.toContain('Run "bun run minsky rules compile --target agents.md"');
    });

    test("stale marker for the CORRECT target DOES classify as stale", () => {
      const error = makeExecError({
        stdout: staleMarker("agents.md"),
        stderr: "",
      });

      const result = classifyCompileCheckError(error, "agents.md");
      const allOutput = result.logLines.join("\n");

      expect(allOutput).toContain("is stale");
      expect(allOutput).toContain("regenerate");
      expect(allOutput).not.toContain(NOT_STALENESS_MARKER);
    });

    test("stderr validation error alongside stale-looking stdout classifies as non-staleness", () => {
      // Actual stderr has a validation error; stdout happens to look stale-ish
      // but is NOT the exact per-target marker.
      const error = makeExecError({
        stdout: "[rules compile --check] note: previous run detected STALE files",
        stderr: "Validation error: some other problem",
      });

      const result = classifyCompileCheckError(error, "agents.md");
      const allOutput = result.logLines.join("\n");

      // Should surface the actual stderr error
      expect(allOutput).toContain("some other problem");
      // Should be flagged as a non-staleness failure
      expect(allOutput).toContain(NOT_STALENESS_MARKER);
    });
  });

  describe("errorKind discriminator", () => {
    test("stale error carries errorKind 'stale'", () => {
      const error = makeExecError({
        stdout: staleMarker("agents.md"),
        stderr: "",
      });
      expect(classifyCompileCheckError(error, "agents.md").errorKind).toBe("stale");
    });

    test("setup-incomplete error carries errorKind 'setup-incomplete'", () => {
      const error = makeExecError({
        stderr: "Validation error: Developer setup incomplete.",
        stdout: "",
      });
      expect(classifyCompileCheckError(error, "agents.md").errorKind).toBe("setup-incomplete");
    });

    test("unrelated error carries errorKind 'other'", () => {
      const error = makeExecError({ stderr: "some other problem", stdout: "" });
      expect(classifyCompileCheckError(error, "agents.md").errorKind).toBe("other");
    });
  });
});

// ─── mt#2802: size-budget-exceeded classification ───────────────────────────

describe("classifyCompileCheckError — mt#2802 size-budget-exceeded classification", () => {
  test("EXCEEDS SIZE BUDGET marker for the correct target classifies as budget-exceeded", () => {
    const error = makeExecError({
      stdout: [
        '[rules compile] Target "claude.md" output size: 145000 chars',
        budgetExceededMarker("claude.md"),
        "  Size: 145000 chars (fail threshold: 140000 chars)",
        "  Top contributing rules:",
        "    1. decision-defaults (36421 chars)",
        "    2. hook-files (24000 chars)",
      ].join("\n"),
      stderr: "",
    });

    const result = classifyCompileCheckError(error, "claude.md");
    const allOutput = result.logLines.join("\n");

    expect(result.errorKind).toBe("budget-exceeded");
    expect(allOutput).toContain("exceeds its size budget");
    expect(allOutput).not.toContain("is stale");
    expect(allOutput).not.toContain(NOT_STALENESS_MARKER);

    // The detail block (including the top-contributors listing) must be
    // surfaced so the operator knows what to trim (mt#2802 criterion #3).
    expect(allOutput).toContain("decision-defaults (36421 chars)");
    expect(allOutput).toContain("hook-files (24000 chars)");

    // Must name the override env var (mt#2802 criterion #4).
    expect(allOutput).toContain("MINSKY_SKIP_SIZE_BUDGET=1");

    expect(result.message).toContain("exceeds its size budget");
    expect(result.message).toContain("claude.md");
  });

  test("EXCEEDS SIZE BUDGET marker for a DIFFERENT target does not classify as budget-exceeded", () => {
    const error = makeExecError({
      stdout: budgetExceededMarker("claude.md"),
      stderr: "",
    });

    const result = classifyCompileCheckError(error, "agents.md");

    expect(result.errorKind).toBe("other");
    const allOutput = result.logLines.join("\n");
    expect(allOutput).toContain(NOT_STALENESS_MARKER);
  });

  test("STALE takes precedence over EXCEEDS SIZE BUDGET when both markers are present", () => {
    // Should not happen in practice (the CLI throws on the first failure it
    // detects), but the classifier's precedence must be deterministic.
    const error = makeExecError({
      stdout: [staleMarker("claude.md"), budgetExceededMarker("claude.md")].join("\n"),
      stderr: "",
    });

    const result = classifyCompileCheckError(error, "claude.md");
    expect(result.errorKind).toBe("stale");
  });

  test("classifies correctly for the agents.md target too", () => {
    const error = makeExecError({
      stdout: budgetExceededMarker("agents.md"),
      stderr: "",
    });

    const result = classifyCompileCheckError(error, "agents.md");
    expect(result.errorKind).toBe("budget-exceeded");
  });
});
