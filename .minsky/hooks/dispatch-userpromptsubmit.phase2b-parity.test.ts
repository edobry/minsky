/* eslint-disable custom/no-real-fs-in-tests -- fixture files must be real so Bun.spawn'd CLI subprocesses can read them */
// Fixture tests proving Phase 2b (mt#2687) migration parity: for each of the
// nine remaining UserPromptSubmit hooks, the dispatcher-path `run()` and the
// standalone `if (import.meta.main)` CLI entrypoint produce the SAME output
// for the same fixture input. Mirrors the per-task instruction ("write a
// fixture test comparing dispatcher-path output to standalone-CLI output per
// hook") — one parity test per hook below, using whichever fixture path is
// cheapest to make fully deterministic (override-audit-line path where the
// hook has a bespoke override var; functional/silent path otherwise).
//
// Timestamp handling: override-audit-line output embeds `new Date().toISOString()`
// at the moment each call executes. The CLI subprocess and the in-process
// `run()` call necessarily execute at slightly different wall-clock instants,
// so exact string equality would flake. `normalizeTimestamps` strips ISO-8601
// timestamps before comparison so the test asserts structural/content parity,
// not byte-identical timing.
//
// @see .minsky/hooks/registry.ts — GUARD_REGISTRY (Phase 2b entries)
// @see .minsky/hooks/dispatch-userpromptsubmit.ts — the dispatcher entrypoint
// @see mt#2687 — this migration

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { GUARD_REGISTRY, getGuardsForEvent } from "./registry";

/** Shared literal — the lifecycle event these fixtures all target. */
const USER_PROMPT_SUBMIT_EVENT = "UserPromptSubmit";

// ---------------------------------------------------------------------------
// 0. Registry order — LOAD-BEARING for Success Criterion 3 (byte-preserved
// injection order/shape). Guards against re-sorting GUARD_REGISTRY.
// ---------------------------------------------------------------------------

describe("Phase 2b parity: UserPromptSubmit registry order", () => {
  test("matches the pre-migration settings.json UserPromptSubmit block's relative order", () => {
    const names = getGuardsForEvent(GUARD_REGISTRY, USER_PROMPT_SUBMIT_EVENT).map((r) => r.name);
    expect(names).toEqual([
      "auto-session-title",
      "inject-current-time",
      "inject-git-state",
      "inject-prod-state",
      "inject-dispatch-watchdog",
      "memory-search",
      "skill-staleness-detector",
      "mcp-daemon-staleness-detector",
      "substrate-bypass-detector",
      "retrospective-trigger-scanner",
      "pre-narration-detector",
      "causal-premise-detector",
      "code-mechanism-assertion-detector",
      "ask-routing-deferral-detector",
      "calibration-review-cadence-detector",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeCtx(): DispatchContext {
  return {
    event: USER_PROMPT_SUBMIT_EVENT,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: [],
    transcriptLines: [],
  };
}

function makeInput(overrides: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "phase2b-parity-session",
    cwd: tmpdir(),
    hook_event_name: USER_PROMPT_SUBMIT_EVENT,
    ...overrides,
  };
}

/** Spawn the standalone CLI entrypoint for `hookFilename`, feed it `input` on stdin. */
async function invokeHookCli(
  hookFilename: string,
  input: ClaudeHookInput & Record<string, unknown>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const hookPath = new URL(hookFilename, import.meta.url).pathname;
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

/** Strip ISO-8601 timestamps so a live-clock audit line can be compared across two calls. */
function normalizeTimestamps(s: string): string {
  return s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<TS>");
}

/** Temporarily set/unset env vars for the duration of `fn`, then restore. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key];
    const val = overrides[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const val = prev[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Shared test title for the override-audit-line parity shape (4 hooks reuse it). */
const OVERRIDE_PARITY_TITLE =
  "override audit line matches between run() and CLI (timestamp-normalized)";

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. auto-session-title — functional path (scalar sessionTitle, no timestamp)
// ---------------------------------------------------------------------------

describe("Phase 2b parity: auto-session-title", () => {
  test("dispatcher run() and CLI produce the same sessionTitle for the same label file content", async () => {
    const { run } = await import("./auto-session-title");

    const cliSessionId = "parity-auto-title-cli";
    const runSessionId = "parity-auto-title-run";
    const label = { taskId: "mt#9999", title: "Parity fixture" };
    writeFileSync(`/tmp/claude-session-label-${cliSessionId}.json`, JSON.stringify(label));
    writeFileSync(`/tmp/claude-session-label-${runSessionId}.json`, JSON.stringify(label));

    const cliResult = await invokeHookCli(
      "auto-session-title.ts",
      makeInput({ session_id: cliSessionId })
    );
    const outcome = run(makeInput({ session_id: runSessionId }), makeCtx());

    expect(outcome?.sessionTitle).toBe("mt#9999 — Parity fixture");
    const cliOutput = JSON.parse(cliResult.stdout) as {
      hookSpecificOutput?: { sessionTitle?: string };
    };
    expect(cliOutput.hookSpecificOutput?.sessionTitle).toBe(outcome?.sessionTitle);
  });
});

// ---------------------------------------------------------------------------
// 2. inject-current-time — override-audit-line path
// ---------------------------------------------------------------------------

describe("Phase 2b parity: inject-current-time", () => {
  test(OVERRIDE_PARITY_TITLE, async () => {
    const { run, TIME_INJECTION_OVERRIDE_ENV } = await import("./inject-current-time");
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-current-time.ts", input, {
      [TIME_INJECTION_OVERRIDE_ENV]: "1",
    });
    const outcome = await withEnv({ [TIME_INJECTION_OVERRIDE_ENV]: "1" }, () =>
      run(input, makeCtx())
    );

    expect(normalizeTimestamps(cliResult.stdout)).toBe(
      normalizeTimestamps(outcome?.auditLines?.[0] ?? "")
    );
    expect(cliResult.stdout).toContain("[inject-current-time] override active");
  });
});

// ---------------------------------------------------------------------------
// 3. inject-git-state — override-audit-line path
// ---------------------------------------------------------------------------

describe("Phase 2b parity: inject-git-state", () => {
  test(OVERRIDE_PARITY_TITLE, async () => {
    const { run, GIT_STATE_INJECTION_OVERRIDE_ENV } = await import("./inject-git-state");
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-git-state.ts", input, {
      [GIT_STATE_INJECTION_OVERRIDE_ENV]: "1",
    });
    const outcome = await withEnv({ [GIT_STATE_INJECTION_OVERRIDE_ENV]: "1" }, () =>
      run(input, makeCtx())
    );

    expect(normalizeTimestamps(cliResult.stdout)).toBe(
      normalizeTimestamps(outcome?.auditLines?.[0] ?? "")
    );
    expect(cliResult.stdout).toContain("[inject-git-state] override active");
  });
});

// ---------------------------------------------------------------------------
// 4. inject-prod-state — override-audit-line path + content-parity (UNKNOWN)
// ---------------------------------------------------------------------------

describe("Phase 2b parity: inject-prod-state", () => {
  test(OVERRIDE_PARITY_TITLE, async () => {
    const { run, PROD_STATE_INJECTION_OVERRIDE_ENV } = await import("./inject-prod-state");
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-prod-state.ts", input, {
      [PROD_STATE_INJECTION_OVERRIDE_ENV]: "1",
    });
    const outcome = await withEnv({ [PROD_STATE_INJECTION_OVERRIDE_ENV]: "1" }, () =>
      run(input, makeCtx())
    );

    expect(normalizeTimestamps(cliResult.stdout)).toBe(
      normalizeTimestamps(outcome?.auditLines?.[0] ?? "")
    );
  });

  test("UNKNOWN-cache content is byte-identical between run() and CLI (no cache file present)", async () => {
    const { run } = await import("./inject-prod-state");
    const stateDir = makeTmpDir("mt2687-prod-state-");
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-prod-state.ts", input, {
      MINSKY_STATE_DIR: stateDir,
    });
    const outcome = await withEnv({ MINSKY_STATE_DIR: stateDir }, () => run(input, makeCtx()));

    const cliOutput = JSON.parse(cliResult.stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(outcome?.additionalContext).toContain("UNKNOWN");
    expect(cliOutput.hookSpecificOutput?.additionalContext).toBe(outcome?.additionalContext);
  });
});

// ---------------------------------------------------------------------------
// 5. inject-dispatch-watchdog — override-audit-line path + silent-parity
// ---------------------------------------------------------------------------

describe("Phase 2b parity: inject-dispatch-watchdog", () => {
  test(OVERRIDE_PARITY_TITLE, async () => {
    const { run, DISPATCH_WATCHDOG_INJECTION_OVERRIDE_ENV } = await import(
      "./inject-dispatch-watchdog"
    );
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-dispatch-watchdog.ts", input, {
      [DISPATCH_WATCHDOG_INJECTION_OVERRIDE_ENV]: "1",
    });
    const outcome = await withEnv({ [DISPATCH_WATCHDOG_INJECTION_OVERRIDE_ENV]: "1" }, () =>
      run(input, makeCtx())
    );

    expect(normalizeTimestamps(cliResult.stdout)).toBe(
      normalizeTimestamps(outcome?.auditLines?.[0] ?? "")
    );
  });

  test("both silent when no cache file is present", async () => {
    const { run } = await import("./inject-dispatch-watchdog");
    const stateDir = makeTmpDir("mt2687-dispatch-watchdog-");
    const input = makeInput();

    const cliResult = await invokeHookCli("inject-dispatch-watchdog.ts", input, {
      MINSKY_STATE_DIR: stateDir,
    });
    const outcome = await withEnv({ MINSKY_STATE_DIR: stateDir }, () => run(input, makeCtx()));

    expect(outcome).toBeNull();
    expect(cliResult.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6. memory-search — trivial-prompt content parity (no network call)
// ---------------------------------------------------------------------------

describe("Phase 2b parity: memory-search", () => {
  test("both silent on a trivial (affirmative) prompt", async () => {
    const { run } = await import("./memory-search");
    const input = makeInput({ prompt: "ok" } as Partial<ClaudeHookInput>);

    const cliResult = await invokeHookCli(
      "memory-search.ts",
      input as ClaudeHookInput & Record<string, unknown>
    );
    const outcome = await run(input, makeCtx());

    expect(outcome).toBeNull();
    expect(cliResult.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 7. skill-staleness-detector — opt-out silent parity
// ---------------------------------------------------------------------------

describe("Phase 2b parity: skill-staleness-detector", () => {
  test("both silent when opted out", async () => {
    const { run, OPT_OUT_ENV } = await import("./skill-staleness-detector");
    const input = makeInput();

    const cliResult = await invokeHookCli("skill-staleness-detector.ts", input, {
      [OPT_OUT_ENV]: "1",
    });
    const outcome = await withEnv({ [OPT_OUT_ENV]: "1" }, () => run(input, makeCtx()));

    expect(outcome).toBeNull();
    expect(cliResult.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 8. mcp-daemon-staleness-detector — opt-out silent parity
// ---------------------------------------------------------------------------

describe("Phase 2b parity: mcp-daemon-staleness-detector", () => {
  test("both silent when opted out", async () => {
    const { run, OPT_OUT_ENV } = await import("./mcp-daemon-staleness-detector");
    const input = makeInput();

    const cliResult = await invokeHookCli("mcp-daemon-staleness-detector.ts", input, {
      [OPT_OUT_ENV]: "1",
    });
    const outcome = await withEnv({ [OPT_OUT_ENV]: "1" }, () => run(input, makeCtx()));

    expect(outcome).toBeNull();
    expect(cliResult.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 9. calibration-review-cadence-detector — override-audit-line path
// ---------------------------------------------------------------------------

describe("Phase 2b parity: calibration-review-cadence-detector", () => {
  test(OVERRIDE_PARITY_TITLE, async () => {
    const { run, OVERRIDE_ENV_VAR } = await import("./calibration-review-cadence-detector");
    const input = makeInput();

    const cliResult = await invokeHookCli("calibration-review-cadence-detector.ts", input, {
      [OVERRIDE_ENV_VAR]: "1",
    });
    const outcome = await withEnv({ [OVERRIDE_ENV_VAR]: "1" }, () => run(input, makeCtx()));

    expect(normalizeTimestamps(cliResult.stdout)).toBe(
      normalizeTimestamps(outcome?.auditLines?.[0] ?? "")
    );
    expect(cliResult.stdout).toContain("[calibration-review-cadence-detector] override active");
  });
});
