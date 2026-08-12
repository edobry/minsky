/**
 * `printed` gating on the commands mt#3961 flagged (PR #2859 R1).
 *
 * The flag tells the CLI result formatter "my report is complete, add nothing."
 * Set it on a branch that did NOT print and the command goes silent, so every
 * flagged site is gated on the same condition that decides whether it printed.
 * These tests pin those gates from the OUTSIDE — by executing the command and
 * inspecting its result — because the gate is the part a later edit can quietly
 * get wrong while the formatter itself stays correct.
 *
 * Two shapes are covered:
 *
 * - **json branch must NOT set it.** In json mode the command prints nothing,
 *   so the flag would be a lie (and a stray key in the payload). Note the
 *   formatter is bypassed entirely for json output — `handleCommandOutput`
 *   routes it through `outputResult({json:true})` — so this is about payload
 *   correctness, not about output being suppressed.
 * - **text branch must set it.** That is the branch that printed the report.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { sharedCommandRegistry, type CommandExecutionContext } from "../command-registry";
import { registerRefsCommands } from "./refs";
import { log } from "@minsky/shared/logger";

/** Resolvers that answer without touching a container, DB, or forge. */
const stubResolvers = {
  getTaskStatus: async () => ({ found: true, status: "DONE", title: "a task" }),
  getChangesetStatus: async () => ({ found: false }),
  getAskState: async () => ({ found: false }),
  getMemoryState: async () => ({ found: false }),
  getWorkspaceState: async () => ({ found: false }),
};

describe("refs.status printed gating", () => {
  const originalCli = log.cli;

  beforeEach(() => {
    (log as unknown as { cli: unknown }).cli = mock(() => void 0);
  });

  afterEach(() => {
    (log as unknown as { cli: unknown }).cli = originalCli;
  });

  /**
   * The command builds production resolvers from a container it is registered
   * with; registering with no container and passing an unresolvable ref keeps
   * the run entirely in-process — the resolver throws, `resolveRefs` catches it
   * per-ref, and the command still takes its normal return path, which is the
   * part under test.
   */
  function runRefsStatus(params: { refs: string; json?: boolean }) {
    // Registration throws on a duplicate id, so register only once per process
    // — several tests below share the one registered command.
    if (!sharedCommandRegistry.getCommand("refs.status")) registerRefsCommands();
    const command = sharedCommandRegistry.getCommand("refs.status");
    if (!command) throw new Error("refs.status is not registered");
    return command.execute({ refs: params.refs, json: params.json ?? false }, {
      interface: "cli",
      format: params.json ? "json" : "text",
    } as CommandExecutionContext) as Promise<Record<string, unknown>>;
  }

  test("sets printed on the text branch, which rendered the table", async () => {
    const result = await runRefsStatus({ refs: "mt#1" });
    expect(result.printed).toBe(true);
  });

  test("omits printed entirely on the json branch, which printed nothing", async () => {
    const result = await runRefsStatus({ refs: "mt#1", json: true });
    // Absent, not `false` — a stray key would ship in the json payload.
    expect("printed" in result).toBe(false);
  });

  test("still returns the payload on both branches", async () => {
    const text = await runRefsStatus({ refs: "mt#1" });
    const json = await runRefsStatus({ refs: "mt#1", json: true });
    expect(text.total).toBe(1);
    expect(json.total).toBe(1);
  });
});

describe("resolveRefs stays independent of the printed gate", () => {
  test("classifies and resolves regardless of output mode", async () => {
    const { resolveRefs } = await import("./refs");
    const results = await resolveRefs(["mt#1"], stubResolvers);
    expect(results).toHaveLength(1);
    expect(results[0]?.found).toBe(true);
  });
});
