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
   * Currently only "notion" is supported.
   */
  private async createProvider(config: KnowledgeSourceConfig): Promise<KnowledgeSourceProvider> {
    switch (config.type) {
      case "notion":
        return this.createNotionProvider(config);
      default:
        throw new Error(
          `Unsupported knowledge source type: "${config.type}". Only "notion" is currently supported.`
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
}
