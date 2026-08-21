import { describe, expect, test } from "bun:test";

import {
  hasSucceededMcpCall,
  manifestPath,
  mcpToolNameFor,
  minskyArgvOf,
  readManifest,
  readMcpSubstitutionState,
  renderWorstCase,
  resolveCommandId,
  run,
  scanCommand,
} from "./detect-cli-mcp-substitution";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";

/**
 * The LIVE manifest, not a fixture — AT4's whole point. A fixture copy would pass while the real
 * oracle rotted, which is the failure mode `custom/require-hook-domain-bootstrap` (mt#3178) and
 * `custom/require-guard-outcome-in-fire-log` (mt#3920) both exist to prevent in their own trees.
 */
const loadedManifest = readManifest();
if (!loadedManifest) {
  // Fail loudly at load rather than letting every assertion below degrade to a
  // non-null assertion on null. A missing manifest is a generator regression,
  // which is precisely what AT4 exists to catch.
  throw new Error(
    `No completion manifest at ${manifestPath()} — run scripts/build-completion-manifest.ts`
  );
}
const manifest = loadedManifest;

/** The incident's canonical command id — used by both the AT1 table and the AT5 render check. */
const STATUS_SET_ID = "tasks.status.set";

/** An arbitrary MCP tool name, used across the AT2 suppression cases. */
const MCP_TASKS_GET = "mcp__minsky__tasks_get";

type CallSpec = {
  name: string;
  outcome: "ok" | "denied" | "error" | "none";
  /** Present when this call is a shell invocation — the run counter reads it (mt#4353). */
  command?: string;
};

/**
 * Build a transcript of tool_use blocks each with its correlated tool_result, so the suppression
 * leg can be exercised on OUTCOME rather than on name presence.
 */
function ctxWithCalls(calls: CallSpec[]): DispatchContext {
  const lines: unknown[] = [];
  calls.forEach((call, i) => {
    const id = `toolu_${i}`;
    lines.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: call.name,
            input: call.command === undefined ? {} : { command: call.command },
          },
        ],
      },
    });
    if (call.outcome === "none") return;
    const text =
      call.outcome === "denied"
        ? "The user doesn't want to proceed with this tool use. The tool use was rejected"
        : call.outcome === "error"
          ? "MCP error -32603: transport closed"
          : '{"success":true}';
    lines.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: call.outcome === "error",
            content: [{ type: "text", text }],
          },
        ],
      },
    });
  });
  return { transcriptLines: lines } as unknown as DispatchContext;
}

describe("manifest oracle", () => {
  test("the resolved path points at a manifest with a populated command tree", () => {
    // Not `not.toBeNull()` — the module-level load already throws on null, so that
    // assertion would be tautological. Assert the shape the walk depends on.
    expect(manifestPath()).toContain("completion-manifest.json");
    expect((manifest.subcommands ?? []).length).toBeGreaterThan(10);
  });
});

describe("mcpToolNameFor", () => {
  test("dots become underscores under the mcp__minsky__ prefix", () => {
    expect(mcpToolNameFor(STATUS_SET_ID)).toBe("mcp__minsky__tasks_status_set");
    expect(mcpToolNameFor("asks.list")).toBe("mcp__minsky__asks_list");
  });
});

describe("minskyArgvOf", () => {
  test("recognizes the installed binary, bare and path-qualified", () => {
    expect(minskyArgvOf("minsky tasks get mt#1")).toEqual(["tasks", "get", "mt#1"]);
    expect(minskyArgvOf("/Users/x/.bun/bin/minsky tasks get")).toEqual(["tasks", "get"]);
  });

  test("recognizes the in-repo entry point in both bun spellings", () => {
    expect(minskyArgvOf("bun run src/cli.ts tasks get mt#1")).toEqual(["tasks", "get", "mt#1"]);
    expect(minskyArgvOf("bun src/cli.ts memory patch mem#1")).toEqual(["memory", "patch", "mem#1"]);
  });

  test("returns null for anything that is not the Minsky CLI", () => {
    expect(minskyArgvOf("git status")).toBeNull();
    expect(minskyArgvOf("bun run scripts/build-completion-manifest.ts")).toBeNull();
    expect(minskyArgvOf("")).toBeNull();
  });
});

describe("resolveCommandId", () => {
  test("skips flags so a global flag before a subcommand does not stop the walk", () => {
    const root = {
      name: "minsky",
      subcommands: [{ name: "tasks", subcommands: [{ name: "get", commandId: "tasks.get" }] }],
    };
    expect(resolveCommandId(root, ["--json", "tasks", "get", "mt#1"])).toBe("tasks.get");
  });

  // PR #3004 R1 BLOCKING: a flag taking a SEPARATED value used to break the walk on the value.
  test("skips a separated flag value without swallowing a boolean flag s subcommand", () => {
    const root = {
      name: "minsky",
      subcommands: [{ name: "tasks", subcommands: [{ name: "get", commandId: "tasks.get" }] }],
    };
    expect(resolveCommandId(root, ["--cwd", "/tmp", "tasks", "get"])).toBe("tasks.get");
    expect(resolveCommandId(root, ["--json", "--cwd", "/tmp", "tasks", "get"])).toBe("tasks.get");
    expect(resolveCommandId(root, ["--cwd=/tmp", "tasks", "get"])).toBe("tasks.get");
  });

  test("returns null at a node carrying no commandId", () => {
    const root = { name: "minsky", subcommands: [{ name: "compile" }] };
    expect(resolveCommandId(root, ["compile", "--check"])).toBeNull();
  });
});

describe("AT1 — the originating incident's commands fire", () => {
  // Verbatim from the 2026-08-13 R10 turn (mem#707).
  const incidentCommands = [
    ['bun run src/cli.ts tasks status set "mt#3861" BLOCKED --json', STATUS_SET_ID],
    ['bun run src/cli.ts tasks get "mt#3812" --json', "tasks.get"],
    ["bun run src/cli.ts tasks spec get mt#3861", "tasks.spec.get"],
    ["bun run src/cli.ts memory get 01e6905b", "memory.get"],
    ["bun run src/cli.ts tools asks list --summary --limit 400", "asks.list"],
  ] as const;

  for (const [command, expectedId] of incidentCommands) {
    test(`${expectedId} resolves from: ${command.slice(0, 48)}`, () => {
      const result = scanCommand(command, manifest);
      expect(result.matched).toBe(true);
      expect(result.commandId).toBe(expectedId);
      expect(result.mcpToolName).toBe(mcpToolNameFor(expectedId));
    });
  }

  test("the TOOLS-category case resolves, which plain id-splitting cannot", () => {
    // `asks.list` mounts at `minsky tools asks list` — the category prefix is not in the id.
    const result = scanCommand("bun run src/cli.ts tools asks get f66b076d", manifest);
    expect(result.commandId).toBe("asks.get");
  });

  test("fires through a pipeline stage, since the substitution is usually piped to jq", () => {
    const result = scanCommand(
      "bun run src/cli.ts tasks get mt#1 --json | jq -r '.task'",
      manifest
    );
    expect(result.matched).toBe(true);
    expect(result.commandId).toBe("tasks.get");
  });
});

describe("AT2 — suppressed only once an MCP call has SUCCEEDED", () => {
  test("a succeeded mcp__minsky__ call suppresses", () => {
    const ctx = ctxWithCalls([
      { name: "Read", outcome: "ok" },
      { name: MCP_TASKS_GET, outcome: "ok" },
    ]);
    expect(hasSucceededMcpCall(ctx)).toBe(true);
  });

  test("no mcp__minsky__ call at all is reportable", () => {
    const ctx = ctxWithCalls([
      { name: "Bash", outcome: "ok" },
      { name: "mcp__github__list_issues", outcome: "ok" },
    ]);
    expect(hasSucceededMcpCall(ctx)).toBe(false);
  });

  test("an empty transcript is reportable rather than silently suppressed", () => {
    expect(hasSucceededMcpCall({ transcriptLines: [] } as unknown as DispatchContext)).toBe(false);
  });

  // PR #3004 R1 BLOCKING, raised by both review chunks. These four are the regression: under the
  // original name-presence implementation every one of them returned true, which suppressed the
  // detector on exactly the sessions it exists for — an MCP call was ATTEMPTED and did not work,
  // and the agent then rebuilt the surface out of CLI calls.
  test("a DENIED mcp call does not suppress", () => {
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "denied" }]);
    expect(hasSucceededMcpCall(ctx)).toBe(false);
  });

  test("an ERRORED mcp call does not suppress", () => {
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "error" }]);
    expect(hasSucceededMcpCall(ctx)).toBe(false);
  });

  test("an UNCORRELATED mcp call (no result) does not suppress", () => {
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "none" }]);
    expect(hasSucceededMcpCall(ctx)).toBe(false);
  });

  test("a failed call followed by a succeeded one DOES suppress", () => {
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "error" },
      { name: MCP_TASKS_GET, outcome: "ok" },
    ]);
    expect(hasSucceededMcpCall(ctx)).toBe(true);
  });
});

describe("AT3 — negative control: commands with no MCP equivalent never fire", () => {
  // The spec's original AT3 named `minsky compile` as the example. That was WRONG and the test
  // caught it: `mcp__minsky__compile` exists, so `compile` has an MCP form and firing on it is
  // correct behavior. The genuine negatives are nodes carrying no `commandId` at all — category
  // containers, which are Commander scaffolding rather than registry commands. Recorded in
  // mt#4144 `## Amendment (implementation)`.
  test("a bare category container does not fire", () => {
    expect(scanCommand("minsky tasks", manifest).matched).toBe(false);
  });

  test("a container one level down does not fire", () => {
    expect(scanCommand("minsky tasks deps --help", manifest).matched).toBe(false);
  });

  test("minsky compile DOES fire, because mcp__minsky__compile exists", () => {
    const result = scanCommand("minsky compile --check --target claude.md", manifest);
    expect(result.matched).toBe(true);
    expect(result.mcpToolName).toBe("mcp__minsky__compile");
  });

  test("a non-Minsky command does not fire", () => {
    expect(scanCommand("git log --oneline -5", manifest).matched).toBe(false);
  });

  test("building the manifest itself does not fire", () => {
    expect(scanCommand("bun run scripts/build-completion-manifest.ts", manifest).matched).toBe(
      false
    );
  });
});

describe("AT4 — coverage comes from the registry, not a hand-list", () => {
  test("the live manifest carries commandId on a broad set of leaves", () => {
    let stamped = 0;
    const walk = (node: { commandId?: string; subcommands?: unknown[] }) => {
      if (node.commandId) stamped++;
      for (const sub of (node.subcommands ?? []) as (typeof node)[]) walk(sub);
    };
    walk(manifest);
    // 227 stamped at authoring time; assert a floor rather than the exact count so adding a
    // command does not fail this test, while a generator regression that stamps nothing does.
    expect(stamped).toBeGreaterThan(150);
  });

  test("a command absent from the registry carries no id, so absence is the answer", () => {
    const result = scanCommand("minsky completion-server", manifest);
    expect(result.matched).toBe(false);
  });
});

describe("AT5 — worst-case advisory render", () => {
  test("names the command id, the MCP form, and the operator remedy", () => {
    const text = renderWorstCase();
    expect(text).toContain(STATUS_SET_ID);
    expect(text).toContain("mcp__minsky__tasks_status_set");
    expect(text).toContain("/mcp");
    expect(text).toContain("mt#4144");
  });

  test("stays within the declared attentionCost ceiling", () => {
    expect(renderWorstCase().length).toBeLessThanOrEqual(900);
  });
});

/**
 * mt#4353 — the suppression is no longer monotonic.
 *
 * Before this change, ONE successful MCP call silenced the guard for the rest of the session. The
 * whole fire corpus (11,063 records over 5 days) showed what that cost: all 5 fires were their
 * session's opening record, and every later moment in those same sessions was suppressed — so the
 * guard could only ever fire BEFORE a session's first successful call, while the class it exists
 * to catch happens after one.
 */
describe("AT6 — suppression is scoped to the substitution run (mt#4353)", () => {
  const CLI = "minsky tasks get mt#1";
  const SUPPRESSED = "suppressed-mcp-in-use";
  const MATCHED = "matched";

  function bashInput(command: string): ToolHookInput {
    return {
      tool_name: "Bash",
      tool_input: { command },
      session_id: "sess-4353",
    } as unknown as ToolHookInput;
  }

  async function outcomeOf(ctx: DispatchContext, command = CLI): Promise<string | undefined> {
    const result = await run(bashInput(command), ctx);
    return result?.calibration?.["outcome"] as string | undefined;
  }

  test("R11 ordering: MCP succeeded, then went quiet — the SECOND substitution fires", async () => {
    // The originating incident (mem#707 R11): MCP worked, the harness said the surface was gone,
    // and the agent rebuilt ~6 operations through the CLI. There is no failed MCP call to find and
    // no disconnect notice in the transcript, so the run length is the only available signal.
    //
    // NEGATIVE CONTROL: against the pre-fix predicate this is `suppressed-mcp-in-use` — the
    // succeeded flag is true, and nothing else was consulted. Observed failing before the change.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: CLI },
    ]);
    expect(await outcomeOf(ctx)).toBe(MATCHED);
  });

  test("the FIRST substitution after a success is still suppressed", async () => {
    // The regression floor, and the reason this is a run counter rather than "fire whenever MCP
    // has not been called recently": one deliberate CLI call in a healthy session stays quiet.
    // 135 of 320 replayed substitutions sit here.
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "ok" }]);
    expect(await outcomeOf(ctx)).toBe(SUPPRESSED);
  });

  test("a later MCP success resets the run, so the next substitution is suppressed again", async () => {
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: CLI },
      { name: MCP_TASKS_GET, outcome: "ok" },
    ]);
    expect(await outcomeOf(ctx)).toBe(SUPPRESSED);
  });

  test("a session_exec substitution does not reset its own run", async () => {
    // `mcp__minsky__session_exec` running the Minsky CLI is BOTH a successful MCP call and a
    // substitution. Letting it reset would let a CLI-rebuild burst clear its own counter at every
    // step — the guard would be silent for exactly the sustained case it is built for.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "mcp__minsky__session_exec", outcome: "ok", command: CLI },
    ]);
    expect(await outcomeOf(ctx)).toBe(MATCHED);
  });

  test("a non-Minsky shell command is not a substitution and does not advance the run", async () => {
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: "ls -la" },
    ]);
    expect(await outcomeOf(ctx)).toBe(SUPPRESSED);
  });

  test("with no successful MCP call at all, the FIRST substitution still fires (mt#4144 floor)", async () => {
    // PR #3004 R1's behavior, pinned: an MCP call that only ever ERRORED is not evidence of a
    // working surface, so the guard fires on the first substitution rather than the second.
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "error" }]);
    expect(await outcomeOf(ctx)).toBe(MATCHED);
  });

  test("state counts the run and reports liveness separately", () => {
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: CLI },
      { name: "Bash", outcome: "ok", command: CLI },
    ]);
    const state = readMcpSubstitutionState(ctx, manifest);
    expect(state.succeeded).toBe(true);
    expect(state.substitutionsSinceLastSuccess).toBe(2);
  });

  test("hasSucceededMcpCall still answers liveness alone, unchanged by the run", () => {
    // The 7 pre-existing assertions on this export keep their meaning: it is still "has MCP ever
    // worked", and it is deliberately blind to the run length now measured beside it.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: CLI },
      { name: "Bash", outcome: "ok", command: CLI },
    ]);
    expect(hasSucceededMcpCall(ctx)).toBe(true);
  });

  test("an MCP call that ERRORED since the last success unmutes immediately (PR #3186 R2)", async () => {
    // SC1's failure half. A run counter alone makes the agent spend one free substitution before
    // the guard speaks; when the transcript actually SHOWS the surface breaking, there is no
    // reason to wait for the second.
    //
    // NEGATIVE CONTROL: without `failedSinceLastSuccess` this is `suppressed-mcp-in-use` — the
    // success flag is set and the run is 0. Observed failing.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: MCP_TASKS_GET, outcome: "error" },
    ]);
    expect(await outcomeOf(ctx)).toBe(MATCHED);
  });

  test("an errored call with NO prior success does not claim one (PR #3186 R2)", async () => {
    // The blocking finding. `failedSinceLastSuccess` is set by any errored MCP call, including in a
    // session where none ever succeeded — so a failure-first branch rendered "an MCP call ERRORED
    // since the last one succeeded" when there was no last one. The existing
    // "with no successful MCP call at all" test walked this exact path and missed it, because it
    // asserted the OUTCOME and never read the TEXT.
    //
    // NEGATIVE CONTROL: with the failure branch checked before the never-succeeded branch, the
    // first assertion below fails. Observed failing.
    const ctx = ctxWithCalls([{ name: MCP_TASKS_GET, outcome: "error" }]);

    const result = await run(bashInput(CLI), ctx);
    expect(result?.calibration?.["outcome"]).toBe(MATCHED);
    expect(result?.additionalContext).not.toContain("since the last one succeeded");
    expect(result?.additionalContext).toContain("no `mcp__minsky__*` call has succeeded");
    // The calibration `reason` already had this precedence right; assert the two agree, since a
    // record that disagrees with the text shown to the agent is worse than either being wrong.
    expect(result?.calibration?.["reason"]).toBe("no-mcp-success");
  });

  test("a permission DENIAL is not a surface failure and does not unmute", async () => {
    // The operator refused one call; the request reached the harness, so MCP is demonstrably up.
    // Treating this as a failure would fire the guard every time a tool call is declined.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: MCP_TASKS_GET, outcome: "denied" },
    ]);
    expect(await outcomeOf(ctx)).toBe(SUPPRESSED);
  });

  test("a later success clears the failure, restoring the one free substitution", async () => {
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: MCP_TASKS_GET, outcome: "error" },
      { name: MCP_TASKS_GET, outcome: "ok" },
    ]);
    expect(await outcomeOf(ctx)).toBe(SUPPRESSED);
  });

  test("a top-level tool_use line advances the run (PR #3186 R1)", async () => {
    // Claude Code emits tool_use in TWO shapes; this walk read only the assistant-embedded one,
    // so a top-level `type: "tool_use"` Bash call was invisible and the run never advanced.
    // `transcript.ts` handles both in `findToolUseInputs`/`findCreatedResourceIds`.
    //
    // NEGATIVE CONTROL: before the dual-shape fix this is `suppressed-mcp-in-use`, because the
    // substitution below is simply not seen. Observed failing.
    const ctx = {
      transcriptLines: [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_ok", name: MCP_TASKS_GET, input: {} }],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_ok",
                is_error: false,
                content: [{ type: "text", text: '{"success":true}' }],
              },
            ],
          },
        },
        // The shape under test: top-level, no message.content wrapper.
        { type: "tool_use", name: "Bash", input: { command: CLI } },
      ],
    } as unknown as DispatchContext;

    expect(await outcomeOf(ctx)).toBe(MATCHED);
  });

  test("a top-level MCP tool_use with no id cannot prove success", () => {
    // It carries no correlating id, so it can never be matched to a result. Not counting it is
    // the same conservative direction the uncorrelated-block case already takes: a possible extra
    // fire, never a suppressed true one.
    const ctx = {
      transcriptLines: [{ type: "tool_use", name: MCP_TASKS_GET, input: {} }],
    } as unknown as DispatchContext;

    const state = readMcpSubstitutionState(ctx, manifest);
    expect(state.succeeded).toBe(false);
  });

  test("the run-length warning does not claim MCP never succeeded", async () => {
    // The two branches assert different facts. Telling an agent whose MCP is demonstrably working
    // that "no mcp__minsky__* call has succeeded" is falsifiable in one call, and a warning caught
    // lying is worth less than no warning.
    const ctx = ctxWithCalls([
      { name: MCP_TASKS_GET, outcome: "ok" },
      { name: "Bash", outcome: "ok", command: CLI },
    ]);
    const result = await run(bashInput(CLI), ctx);
    expect(result?.additionalContext).toBeDefined();
    expect(result?.additionalContext).not.toContain("no `mcp__minsky__*` call has succeeded");
    // One substitution in the transcript, so the pending call is the second.
    expect(result?.additionalContext).toContain("substitution #2");
  });
});
