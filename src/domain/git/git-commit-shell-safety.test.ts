import { describe, test, expect } from "bun:test";
import { commitImpl } from "./git-core-operations";

// ---------------------------------------------------------------------------
// mt#1742 — commit message must not be shell-interpolated
// ---------------------------------------------------------------------------
//
// The originating incident: a multi-line commit message containing markdown
// backticks (e.g., `` `bun install` ``) was interpolated into a `git -C ...
// commit -m "${message}"` shell template. /bin/sh -c performed command
// substitution on the backticks, hanging the parent shell on the postinstall
// hook of the substituted command (`bun install` → `bun x skills install`).
//
// These tests assert that commitImpl wraps the message in POSIX single
// quotes via `safeShellQuote`, so backticks / $VAR / special chars pass
// through to git literally rather than being parsed by the shell.

interface CapturedCall {
  command: string;
}

function makeFakeExecAsync(commitStdout: string = "[main abc1234] msg\n") {
  const calls: CapturedCall[] = [];
  const execAsync = async (
    command: string,
    _options?: Record<string, unknown>
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ command });
    // First call is the commit; second (if any) is the log-fallback that
    // extractCommitHash uses when the commit stdout lacks a SHA. Both return
    // a valid SHA so commitImpl resolves cleanly.
    if (command.includes("log -1")) {
      return { stdout: "abc1234567890abcdef\n", stderr: "" };
    }
    return { stdout: commitStdout, stderr: "" };
  };
  return { execAsync, calls };
}

const WORKDIR = "/tmp/fake/session";

describe("commitImpl shell-safety (mt#1742)", () => {
  test("commit message with backticks is single-quoted, not double-quoted", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    const message = "feat: docs reference `bun install --production`";

    await commitImpl(execAsync, message, WORKDIR);

    expect(calls.length).toBeGreaterThan(0);
    const cmd = findCommitCommand(calls);

    // The message must appear inside single quotes, NOT double quotes.
    // Pre-fix: `git -C ... commit  -m "feat: docs reference \`bun install...\`"`
    //          → shell substitutes `bun install...` → hang.
    // Post-fix: `git -C ... commit  -m 'feat: docs reference \`bun install...\`'`
    //           → backticks are literal.
    expect(cmd).toContain(`-m '${message}'`);
    // Affirm the pre-fix double-quoted shape is GONE:
    expect(cmd).not.toContain(`-m "${message}"`);
  });

  test("commit message with $VAR is single-quoted (no variable expansion)", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    const message = "fix: clear $HOME before running tests";

    await commitImpl(execAsync, message, WORKDIR);

    const cmd = findCommitCommand(calls);
    expect(cmd).toContain(`-m '${message}'`);
  });

  test("commit message with embedded single quote uses canonical '\\'' escape", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    const message = "fix: it's broken";

    await commitImpl(execAsync, message, WORKDIR);

    const cmd = findCommitCommand(calls);
    // Canonical POSIX escape: close quote, escaped backslash-quote, reopen.
    expect(cmd).toContain(`-m 'fix: it'\\''s broken'`);
  });

  test("multi-line commit message with backticks AND quotes passes through correctly", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    // Regression fixture: shape of the mt#1726 commit message that triggered
    // the original incident.
    const message = [
      "feat(mt#1726): harden minsky-mcp Dockerfile",
      "",
      "1. `bun install` flags hardened: `--production --ignore-scripts`",
      `2. Selective COPY replaces "COPY . ."`,
      "",
      "$HOME should not expand.",
    ].join("\n");

    await commitImpl(execAsync, message, WORKDIR);

    const cmd = findCommitCommand(calls);
    // Whole message verbatim, single-quote-wrapped.
    expect(cmd).toContain(`-m '${message}'`);
    expect(cmd).toContain("`bun install`");
    expect(cmd).toContain("$HOME");
  });

  test("amend flag still works with the new quoting", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    await commitImpl(execAsync, "msg", WORKDIR, /* amend */ true);

    const cmd = findCommitCommand(calls);
    expect(cmd).toContain("--amend");
    expect(cmd).toContain("-m 'msg'");
  });

  // ---------------------------------------------------------------------------
  // PR #1058 R1 — workdir interpolation must also be single-quoted
  // ---------------------------------------------------------------------------
  //
  // R1 BLOCKING #1 + #2: the message was single-quoted but workdir was left
  // unquoted, which (a) breaks on paths containing spaces and (b) is
  // inconsistent with the PR's shell-safety framing. The R1 fix wraps
  // workdir at every interpolation site in `commitImpl` (and the sibling
  // `commitWithDepsImpl`). These tests pin the new quoting.

  test("workdir with spaces is single-quoted in the commit command (R1 #1)", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    const workdirWithSpaces = "/Users/me/path with spaces/session";

    await commitImpl(execAsync, "msg", workdirWithSpaces);

    const cmd = findCommitCommand(calls);
    // Post-R1: `git -C '/Users/me/path with spaces/session' commit ... -m 'msg'`
    expect(cmd).toContain(`git -C '${workdirWithSpaces}' commit`);
    // Pre-R1 shape — workdir unquoted — must be ABSENT:
    expect(cmd).not.toContain(`git -C ${workdirWithSpaces} commit`);
  });

  test("workdir with shell metacharacters is single-quoted (R1 #1)", async () => {
    const { execAsync, calls } = makeFakeExecAsync();
    // Pathological workdir that would corrupt the command if unquoted:
    // - Backticks would trigger substitution (the exact mt#1742 root cause class)
    // - $VAR would expand
    // - Spaces would split the argument
    const evilWorkdir = "/tmp/`bun install`/$HOME/work dir";

    await commitImpl(execAsync, "msg", evilWorkdir);

    const cmd = findCommitCommand(calls);
    expect(cmd).toContain(`git -C '${evilWorkdir}' commit`);
  });

  test("log-fallback path also quotes workdir (R1 #1, extractCommitHash regression)", async () => {
    // The commitImpl log-fallback (extractCommitHash → `git log -1`) was a
    // second unquoted workdir site in the same function. R1 fix extends to
    // every interpolation in the function body, not just the commit line.
    const { execAsync, calls } = makeFakeExecAsync(
      // Force extractCommitHash to fall back to `git log -1` by returning
      // commit stdout that contains no SHA:
      "no SHA in this output\n"
    );
    const workdirWithSpaces = "/Users/me/path with spaces/session";

    await commitImpl(execAsync, "msg", workdirWithSpaces);

    const logCall = calls.find((c) => c.command.includes("log -1"));
    if (!logCall) {
      throw new Error(
        `expected commitImpl to fall back to 'git log -1'; captured: ${JSON.stringify(
          calls.map((c) => c.command)
        )}`
      );
    }
    expect(logCall.command).toContain(`git -C '${workdirWithSpaces}' log -1`);
  });
});

/**
 * Locate the `git commit` invocation in the captured-call list. Throws when
 * absent so tests fail fast with a clear message rather than via a non-null
 * assertion at the use site.
 */
function findCommitCommand(calls: CapturedCall[]): string {
  const commitCall = calls.find((c) => c.command.includes("commit"));
  if (!commitCall) {
    throw new Error(
      `expected commitImpl to invoke a 'git ... commit ...' command; captured: ${JSON.stringify(
        calls.map((c) => c.command)
      )}`
    );
  }
  return commitCall.command;
}
