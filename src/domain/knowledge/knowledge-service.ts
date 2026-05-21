/**
 * Knowledge Service
 *
 * Orchestrates sync operations by loading config and creating the appropriate
 * knowledge source provider for each configured source.
 */

import { injectable } from "tsyringe";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import type { KnowledgeSourceConfig, KnowledgeSourceProvider, SyncReport } from "./types";
import { runSync } from "./ingestion/sync-runner";

/** Notion-specific config with required rootPageId */
interface NotionSourceConfig extends KnowledgeSourceConfig {
  rootPageId: string;
}

/** Google Docs provider config */
interface GoogleDocsSourceConfig extends KnowledgeSourceConfig {
  type: "google-docs";
}

/** GitHub activity provider config */
interface GitHubActivitySourceConfig extends KnowledgeSourceConfig {
  type: "github-activity";
  owner?: string;
  repo?: string;
}

export interface KnowledgeServiceDeps {
  embeddingService: EmbeddingService;
  vectorStorage: VectorStorage;
  config: { knowledgeBases: KnowledgeSourceConfig[] };
}

@injectable()
export class KnowledgeService {
  constructor(private deps: KnowledgeServiceDeps) {}

  /**
   * Sync one or all configured knowledge sources.
   *
   * @param sourceName - If provided, sync only this source. If omitted, sync all.
   * @param options - Optional sync options (e.g. force re-index).
   */
  async sync(sourceName?: string, options?: { force?: boolean }): Promise<SyncReport[]> {
    const sources = sourceName
      ? this.deps.config.knowledgeBases.filter((s) => s.name === sourceName)
      : this.deps.config.knowledgeBases;

    if (sourceName && sources.length === 0) {
      throw new Error(`Knowledge source not found: "${sourceName}"`);
    }

    const reports: SyncReport[] = [];

    for (const source of sources) {
      const provider = await this.createProvider(source);
      const report = await runSync(
        provider,
        { embeddingService: this.deps.embeddingService, vectorStorage: this.deps.vectorStorage },
        options
      );
      reports.push(report);
    }

    return reports;
  }

  /**
   * Return the list of configured knowledge sources.
   */
  getConfiguredSources(): KnowledgeSourceConfig[] {
    return this.deps.config.knowledgeBases;
  }

  /**
   * Create the appropriate provider for a given knowledge source config.
   */
  private async createProvider(config: KnowledgeSourceConfig): Promise<KnowledgeSourceProvider> {
    switch (config.type) {
      case "notion":
        return this.createNotionProvider(config);
      case "google-docs":
        return this.createGoogleDocsProvider(config as GoogleDocsSourceConfig);
      case "github-activity":
        return this.createGitHubActivityProvider(config as GitHubActivitySourceConfig);
      default:
        throw new Error(
          `Unsupported knowledge source type: "${config.type}". Supported types: "notion", "google-docs", "github-activity".`
        );
    }
  }

  private async createNotionProvider(
    config: KnowledgeSourceConfig
  ): Promise<KnowledgeSourceProvider> {
    const token =
      config.auth.token ??
      (config.auth.tokenEnvVar ? process.env[config.auth.tokenEnvVar] : undefined);
    if (!token) {
      const hint = config.auth.tokenEnvVar
        ? `Set the "${config.auth.tokenEnvVar}" environment variable or provide a direct "token" value.`
        : `Provide a direct "token" value in the auth configuration.`;
      throw new Error(`Notion API token not found. ${hint}`);
    }

    const notionConfig = config as NotionSourceConfig;
    if (!notionConfig.rootPageId) {
      throw new Error(
        `Notion knowledge source "${config.name}" requires a "rootPageId" in the configuration.`
      );
    }

    const { rootPageId } = notionConfig;

    // Dynamic import to avoid loading Notion SDK unless needed
    const { NotionKnowledgeProvider } = await import("./providers/notion-provider");
    return new NotionKnowledgeProvider(rootPageId, token, config.name, {
      excludePatterns: config.sync?.excludePatterns,
    });
  }

  private async createGoogleDocsProvider(
    config: GoogleDocsSourceConfig
  ): Promise<KnowledgeSourceProvider> {
    if (!config.driveFolderId && (!config.documentIds || config.documentIds.length === 0)) {
      throw new Error(
        `Google Docs knowledge source "${config.name}" requires either "driveFolderId" or "documentIds" in the configuration.`
      );
    }

    // Resolve access token (direct value takes priority over env var)
    const accessToken =
      config.auth.token ??
      (config.auth.tokenEnvVar ? process.env[config.auth.tokenEnvVar] : undefined);

    // Resolve service account JSON (from env var)
    const serviceAccountJsonStr = config.auth.serviceAccountJsonEnvVar
      ? process.env[config.auth.serviceAccountJsonEnvVar]
      : undefined;

    if (!accessToken && !serviceAccountJsonStr) {
      const hints: string[] = [];
      if (config.auth.tokenEnvVar) hints.push(`"${config.auth.tokenEnvVar}" env var`);
      if (config.auth.serviceAccountJsonEnvVar)
        hints.push(`"${config.auth.serviceAccountJsonEnvVar}" env var`);
      const hintStr = hints.length > 0 ? ` Check: ${hints.join(", ")}.` : "";
      throw new Error(
        `Google Docs auth credentials not found for source "${config.name}".${hintStr}`
      );
    }

    let serviceAccountKey: import("./providers/google-docs-provider").GoogleDocsProviderOptions["serviceAccountKey"];
    if (serviceAccountJsonStr) {
      try {
        serviceAccountKey = JSON.parse(serviceAccountJsonStr) as typeof serviceAccountKey;
      } catch {
        throw new Error(
          `Failed to parse service account JSON for Google Docs source "${config.name}". Ensure the env var contains valid JSON.`
        );
      }
    }

    // Dynamic import to avoid loading crypto/JWT code unless needed
    const { GoogleDocsKnowledgeProvider } = await import("./providers/google-docs-provider");
    return new GoogleDocsKnowledgeProvider(config.name, {
      accessToken,
      serviceAccountKey,
      driveFolderId: config.driveFolderId,
      documentIds: config.documentIds,
      excludePatterns: config.sync?.excludePatterns,
    });
  }

  private async createGitHubActivityProvider(
    config: GitHubActivitySourceConfig
  ): Promise<KnowledgeSourceProvider> {
    const token =
      config.auth.token ??
      (config.auth.tokenEnvVar ? process.env[config.auth.tokenEnvVar] : undefined);
    if (!token) {
      const hint = config.auth.tokenEnvVar
        ? `Set the "${config.auth.tokenEnvVar}" environment variable or provide a direct "token" value.`
        : `Provide a direct "token" value in the auth configuration.`;
      throw new Error(`GitHub API token not found for source "${config.name}". ${hint}`);
    }

    if (!config.owner || !config.repo) {
      throw new Error(
        `GitHub activity source "${config.name}" requires both "owner" and "repo" in the configuration.`
      );
    }

    const { GitHubActivityProvider } = await import("./providers/github-activity-provider");
    return new GitHubActivityProvider(token, config.name, {
      owner: config.owner,
      repo: config.repo,
      states: config.states,
      labels: config.labels,
      excludeLabels: config.excludeLabels,
      excludeAuthors: config.excludeAuthors,
      maxAgeDays: config.maxAgeDays,
    });
  }
}
