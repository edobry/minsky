import { z } from "zod";
import { stringify as yamlStringify } from "yaml";
import { enumSchemas } from "../configuration/schemas/base";
import type { ResolvedRepositoryConfig } from "../session/repository-backend-detection";
import { deriveSlugFromGitRemote } from "../project/slug";

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
  projectSlugOptions?: ProjectSlugOptions
): string {
  const config: Record<string, unknown> = {
    // `tasks.strictIds` is deliberately NOT emitted (mt#4699). It had no
    // production consumer anywhere in the repo — a census found 11 occurrences,
    // all of them definitions, defaults, or test fixtures, and none reading it
    // to make a decision. Writing an unimplemented flag into every new
    // project's committed config gave operators a knob that does nothing. The
    // schema keeps its `false` default (`configuration/schemas/tasks.ts`), so
    // existing configs still parse and `config set tasks.strictIds` still
    // works; only the emission stops.
    tasks: {
      backend: backend,
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

  // The `mcp` section is deliberately NOT emitted here (mt#4699). Transport,
  // port and host are MACHINE scope, not project scope: `mcp start` never reads
  // them (`resolveMcpTransport` in `src/cli-discriminators.ts` derives transport
  // from CLI flags alone), and their only readers are the local
  // client-registration path — `performSetup` and `mcp register`. Committing
  // them meant two developers on one repo could not differ. `performSetup` now
  // writes them to the gitignored `.minsky/config.local.yaml` overlay instead;
  // it still reads this file's `mcp` section when present, so projects
  // initialized before this change keep working.

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
