/**
 * Shared Commands Index
 *
 * Exports all command registration functions.
 * This file serves as the central point for registering all shared commands.
 */

import type { AppContainerInterface } from "../../../composition/types";
import { registerGitCommands } from "./git";
import { registerRepoCommands } from "./repo";
import { registerTasksCommands } from "./tasks";
import { registerSessionCommands } from "./session";
import { registerRulesCommands } from "./rules";
import { registerInitCommands } from "./init";
import { registerSetupCommands } from "./setup";
import { registerSetupGithubAppCommand } from "./setup-github-app";
import { registerConfigCommands } from "./config";
import { registerDebugCommands } from "./debug";
import { registerPersistenceCommands } from "./persistence";
import { registerAiCommands } from "./ai";
import { registerToolsCommands } from "./tools";
import { registerAsksCommands } from "./asks";
import { registerPrWatchCommands } from "./pr-watch";
import { registerReviewerWatchCommands } from "./reviewer-watch";
import { registerChangesetCommands } from "./changeset";
import { registerValidateCommands } from "./validate";
import { registerMcpCommands } from "./mcp";
import { registerKnowledgeCommands } from "./knowledge";
import { registerMemoryCommands } from "./memory";
import { registerProvenanceCommands } from "./provenance";
import { registerAuthorshipCommands } from "./authorship";
import { registerCompileCommands } from "./compile/compile-commands";
import { registerWorkspaceCommands } from "./workspace/info-command";
import { registerTranscriptCommands } from "./transcripts";
import { registerAttentionCommands } from "./attention";
import { registerWindowCommands } from "./window";
import { registerUnaskedDirectionCommands } from "./unasked-direction";
import { registerEpicDecompositionCommands } from "./epic-decomposition";
import { registerObservabilityCommands } from "./observability";
import { sharedCommandRegistry } from "../command-registry";

/**
 * Register all shared commands in the shared command registry.
 * @param container Optional DI container — when provided, command groups can
 *   resolve services from it instead of reaching into singletons.
 */
export async function registerAllSharedCommands(container?: AppContainerInterface): Promise<void> {
  // Register git commands — pass container for DI migration (mt#929)
  registerGitCommands(container);

  // Register repo exploration commands
  registerRepoCommands();

  // Register tasks commands
  registerTasksCommands(container);

  // Register session commands (async) — pass container for DI migration (mt#761)
  await registerSessionCommands(undefined, container);

  // Register rules commands
  registerRulesCommands();

  // Register init commands
  registerInitCommands();

  // Register setup commands
  registerSetupCommands();

  // Register `setup github-app` subcommand (mt#1087)
  registerSetupGithubAppCommand();

  // Register config commands
  registerConfigCommands();

  // Register debug commands
  registerDebugCommands();

  // Register persistence commands — pass container for DI migration (mt#929)
  registerPersistenceCommands(container);

  // Register AI commands
  registerAiCommands();

  // Register tools commands
  registerToolsCommands(container);

  // Register asks commands (Ask subsystem — mt#1034 / ADR-008)
  registerAsksCommands(container);

  // Register pr-watch commands (PR-state watcher — mt#1295)
  registerPrWatchCommands(container);

  // Register reviewer-watch commands (local missed-review alerter — mt#1310)
  registerReviewerWatchCommands();

  // Register changeset commands
  registerChangesetCommands();

  // Register validate commands (lint and typecheck)
  registerValidateCommands();

  // Register MCP commands
  registerMcpCommands();

  // Register knowledge commands
  registerKnowledgeCommands();

  // Register memory commands
  registerMemoryCommands();

  // Register provenance commands
  registerProvenanceCommands(container);

  // Register authorship commands
  registerAuthorshipCommands(container);

  // Register compile commands
  registerCompileCommands(sharedCommandRegistry);

  // Register workspace commands (workspace.info — always available, no setup required)
  registerWorkspaceCommands();

  // Register transcript commands (transcripts.ingest — mt#1351)
  registerTranscriptCommands(container);

  // Register attention commands (attention.report — mt#1071 / ADR-008)
  registerAttentionCommands(container);

  // Register window commands (attention windows — mt#1489 / mt#1411)
  registerWindowCommands(container);

  // Register unasked-direction commands (Surface 4 weekly review — mt#1543)
  registerUnaskedDirectionCommands();

  // Register epic-decomposition audit command (Shape C of attention-allocation
  // noticer family — mt#1710)
  registerEpicDecompositionCommands(container);

  // Register observability commands (Braintrust smoke-test etc. — mt#1795)
  registerObservabilityCommands();

  // Additional command categories can be registered here as they're implemented
}

// Export individual command registration functions to allow
// per-category registration when needed
export {
  registerGitCommands,
  registerTasksCommands,
  registerSessionCommands,
  registerRulesCommands,
  registerInitCommands,
  registerSetupCommands,
  registerSetupGithubAppCommand,
  registerConfigCommands,
  registerDebugCommands,
  registerPersistenceCommands,
  registerAiCommands,
  registerToolsCommands,
  registerAsksCommands,
  registerPrWatchCommands,
  registerReviewerWatchCommands,
  registerChangesetCommands,
  registerValidateCommands,
  registerMcpCommands,
  registerKnowledgeCommands,
  registerMemoryCommands,
  registerRepoCommands,
  registerProvenanceCommands,
  registerAuthorshipCommands,
  registerCompileCommands,
  registerWorkspaceCommands,
  registerTranscriptCommands,
  registerAttentionCommands,
  registerWindowCommands,
  registerUnaskedDirectionCommands,
  registerEpicDecompositionCommands,
  registerObservabilityCommands,
};
