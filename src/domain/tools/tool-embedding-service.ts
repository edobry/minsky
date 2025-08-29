import { createHash } from "crypto";
import { createLogger } from "../../utils/logger";
import { type EmbeddingService } from "../ai/embeddings/types";
import { type VectorStorage } from "../storage/vector/types";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { createToolsVectorStorageFromConfig } from "../storage/vector/vector-storage-factory";
import { getConfiguration } from "../configuration";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { sharedCommandRegistry, type SharedCommand } from "../../adapters/shared/command-registry";

const log = createLogger("tool-embedding-service");

export interface ToolEmbeddingServiceConfig {
  threshold?: number; // maximum distance for inclusion
}

/**
 * ToolEmbeddingService: embedding-based tool indexing and retrieval
 * Follows patterns from RuleSimilarityService (mt#445)
 */
export class ToolEmbeddingService {
  constructor(private readonly config: ToolEmbeddingServiceConfig = {}) {}

  /**
   * Index a tool for embedding-based search
   * Returns true if the tool was indexed, false if skipped (up-to-date)
   */
  async indexTool(toolId: string): Promise<boolean> {
    // Get tool from shared command registry
    const tool = sharedCommandRegistry.getCommand(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }

    // Create embedding service and storage
    const embeddingService = await createEmbeddingServiceFromConfig();
    const cfg: any = await getConfiguration();
    const model = cfg?.embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);
    const storage = await createToolsVectorStorageFromConfig(dimension);

    // Extract tool content for embedding
    const content = this.extractToolContent(tool);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Check if up-to-date
    try {
      if (typeof storage.getMetadata === "function") {
        const meta = await storage.getMetadata(toolId);
        const storedHash = meta?.content_hash || meta?.contentHash;
        if (storedHash && storedHash === contentHash) {
          log.debug(`[index] skip up-to-date tool ${toolId}`);
          return false;
        }
      }
    } catch {
      // ignore metadata read errors
    }

    // Generate and store embedding
    const vector = await embeddingService.generateEmbedding(content);
    const metadata = {
      contentHash,
      category: tool.category,
      description: tool.description,
      name: tool.name,
      parameters: Object.keys(tool.parameters || {}),
    };

    await storage.store(toolId, vector, metadata);

    log.debug(`[index] indexed tool ${toolId}`);
    return true;
  }

  /**
   * Index all tools from the shared command registry
   */
  async indexAllTools(): Promise<{ indexed: number; skipped: number; errors: string[] }> {
    const allTools = sharedCommandRegistry.getAllCommands();
    let indexed = 0;
    let skipped = 0;
    const errors: string[] = [];

    log.info(`Starting indexing of ${allTools.length} tools`);

    for (const tool of allTools) {
      try {
        const wasIndexed = await this.indexTool(tool.id);
        if (wasIndexed) {
          indexed++;
        } else {
          skipped++;
        }
      } catch (error) {
        const errorMsg = `Failed to index tool ${tool.id}: ${error instanceof Error ? error.message : String(error)}`;
        log.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    log.info(
      `Tool indexing complete: ${indexed} indexed, ${skipped} skipped, ${errors.length} errors`
    );
    return { indexed, skipped, errors };
  }

  /**
   * Extract meaningful content from a tool for embedding generation
   * This content will be used to generate embeddings for similarity search
   */
  private extractToolContent(tool: SharedCommand): string {
    // Combine tool name, description, category, and parameter names
    // This creates a comprehensive text representation for embedding
    const parts = [tool.name, tool.description, tool.category.toLowerCase()];

    // Add parameter names and descriptions if available
    if (tool.parameters) {
      Object.entries(tool.parameters).forEach(([paramName, paramDef]) => {
        parts.push(paramName);
        if (paramDef.description) {
          parts.push(paramDef.description);
        }
      });
    }

    return parts.filter(Boolean).join(" ");
  }

  /**
   * Get tool metadata for a given tool ID
   */
  async getToolMetadata(toolId: string): Promise<any> {
    try {
      const cfg: any = await getConfiguration();
      const model = cfg?.embeddings?.model || "text-embedding-3-small";
      const dimension = getEmbeddingDimension(model, 1536);
      const storage = await createToolsVectorStorageFromConfig(dimension);

      if (typeof storage.getMetadata === "function") {
        return await storage.getMetadata(toolId);
      }
      return null;
    } catch (error) {
      log.error(`Failed to get tool metadata for ${toolId}:`, error);
      return null;
    }
  }
}

/**
 * Create a configured ToolEmbeddingService instance
 */
export async function createToolEmbeddingService(
  config: ToolEmbeddingServiceConfig = {}
): Promise<ToolEmbeddingService> {
  return new ToolEmbeddingService(config);
}
