/**
 * MCP-bridge discovery configuration (mt#2010 / ADR-011).
 *
 * Side-effect-free module holding the discovery loop's dispatch table and
 * default exclusion list. Extracted from `start-command.ts` so that tests
 * and out-of-band smoke scripts can import the data without pulling in the
 * full MCP-server / HTTP / OAuth dependency graph that `start-command.ts`
 * carries.
 *
 * `start-command.ts` re-exports these constants for backward compatibility
 * with code that already imports from there.
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import type { AppContainerInterface } from "../../composition/types";
import { CommandCategory } from "../../adapters/shared/command-registry";
import { registerDebugTools } from "../../adapters/mcp/debug";
import { registerGitTools } from "../../adapters/mcp/git";
import { registerRepoTools } from "../../adapters/mcp/repo";
import { registerInitTools } from "../../adapters/mcp/init";
import { registerRulesTools } from "../../adapters/mcp/rules";
import { registerSessionTools } from "../../adapters/mcp/session";
import { registerPersistenceTools } from "../../adapters/mcp/persistence";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { registerChangesetTools } from "../../adapters/mcp/changeset";
import { registerConfigTools } from "../../adapters/mcp/config";
import { registerValidateTools } from "../../adapters/mcp/validate";
import { registerMcpManagementTools } from "../../adapters/mcp/mcp-commands";
import { registerMemoryTools } from "../../adapters/mcp/memory";
import { registerDetectorsTools } from "../../adapters/mcp/detectors";
import { registerPrincipalCorpusTools } from "../../adapters/mcp/principal-corpus";
import { registerForgeTools } from "../../adapters/mcp/forge";

/**
 * Per-category MCP adapter signature. Each adapter receives the command mapper
 * and (optional) DI container, and is responsible for calling the appropriate
 * `register<Group>CommandsWithMcp` helper (with per-command overrides if any).
 */
export type McpCategoryAdapter = (
  commandMapper: CommandMapper,
  container?: AppContainerInterface
) => void;

/**
 * Dispatch table: CommandCategory → ordered list of per-category MCP adapters.
 *
 * Categories listed here have intentional per-command overrides (hidden flags,
 * description overrides, argDefaults). The discovery loop in `registerAllTools`
 * calls these adapters to preserve those overrides.
 *
 * Categories NOT listed here are auto-bridged via the discovery loop's fallback
 * (`registerSharedCommandsWithMcp` with no overrides). Adding a new
 * CommandCategory + shared-registry commands is sufficient to expose them via
 * MCP — no edit to `start-command.ts` is required.
 *
 * Multiple adapters per category are supported (REPO has both
 * `registerRepoTools` and `registerChangesetTools` — second-call override-merge
 * via addTool's Map semantics, by design).
 *
 * mt#2010 — see `docs/architecture/adr-011-mcp-bridge-discovery.md`.
 */
export const MCP_CATEGORY_ADAPTERS: Partial<Record<CommandCategory, McpCategoryAdapter[]>> = {
  [CommandCategory.DEBUG]: [registerDebugTools],
  [CommandCategory.TASKS]: [registerTaskTools],
  [CommandCategory.SESSION]: [registerSessionTools],
  [CommandCategory.PERSISTENCE]: [registerPersistenceTools],
  [CommandCategory.GIT]: [registerGitTools],
  [CommandCategory.REPO]: [registerRepoTools, registerChangesetTools],
  [CommandCategory.INIT]: [registerInitTools],
  [CommandCategory.RULES]: [registerRulesTools],
  [CommandCategory.CONFIG]: [registerConfigTools],
  [CommandCategory.TOOLS]: [registerValidateTools],
  [CommandCategory.MCP]: [registerMcpManagementTools],
  [CommandCategory.MEMORY]: [registerMemoryTools],
  [CommandCategory.DETECTORS]: [registerDetectorsTools],
  [CommandCategory.PRINCIPAL_CORPUS]: [registerPrincipalCorpusTools],
  [CommandCategory.FORGE]: [registerForgeTools],
};

// mt#2037: `DEFAULT_EXCLUDE_CATEGORIES` and the `excludeCategories` parameter
// it served were both deleted per the mt#2017 investigation verdict
// (https://www.notion.so/367937f03cb4818896c1dc3bf1e752dd). None of the 7
// evaluated narrowing use cases needs the boot-time function-parameter shape:
// per-client / per-scope / per-tenant / per-billing-tier / per-security-class
// all want per-request filtering at OAuth-scope (mt#1666 shipped the
// primitive); per-deployment narrowing belongs at env-var reading in
// `createStartCommand`; operator/dev narrowing is already covered by
// `commandOverrides.hidden`. The reviewer-service "narrowed deployment"
// motivation was realized at the namespace layer (`authorship.get` projection
// in mt#1254), not at deployment. Keeping the parameter directed future
// implementers to the wrong layer.
