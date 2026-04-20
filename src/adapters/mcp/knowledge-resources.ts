/**
 * Knowledge MCP Resources
 *
 * Registers knowledge base content as MCP Resources on the server:
 *   knowledge://sources               — lists configured sources
 *   knowledge://{sourceName}/         — lists documents in a source (from index metadata)
 *   knowledge://{sourceName}/{docId}  — reads a specific document (live fetch)
 */

import type { MinskyMCPServer } from "../../mcp/server";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { KnowledgeSourceConfig } from "../../domain/knowledge/types";
import type { AppContainerInterface } from "../../composition/types";

/**
 * Register knowledge MCP resources on the given server.
 */
export function registerKnowledgeResources(
  server: MinskyMCPServer,
  _container?: AppContainerInterface
): void {
  // ── knowledge://sources ────────────────────────────────────────────────────
  server.addResource({
    uri: "knowledge://sources",
    name: "Knowledge Sources",
    description: "Lists all configured knowledge sources and their sync schedules.",
    handler: async (_uri: string) => {
      try {
        const { getConfiguration } = await import("../../domain/configuration");
        const cfg = getConfiguration();
        const sources = ((cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? []).map((s) => ({
          name: s.name,
          type: s.type,
          syncSchedule: s.sync?.schedule ?? "on-demand",
        }));
        return { sources };
      } catch (error) {
        log.error("[knowledge://sources] Failed to list sources", {
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  // ── knowledge://{sourceName}/ ─────────────────────────────────────────────
  // MCP resources use exact URI matching, so we register a wildcard-style
  // handler as a virtual "directory listing" for each source.
  // For a static listing we register a dynamic resource using a URI template
  // pattern. Since the MCP SDK stores resources by exact URI, we register
  // a single catch-all resource that handles both the source listing and
  // document fetch variants.
  //
  // Approach: register one resource per well-known pattern.  Callers are
  // expected to know source names from knowledge://sources.

  server.addResource({
    uri: "knowledge://{sourceName}",
    name: "Knowledge Source Documents",
    description:
      "Lists documents available in a knowledge source. URI format: knowledge://{sourceName}",
    handler: async (uri: string) => {
      // Extract sourceName from URI: knowledge://{sourceName}
      const match = uri.match(/^knowledge:\/\/([^/]+)$/);
      if (!match || !match[1]) {
        throw new Error(`Invalid knowledge source URI: ${uri}`);
      }
      const sourceName = decodeURIComponent(match[1]);

      try {
        const { getConfiguration } = await import("../../domain/configuration");
        const cfg = getConfiguration();
        const sources = (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [];
        const source = sources.find((s) => s.name === sourceName);

        if (!source) {
          throw new Error(
            `Knowledge source not found: "${sourceName}". ` +
              `Available: ${sources.map((s) => s.name).join(", ") || "(none)"}`
          );
        }

        return {
          sourceName,
          type: source.type,
          syncSchedule: source.sync?.schedule ?? "on-demand",
          note: `Use knowledge://${sourceName}/{documentId} to fetch a specific document.`,
        };
      } catch (error) {
        log.error("[knowledge resource] Failed to list source documents", {
          uri,
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  // ── knowledge://{sourceName}/{documentId} ─────────────────────────────────
  server.addResource({
    uri: "knowledge://{sourceName}/{documentId}",
    name: "Knowledge Document",
    description:
      "Reads a specific document from a knowledge source (live fetch). " +
      "URI format: knowledge://{sourceName}/{documentId}",
    handler: async (uri: string) => {
      // Extract sourceName and documentId from URI: knowledge://{sourceName}/{documentId}
      const match = uri.match(/^knowledge:\/\/([^/]+)\/(.+)$/);
      if (!match || !match[1] || !match[2]) {
        throw new Error(`Invalid knowledge document URI: ${uri}`);
      }
      const sourceName = decodeURIComponent(match[1]);
      const documentId = decodeURIComponent(match[2]);

      try {
        const { getConfiguration } = await import("../../domain/configuration");
        const cfg = getConfiguration();
        const sources = (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [];
        const sourceConfig = sources.find((s) => s.name === sourceName);

        if (!sourceConfig) {
          throw new Error(
            `Knowledge source not found: "${sourceName}". ` +
              `Available: ${sources.map((s) => s.name).join(", ") || "(none)"}`
          );
        }

        const token = sourceConfig.auth.token;
        if (!token) {
          throw new Error(
            `API token not found. Provide "auth.token" in the knowledge base configuration.`
          );
        }

        let provider;
        if (sourceConfig.type === "notion") {
          const notionConfig = sourceConfig as KnowledgeSourceConfig & { rootPageId?: string };
          if (!notionConfig.rootPageId) {
            throw new Error(
              `Notion knowledge source "${sourceConfig.name}" requires a "rootPageId" in the configuration.`
            );
          }
          const { NotionKnowledgeProvider } = await import(
            "../../domain/knowledge/providers/notion-provider"
          );
          provider = new NotionKnowledgeProvider(
            notionConfig.rootPageId,
            token,
            sourceConfig.name,
            { excludePatterns: sourceConfig.sync?.excludePatterns }
          );
        } else {
          throw new Error(
            `Unsupported knowledge source type: "${sourceConfig.type}". Only "notion" is currently supported.`
          );
        }

        const doc = await provider.fetchDocument(documentId);

        return {
          title: doc.title,
          content: doc.content,
          url: doc.url,
          lastModified: doc.lastModified,
          source: sourceName,
          id: documentId,
        };
      } catch (error) {
        log.error("[knowledge resource] Failed to fetch document", {
          uri,
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  log.debug("[MCP] Knowledge resources registered", {
    resources: [
      "knowledge://sources",
      "knowledge://{sourceName}",
      "knowledge://{sourceName}/{documentId}",
    ],
  });
}
