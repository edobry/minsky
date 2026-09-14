import { z } from "zod";

/**
 * Workspace configuration schema
 * Provides a main workspace path used by in-tree task backends
 */
export const workspaceConfigSchema = z
  .object({
    /**
     * Absolute path to the main workspace root
     */
    mainPath: z.string().min(1).optional(),

    /**
     * The MCP client harness registered for this workspace (e.g. "cursor",
     * "claude-desktop"). Written by `minsky setup --client <X>` and stored
     * in `.minsky/config.local.yaml` so the chosen harness is remembered
     * across subsequent invocations.
     */
    harness: z.string().optional(),

    /**
     * How `harness` was chosen (mt#5153): `flag` (an explicit `--client`),
     * `env` (the CLI process's own harness environment), `mcp-client` (the
     * identity of the MCP client that ran `init`/`setup`), or `installed`
     * (the only MCP client found on this machine). Absent on a file written
     * before this field existed — which `config doctor` (mt#5154) reads as
     * "unverified", not as any of the four.
     */
    harnessSource: z.enum(["flag", "env", "mcp-client", "installed"]).optional(),
  })
  .default({});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
