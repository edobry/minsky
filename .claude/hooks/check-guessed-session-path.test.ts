import { describe, test, expect } from "bun:test";
import {
  findMissingSessionPaths,
  collectStrings,
  buildDenialReason,
  findMissingInToolInput,
  OVERRIDE_ENV_VAR,
} from "./check-guessed-session-path";

const SESSION_ID = "deadbeef-0000-0000-0000-000000000000";
const NONEXISTENT = `/Users/x/.local/state/minsky/sessions/${SESSION_ID}`;

// ---------------------------------------------------------------------------
// findMissingSessionPaths
// ---------------------------------------------------------------------------

describe("findMissingSessionPaths", () => {
  test("absolute nonexistent session path → reported", () => {
    const cmd = `cd ${NONEXISTENT}/src && ls`;
    const missing = findMissingSessionPaths(cmd, () => false);
    expect(missing.length).toBe(1);
    expect(missing[0]?.path).toBe(NONEXISTENT);
    expect(missing[0]?.sessionId).toBe(SESSION_ID);
  });

  test("existing session path → not reported", () => {
    const cmd = `cd ${NONEXISTENT}/src`;
    expect(findMissingSessionPaths(cmd, () => true).length).toBe(0);
  });

  test("quoted path matches (quotes excluded from path)", () => {
    const cmd = `cd "${NONEXISTENT}/src"`;
    const missing = findMissingSessionPaths(cmd, () => false);
    expect(missing[0]?.path).toBe(NONEXISTENT);
  });

  test("non-session command → empty", () => {
    expect(findMissingSessionPaths("ls -la /tmp && echo hi", () => false).length).toBe(0);
  });

  test("relative (non-absolute) session path → skipped", () => {
    const cmd = "cat state/minsky/sessions/abc/foo.txt";
    expect(findMissingSessionPaths(cmd, () => false).length).toBe(0);
  });

  test("two distinct missing paths → both reported, deduped", () => {
    const a = "/Users/x/.local/state/minsky/sessions/aaaa/x";
    const b = "/Users/x/.local/state/minsky/sessions/bbbb/y";
    const cmd = `cd ${a} && cd ${b} && cd ${a}`;
    const missing = findMissingSessionPaths(cmd, () => false);
    expect(missing.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// collectStrings / findMissingInToolInput / buildDenialReason
// ---------------------------------------------------------------------------

describe("tool_input scanning", () => {
  test("collectStrings extracts string values only", () => {
    const strings = collectStrings({ command: "x", timeout: 5, flag: true });
    expect(strings).toEqual(["x"]);
  });

  test("findMissingInToolInput finds path in command", () => {
    const missing = findMissingInToolInput({ command: `cd ${NONEXISTENT}` }, () => false);
    expect(missing.length).toBe(1);
  });

  test("buildDenialReason names the path, sessionId, and override", () => {
    const reason = buildDenialReason([{ path: NONEXISTENT, sessionId: SESSION_ID }]);
    expect(reason).toContain(NONEXISTENT);
    expect(reason).toContain(SESSION_ID);
    expect(reason).toContain(OVERRIDE_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// E2E (Bun.spawn) — deny / allow / override / fail-open
// ---------------------------------------------------------------------------

async function invokeHook(
  stdinPayload: string,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const hookPath = new URL("check-guessed-session-path.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(stdinPayload);
  proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function makeInput(command: string): string {
  return JSON.stringify({
    session_id: "test",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("check-guessed-session-path E2E", () => {
  test("nonexistent session path → deny", async () => {
    const { exitCode, stdout } = await invokeHook(makeInput(`cd ${NONEXISTENT}/src && ls`));
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');
  });

  test("non-session command → allow (no output)", async () => {
    const { exitCode, stdout } = await invokeHook(makeInput("ls -la /tmp"));
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("override env var → allow + audit line, no deny", async () => {
    const { exitCode, stdout } = await invokeHook(makeInput(`cd ${NONEXISTENT}`), {
      [OVERRIDE_ENV_VAR]: "1",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OVERRIDE");
    expect(stdout).not.toContain("permissionDecision");
  });

  test("malformed stdin → fail-open (exit 0, no deny)", async () => {
    const { exitCode, stdout } = await invokeHook("not json at all");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('"deny"');
  });
});
