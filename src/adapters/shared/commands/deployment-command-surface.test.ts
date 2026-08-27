/**
 * Deployment command surface (mt#4425).
 *
 * Two invariants, and the second is the load-bearing one.
 *
 * 1. The three deployment commands sit in `CommandCategory.DEPLOYMENT`, so the
 *    CLI bridge renders them as top-level `minsky deployment <verb>`. They used
 *    to carry `CommandCategory.TOOLS`, which nested them under `minsky tools
 *    deployment <verb>` — a working path that nothing in the corpus documented,
 *    while `minsky deployment ...` died with `unknown command 'deployment'`.
 *
 * 2. Their MCP tool names are UNCHANGED by that move. Names derive from the
 *    command **id** via `toClaudeDesktopName` (`src/mcp/tool-name.ts`), never
 *    from the category — which is exactly why the promotion is safe. At the
 *    time of writing, `deployment_wait-for-latest` alone appears ~90 times
 *    across `*.md` / `*.mdc` / `*.ts`. A future re-categorization must not
 *    silently rename them out from under those references.
 *
 * ADR-011 §Behavioral guarantee is the governing record: adding a category to
 * the enum + the Zod schema mirror + registering an `X.*` command is sufficient
 * to expose it via MCP, with no edit to `start-command.ts`.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { registerDeploymentCommands } from "./deployment";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { toClaudeDesktopName } from "../../../mcp/tool-name";

/**
 * The contract, spelled out: command id -> the MCP tool name callers use.
 * Both columns are load-bearing. The id drives the name, and the name is what
 * ~90 corpus references, agent muscle memory, and every `deployment_*` call
 * site depend on.
 */
/** The most-referenced of the three — named once so the negative control below
 * can assert against the same literal the contract table uses. */
const WAIT_FOR_LATEST_MCP_NAME = "deployment_wait-for-latest";

const DEPLOYMENT_COMMAND_SURFACE = [
  { id: "deployment.wait-for-latest", mcpName: WAIT_FOR_LATEST_MCP_NAME },
  { id: "deployment.status", mcpName: "deployment_status" },
  { id: "deployment.logs", mcpName: "deployment_logs" },
] as const;

let registeredHere = false;

beforeAll(() => {
  // Another suite in the same process may already have registered these.
  // registerCommand throws on a duplicate id unless allowOverwrite is set,
  // so only register (and only clean up) if we are the ones who did it.
  if (!sharedCommandRegistry.getCommand(DEPLOYMENT_COMMAND_SURFACE[0].id)) {
    registerDeploymentCommands();
    registeredHere = true;
  }
});

afterAll(() => {
  if (!registeredHere) return;
  for (const { id } of DEPLOYMENT_COMMAND_SURFACE) {
    sharedCommandRegistry.unregisterCommand(id);
  }
});

describe("deployment command surface (mt#4425)", () => {
  test("all three commands are registered under CommandCategory.DEPLOYMENT", () => {
    for (const { id } of DEPLOYMENT_COMMAND_SURFACE) {
      const command = sharedCommandRegistry.getCommand(id);
      expect(command, `${id} should be registered`).toBeDefined();
      expect(command?.category, `${id} should sit in DEPLOYMENT, not TOOLS`).toBe(
        CommandCategory.DEPLOYMENT
      );
    }
  });

  test("the DEPLOYMENT category contains exactly these three commands", () => {
    const ids = sharedCommandRegistry
      .getCommandsByCategory(CommandCategory.DEPLOYMENT)
      .map((cmd) => cmd.id)
      .sort();

    expect(ids).toEqual([...DEPLOYMENT_COMMAND_SURFACE.map((c) => c.id)].sort());
  });

  test("MCP tool names are unchanged by the category promotion", () => {
    for (const { id, mcpName } of DEPLOYMENT_COMMAND_SURFACE) {
      expect(toClaudeDesktopName(id), `${id} must keep its published MCP name`).toBe(mcpName);
    }
  });

  test("the MCP name derives from the id alone, so category cannot affect it", () => {
    // The registered command carries DEPLOYMENT; the derived name is computed
    // from the id and never consults the category. Recomputing from the live
    // registry entry — rather than from the literal above — is what makes this
    // an assertion about the real wiring.
    for (const { id, mcpName } of DEPLOYMENT_COMMAND_SURFACE) {
      const command = sharedCommandRegistry.getCommand(id);
      expect(command, `${id} should be registered`).toBeDefined();
      if (!command) continue;
      expect(command.category).toBe(CommandCategory.DEPLOYMENT);
      expect(toClaudeDesktopName(command.id)).toBe(mcpName);
    }
  });
});

describe("deployment command surface — the checks can fail (negative control)", () => {
  test("a renamed command id yields a different MCP name", () => {
    // If a future change renames the id, the published name moves with it —
    // which is the regression these tests exist to catch, demonstrated here
    // so the assertions above are known to discriminate rather than to hold
    // vacuously.
    expect(toClaudeDesktopName("deployment.waitForLatest")).not.toBe(WAIT_FOR_LATEST_MCP_NAME);
    expect(toClaudeDesktopName("tools.deployment.wait-for-latest")).not.toBe(
      WAIT_FOR_LATEST_MCP_NAME
    );
  });

  test("a category the commands do NOT carry reports them as absent", () => {
    const toolsIds = sharedCommandRegistry
      .getCommandsByCategory(CommandCategory.TOOLS)
      .map((cmd) => cmd.id);

    for (const { id } of DEPLOYMENT_COMMAND_SURFACE) {
      expect(toolsIds, `${id} must no longer appear under TOOLS`).not.toContain(id);
    }
  });
});
