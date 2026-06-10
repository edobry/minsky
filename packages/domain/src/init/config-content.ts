import { z } from "zod";
import { stringify as yamlStringify } from "yaml";
import { enumSchemas } from "../configuration/schemas/base";
import type { ResolvedRepositoryConfig } from "../session/repository-backend-detection";
import { deriveSlugFromGitRemote } from "../project/identity";

export interface McpOptions {
  enabled?: boolean;
  transport?: "stdio" | "sse" | "httpStream";
  port?: number;
  host?: string;
}

/**
 * Options for project slug stamping during `minsky init`.
 *
 * `projectSlug` is the stable identifier written into `.minsky/config.yaml`
 * under `project.slug`. When omitted, `getMinskyConfigContentYaml` tries to
 * auto-derive it from the git remote (if `repoPath` is provided). Callers
 * that know the slug (e.g. after running `deriveSlugFromGitRemote` in advance)
 * should pass it explicitly.
 */
export interface ProjectSlugOptions {
  /**
   * Explicit project slug to stamp. Takes precedence over auto-derivation.
   * Example: `"edobry/minsky"`.
   */
  projectSlug?: string;
  /**
   * Repo root path used for git-remote auto-derivation when `projectSlug`
   * is not provided. Defaults to `process.cwd()` when absent.
   */
  repoPath?: string;
}

/**
 * Returns the content for the main Minsky config file in YAML format.
 * Stamps `project.slug` if it can be derived from the git remote or is
 * provided explicitly via `projectSlugOptions`.
 *
 * The slug defaults to `owner/repo` (e.g. `edobry/minsky`) derived from the
 * `origin` remote. See `packages/domain/src/project/identity.ts` for the full
 * slug-derivation rationale and stability tradeoffs.
 */
export function getMinskyConfigContentYaml(
  backend: z.infer<typeof enumSchemas.backendType>,
  repository?: ResolvedRepositoryConfig,
  mcp?: McpOptions,
  projectSlugOptions?: ProjectSlugOptions
): string {
  const config: Record<string, unknown> = {
    tasks: {
      backend: backend,
      strictIds: false,
    },
    persistence: {
      // Postgres is the sole supported backend (ADR-018 / mt#2349). Set
      // persistence.postgres.connectionString (or MINSKY_POSTGRES_URL) to a
      // Postgres/Supabase connection — there is no local-file fallback.
      backend: "postgres",
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

  // Stamp project.slug (mt#2414). Try explicit option first, then auto-derive
  // from git remote.
  const slug =
    projectSlugOptions?.projectSlug ??
    (projectSlugOptions?.repoPath
      ? deriveSlugFromGitRemote(projectSlugOptions.repoPath)
      : undefined);

  if (slug) {
    config.project = { slug };
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
