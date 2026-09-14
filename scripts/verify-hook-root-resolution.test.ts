/**
 * mt#4954 SC2 — tests for the hook-root invariant checker.
 *
 * The script's value depends entirely on it being able to FAIL, so these exercise the
 * non-clean branches directly rather than only the happy path the real repo produces.
 * `auditSettings` is pure over a JSON string, so no filesystem is touched.
 */
import { describe, it, expect } from "bun:test";

import { auditSettings, checkCommand, collectCommands } from "./verify-hook-root-resolution";

/** A correctly-registered hook command — the form all 75 real registrations use. */
const OK_CMD = "$CLAUDE_PROJECT_DIR/.claude/hooks/a.ts";

/** The shape `.claude/settings.json` actually uses, so the walker is exercised on a real nesting. */
function settingsWith(commands: string[]): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: commands.map((command) => ({ type: "command", command })),
        },
      ],
    },
  });
}

describe("mt#4954 — hook commands must be $CLAUDE_PROJECT_DIR-rooted", () => {
  it("passes when every hook-tree command is env-rooted", () => {
    const raw = settingsWith([OK_CMD, "bun $CLAUDE_PROJECT_DIR/.claude/hooks/b.ts"]);
    const audit = auditSettings(raw);
    expect(audit.total).toBe(2);
    expect(audit.findings).toEqual([]);
  });

  it("FAILS on a bare relative hook path — the case that would reintroduce cwd ambiguity", () => {
    const raw = settingsWith([OK_CMD, ".claude/hooks/rogue.ts"]);
    const audit = auditSettings(raw);
    expect(audit.total).toBe(2);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.command).toBe(".claude/hooks/rogue.ts");
  });

  it("FAILS on an absolute path that hard-codes one machine's checkout", () => {
    // The other way the root stops being env-determined: pinned to a literal directory.
    const audit = auditSettings(settingsWith(["/Users/someone/minsky/.claude/hooks/a.ts"]));
    expect(audit.findings).toHaveLength(1);
  });

  it("ignores commands that are not hook-tree invocations", () => {
    const audit = auditSettings(settingsWith(["echo hello", "bun run lint"]));
    expect(audit.total).toBe(0);
    expect(audit.findings).toEqual([]);
  });

  it("collects commands regardless of where they nest — a schema reshuffle cannot empty the check", () => {
    // Guards the vacuous-pass failure mode: if the walker keyed on a fixed path and the harness
    // moved `hooks`, the audit would find zero commands and report clean.
    const reshuffled = JSON.stringify({
      somethingNew: { deeper: [{ command: OK_CMD }] },
    });
    expect(collectCommands(JSON.parse(reshuffled))).toEqual([OK_CMD]);
  });

  it("checkCommand returns null for out-of-scope commands and a finding for in-scope violations", () => {
    expect(checkCommand("bun run test")).toBeNull();
    expect(checkCommand(OK_CMD)).toBeNull();
    expect(checkCommand(".claude/hooks/a.ts")?.reason).toContain("deriveHookRepoRoot()");
  });
});
