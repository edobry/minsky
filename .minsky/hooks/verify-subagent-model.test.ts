/* eslint-disable custom/no-real-fs-in-tests -- mt#4816's AT1 is a WRITE-ISOLATION test, the same
   shape as `guard-health-write-isolation.test.ts`: its claim is that the real `appendFileSync`
   lands under the state dir and creates nothing in a managed project's working tree. Mocking the
   filesystem would make the assertion about the mock's routing rather than the hook's, which is
   precisely the defect being fixed — the hook's path resolution WAS the bug. The write is
   confined to an `mkdtempSync` scratch dir, removed in a `finally`, and the env is injected
   rather than mutated globally, so nothing leaks between tests. */
/**
 * Tests for the subagent model-verification PostToolUse hook (mt#3257).
 *
 * The three payload fixtures below are REAL captures from the mt#3257 payload-shape probes
 * (Claude Code 2.1.220, 2026-07-29; usage sub-objects trimmed, load-bearing fields verbatim) —
 * per mem#672's lesson, a hook whose tests hand-build the payload it claims to parse can ship
 * dead against the payload production actually delivers (mt#3182 is this exact failure on the
 * `tool_result` key). Doctored variants derive from the real captures rather than being built
 * from scratch.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideModelCheck,
  extractResponse,
  isOverrideActive,
  requestedMatchesResolved,
  appendMismatchRecord,
  getMismatchLogPath,
  ALIAS_PREFIXES,
  MISMATCH_LOG,
  OVERRIDE_ENV_VAR,
} from "./verify-subagent-model";
import type { ToolHookInput } from "./types";
// mt#4816 AT3: the reader's own resolvers, imported rather than re-derived. Asserting the
// writer against a hand-written expected path is exactly what let ask-form-lint's writer and
// reader disagree while its test stayed green (mt#4811).
import { resolveStateDir, resolveStreamPath } from "@minsky/domain/guard-events/ingest-runtime";
import { GUARD_EVENT_STREAM_SOURCES } from "@minsky/domain/guard-events/stream-sources";

/** Probe-3 capture constants, shared across fixtures and assertions. */
const PROBE3_AGENT_ID = "af3976c1820b38d69";
const PROBE3_RESOLVED_MODEL = "claude-haiku-4-5-20251001";

/**
 * Probe 3 (sync, `model: "haiku"` requested and honored) — the complete requested-vs-resolved
 * pair in one payload. Source: mt#3257 spec, "Probe 3".
 */
const SYNC_HAIKU_MATCH: ToolHookInput = {
  session_id: "902b7e22-bd44-4fa6-9590-43b80c8b8a59",
  cwd: "/mock/repo",
  permission_mode: "auto",
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: {
    description: "Probe agent reply ok",
    prompt: "Reply with exactly the single word ok.",
    model: "haiku",
    run_in_background: false,
  },
  tool_result: undefined,
} as ToolHookInput;
// The measured payload key is `tool_response`, which ToolHookInput does not declare — attach it
// the way production delivers it.
(SYNC_HAIKU_MATCH as unknown as Record<string, unknown>)["tool_response"] = {
  status: "completed",
  prompt: "Reply with exactly the single word ok.",
  agentId: PROBE3_AGENT_ID,
  agentType: "general-purpose",
  content: [{ type: "text", text: "ok" }],
  resolvedModel: PROBE3_RESOLVED_MODEL,
  totalDurationMs: 1604,
  totalTokens: 13500,
  totalToolUseCount: 0,
};

/** Probe 1 (sync, NO model param) — the no-tier-requested case. */
const SYNC_NO_MODEL: ToolHookInput = {
  session_id: "014b8f79-1885-4a48-9f94-eb7ae17c274b",
  cwd: "/mock/repo",
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: {
    description: "Reply with single word ok",
    prompt: "Reply with exactly the single word ok",
    subagent_type: "general-purpose",
    run_in_background: false,
  },
} as ToolHookInput;
(SYNC_NO_MODEL as unknown as Record<string, unknown>)["tool_response"] = {
  status: "completed",
  agentId: "a5498e657d8293763",
  agentType: "general-purpose",
  resolvedModel: "claude-sonnet-5",
};

/** Probe 2 (async launch) — `resolvedModel` is already present at `async_launched`. */
const ASYNC_LAUNCH_NO_MODEL: ToolHookInput = {
  session_id: "d35fcd06-3dc3-487f-abac-a573c4be3287",
  cwd: "/mock/repo",
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: {
    description: "Reply ok probe",
    prompt: "Reply with exactly the single word ok. Use no other tools yourself.",
    subagent_type: "general-purpose",
    run_in_background: true,
  },
} as ToolHookInput;
(ASYNC_LAUNCH_NO_MODEL as unknown as Record<string, unknown>)["tool_response"] = {
  isAsync: true,
  status: "async_launched",
  agentId: "a88bbd2e015301ee6",
  description: "Reply ok probe",
  resolvedModel: "claude-sonnet-5",
  outputFile: "/mock/tasks/a88bbd2e015301ee6.output",
  canReadOutputFile: true,
};

/** Deep-clone a fixture and apply overrides to its tool_input / tool_response. */
function doctor(
  fixture: ToolHookInput,
  overrides: {
    toolInput?: Record<string, unknown>;
    toolResponse?: Record<string, unknown> | null;
    toolName?: string;
  }
): ToolHookInput {
  const clone = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  if (overrides.toolName !== undefined) clone["tool_name"] = overrides.toolName;
  if (overrides.toolInput) {
    clone["tool_input"] = {
      ...(clone["tool_input"] as Record<string, unknown>),
      ...overrides.toolInput,
    };
  }
  if (overrides.toolResponse === null) {
    delete clone["tool_response"];
  } else if (overrides.toolResponse) {
    clone["tool_response"] = {
      ...(clone["tool_response"] as Record<string, unknown>),
      ...overrides.toolResponse,
    };
  }
  return clone as unknown as ToolHookInput;
}

describe("decideModelCheck — the mt#3151 incident shape", () => {
  test("requested haiku, ran haiku (real probe-3 capture): silent", () => {
    const decision = decideModelCheck(SYNC_HAIKU_MATCH, {});
    expect(decision.kind).toBe("silent");
    expect(decision.reason).toContain("matches");
  });

  test("requested haiku, ran sonnet (the pre-fix pin behavior): WARN with both models named", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: { resolvedModel: "claude-sonnet-5" } });
    const decision = decideModelCheck(input, {});
    expect(decision.kind).toBe("warn");
    if (decision.kind !== "warn") throw new Error("unreachable");
    expect(decision.message).toContain("haiku");
    expect(decision.message).toContain("claude-sonnet-5");
    expect(decision.message).toContain(PROBE3_AGENT_ID);
    expect(decision.record["kind"]).toBe("mismatch");
    expect(decision.record["requested"]).toBe("haiku");
    expect(decision.record["resolved"]).toBe("claude-sonnet-5");
  });

  test("async launch with a requested tier honored: silent (resolvedModel known at launch)", () => {
    const input = doctor(ASYNC_LAUNCH_NO_MODEL, { toolInput: { model: "sonnet" } });
    const decision = decideModelCheck(input, {});
    expect(decision.kind).toBe("silent");
  });

  test("async launch with a dropped override: WARN, record marks is_async", () => {
    const input = doctor(ASYNC_LAUNCH_NO_MODEL, { toolInput: { model: "opus" } });
    const decision = decideModelCheck(input, {});
    expect(decision.kind).toBe("warn");
    if (decision.kind !== "warn") throw new Error("unreachable");
    expect(decision.record["is_async"]).toBe(true);
    expect(decision.record["subagent_id"]).toBe("a88bbd2e015301ee6");
  });
});

describe("decideModelCheck — pass-through cases", () => {
  test("no model requested (real probe-1 capture): silent, never a mismatch", () => {
    const decision = decideModelCheck(SYNC_NO_MODEL, {});
    expect(decision.kind).toBe("silent");
    expect(decision.reason).toContain("no model tier requested");
  });

  test("non-Agent tool: silent", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolName: "Bash" });
    expect(decideModelCheck(input, {}).kind).toBe("silent");
  });

  test("Task (the tool's older name) is covered like Agent", () => {
    const input = doctor(SYNC_HAIKU_MATCH, {
      toolName: "Task",
      toolResponse: { resolvedModel: "claude-sonnet-5" },
    });
    expect(decideModelCheck(input, {}).kind).toBe("warn");
  });

  test("override env var suppresses even a real mismatch", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: { resolvedModel: "claude-sonnet-5" } });
    const decision = decideModelCheck(input, { [OVERRIDE_ENV_VAR]: "1" });
    expect(decision.kind).toBe("silent");
    expect(decision.reason).toContain(OVERRIDE_ENV_VAR);
  });
});

describe("decideModelCheck — degraded payloads leave a trace, never a warn", () => {
  test("response object absent entirely: log-only response-missing", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: null });
    const decision = decideModelCheck(input, {});
    expect(decision.kind).toBe("log-only");
    if (decision.kind !== "log-only") throw new Error("unreachable");
    expect(decision.record["kind"]).toBe("response-missing");
  });

  test("resolvedModel absent (payload shape changed): log-only resolved-model-missing", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: { resolvedModel: undefined } });
    const decision = decideModelCheck(input, {});
    expect(decision.kind).toBe("log-only");
    if (decision.kind !== "log-only") throw new Error("unreachable");
    expect(decision.record["kind"]).toBe("resolved-model-missing");
  });

  test("legacy tool_result key still resolves (fallback path)", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: null });
    (input as unknown as Record<string, unknown>)["tool_result"] = {
      status: "completed",
      agentId: PROBE3_AGENT_ID,
      resolvedModel: PROBE3_RESOLVED_MODEL,
    };
    expect(decideModelCheck(input, {}).kind).toBe("silent");
  });
});

describe("requestedMatchesResolved — alias mapping", () => {
  test("every documented alias matches its measured/conventional id family", () => {
    expect(requestedMatchesResolved("opus", "claude-opus-5")).toBe(true);
    expect(requestedMatchesResolved("haiku", PROBE3_RESOLVED_MODEL)).toBe(true);
    expect(requestedMatchesResolved("sonnet", "claude-sonnet-5")).toBe(true);
    expect(requestedMatchesResolved("fable", "claude-fable-5")).toBe(true);
  });

  test("cross-tier pairs never match", () => {
    expect(requestedMatchesResolved("opus", "claude-sonnet-5")).toBe(false);
    expect(requestedMatchesResolved("fable", "claude-opus-5")).toBe(false);
    expect(requestedMatchesResolved("haiku", "claude-sonnet-5")).toBe(false);
  });

  test("a full model id passed as the request verifies against itself", () => {
    expect(requestedMatchesResolved("claude-opus-5", "claude-opus-5")).toBe(true);
    expect(requestedMatchesResolved("claude-opus-5", "claude-sonnet-5")).toBe(false);
  });

  test("an unknown future alias following the claude-<alias> convention verifies (PR #2388 R1)", () => {
    expect(requestedMatchesResolved("frontier", "claude-frontier-1")).toBe(true);
    expect(requestedMatchesResolved("frontier", "claude-frontier")).toBe(true);
    expect(requestedMatchesResolved("frontier", "claude-sonnet-5")).toBe(false);
    expect(requestedMatchesResolved("frontier", "claude-frontierish-1")).toBe(false);
  });

  test("prefix match requires a tier boundary, not a bare substring", () => {
    expect(requestedMatchesResolved("opus", "claude-opusish-1")).toBe(false);
  });

  test("alias table covers exactly the tool's documented enum", () => {
    expect(Object.keys(ALIAS_PREFIXES).sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
  });
});

describe("extractResponse / isOverrideActive", () => {
  test("prefers tool_response over tool_result when both are present", () => {
    const input = doctor(SYNC_HAIKU_MATCH, {});
    (input as unknown as Record<string, unknown>)["tool_result"] = { resolvedModel: "other" };
    const response = extractResponse(input);
    expect(response?.["resolvedModel"]).toBe(PROBE3_RESOLVED_MODEL);
  });

  test("an array-shaped response (MCP content envelope) is not treated as an object", () => {
    const input = doctor(SYNC_HAIKU_MATCH, { toolResponse: null });
    (input as unknown as Record<string, unknown>)["tool_response"] = [{ type: "text", text: "{}" }];
    expect(extractResponse(input)).toBeNull();
  });

  test("override recognizes 1/true/yes and rejects other values", () => {
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "1" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "TRUE" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "yes" })).toBe(true);
    expect(isOverrideActive({ [OVERRIDE_ENV_VAR]: "0" })).toBe(false);
    expect(isOverrideActive({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#4816 — the log's home, and the writer/reader agreement that pins it
// ---------------------------------------------------------------------------

describe("mt#4816 — the mismatch log lives in the state dir, not a project's working tree", () => {
  /** The manifest row this hook writes. Read from the manifest so a rename cannot silently pass. */
  const row = GUARD_EVENT_STREAM_SOURCES.find((s) => s.stream === "subagent-model-mismatch");
  if (!row) {
    // Loud at load time rather than an `undefined` quietly satisfying the assertions below.
    throw new Error("mt#4816: no `subagent-model-mismatch` row in GUARD_EVENT_STREAM_SOURCES");
  }

  test("SC3 — the stream is declared state-dir, and nothing in the manifest is repo-rooted", () => {
    expect(row.location).toBe("state-dir");
    // AT4, as an assertion rather than a grep: the whole manifest, not just this row.
    expect(GUARD_EVENT_STREAM_SOURCES.filter((s) => s.location !== "state-dir")).toEqual([]);
  });

  test("SC3 — the writer's file name is byte-identical to the row's relativePath", () => {
    // The docblock on MISMATCH_LOG claims this. `ask-form-lint` (mt#4811) is what a broken
    // version of this claim costs: reader and writer each derived their own path, they
    // disagreed, and the sweep read an empty corpus and reported "this guard never fired."
    expect(MISMATCH_LOG).toBe(row.relativePath);
  });

  test("AT3 — the writer resolves to exactly the path the ingest reader computes", () => {
    const env = { MINSKY_STATE_DIR: "/tmp/mt4816-state" } as NodeJS.ProcessEnv;
    expect(getMismatchLogPath(env)).toBe(
      resolveStreamPath(row, { repoRoot: "/some/managed/project", stateDir: resolveStateDir(env) })
    );
  });

  test("AT3 — they still agree when MINSKY_STATE_DIR is unset (the default branch)", () => {
    // Asserting the temp-dir case alone would pass even if the two default branches diverged,
    // which is the configuration almost every real invocation runs in.
    const env = {} as NodeJS.ProcessEnv;
    expect(getMismatchLogPath(env)).toBe(
      resolveStreamPath(row, { repoRoot: "/some/managed/project", stateDir: resolveStateDir(env) })
    );
  });

  test("AT3 — the resolved path does not depend on which project the agent is in", () => {
    // The point of the move: two managed repos must not get two different files. Flat, so the
    // repoRoot argument is inert for this stream (it is NOT inert for a calibration stream).
    const env = { MINSKY_STATE_DIR: "/tmp/mt4816-state" } as NodeJS.ProcessEnv;
    const stateDir = resolveStateDir(env);
    expect(resolveStreamPath(row, { repoRoot: "/projects/alpha", stateDir })).toBe(
      resolveStreamPath(row, { repoRoot: "/projects/beta", stateDir })
    );
  });

  test("AT1 — appending writes under the state dir and leaves no file in the repo tree", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "mt4816-state-"));
    const fakeRepo = mkdtempSync(join(tmpdir(), "mt4816-repo-"));
    try {
      appendMismatchRecord({ timestamp: "2026-08-31T00:00:00.000Z", kind: "mismatch" }, {
        MINSKY_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv);

      const written = join(stateDir, MISMATCH_LOG);
      expect(existsSync(written)).toBe(true);
      expect(JSON.parse(readFileSync(written, "utf-8").trim()).kind).toBe("mismatch");

      // The condition mt#4748's SC2 forbids: nothing lands in a managed project's tree.
      expect(existsSync(join(fakeRepo, ".minsky", "subagent-model-mismatch.jsonl"))).toBe(false);
      expect(existsSync(join(fakeRepo, ".minsky"))).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
