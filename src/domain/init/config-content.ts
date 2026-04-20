import { z } from "zod";
import { stringify as yamlStringify } from "yaml";
import { enumSchemas } from "../configuration/schemas/base";
import type { ResolvedRepositoryConfig } from "../session/repository-backend-detection";

export interface McpOptions {
  enabled?: boolean;
  transport?: "stdio" | "sse" | "httpStream";
  port?: number;
  host?: string;
}

/**
 * Returns the content for the main Minsky config file in YAML format
 */
export function getMinskyConfigContentYaml(
  backend: z.infer<typeof enumSchemas.backendType>,
  repository?: ResolvedRepositoryConfig,
  mcp?: McpOptions
): string {
  const config: Record<string, unknown> = {
    tasks: {
      backend: backend,
      strictIds: false,
    },
    sessiondb: {
      backend: "sqlite",
    },
    logger: {
      mode: "auto",
      level: "info",
      enableAgentLogs: false,
    },
  };

  if (repository) {
    const repoSection: Record<string, unknown> = { backend: repository.backend };
    if (repository.url) {
      repoSection.url = repository.url;
    }
    if (repository.github) {
      repoSection.github = repository.github;
    }
    config.repository = repoSection;
  }

  if (mcp) {
    const mcpSection: Record<string, unknown> = {
      transport: mcp.transport ?? "stdio",
    };
    if (mcp.port !== undefined) {
      mcpSection.port = mcp.port;
    }
    if (mcp.host !== undefined) {
      mcpSection.host = mcp.host;
    }
    config.mcp = mcpSection;
  }

  return yamlStringify(config);
}

/**
 * Returns the content for the local (machine-specific, gitignored) Minsky config file.
 * Currently stores workspace.mainPath so session_start can use --reference cloning.
 */
export function getLocalConfigContentYaml(repoPath: string): string {
  return yamlStringify({ workspace: { mainPath: repoPath } });
}
