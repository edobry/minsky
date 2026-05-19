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

      // Must flag this as a non-staleness failure
      expect(allOutput).toContain("not a staleness issue");

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
          '[rules compile --check] Target "agents.md" is STALE',
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
      expect(allOutput).not.toContain("not a staleness issue");
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
        stdout: '[rules compile --check] Target "claude.md" is STALE',
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
});
