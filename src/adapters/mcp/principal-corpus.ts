/**
 * MCP adapter for principal-corpus commands (mt#1930).
 *
 * Exposes the three principal-corpus commands as MCP tools under their
 * canonical `command.id`:
 * - `principal_corpus.search` — semantic search over the indexed tweets
 * - `principal_corpus.similar` — similarity by tweet ID
 * - `principal_corpus.index-embeddings` — ingestion pipeline
 *
 * Without this wiring the commands would be registered in the shared
 * command registry (via `registerPrincipalCorpusCommands` in
 * `src/adapters/shared/commands/principal-corpus.ts`) but the MCP
 * bridge would never emit them — same bug class as mt#386
 * (`registerGitTools` missing).
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerPrincipalCorpusCommandsWithMcp } from "./shared-command-integration";
import { log } from "@minsky/shared/logger";

export function registerPrincipalCorpusTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  log.debug("Registering principal-corpus commands via shared command integration");

  registerPrincipalCorpusCommandsWithMcp(commandMapper, {
    container,
    debug: true,
  });
}
