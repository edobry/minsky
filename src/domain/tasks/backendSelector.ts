/**
 * Backend Selection System for Task #315
 * 
 * Provides capability-aware backend selection for optimal task management.
 * This demonstrates Phase 4 integration patterns.
 */

import type { TaskBackend } from "./taskBackend";
import type { BackendCapabilities } from "./types";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";

/**
 * Requirements for selecting an appropriate backend
 */
export interface BackendRequirements {
  // Core operations
  requiresTaskCreation?: boolean;
  requiresTaskUpdate?: boolean;
  requiresTaskDeletion?: boolean;
  
  // Essential metadata support
  requiresStatus?: boolean;
  
  // Structural metadata (Tasks #238, #239)
  requiresSubtasks?: boolean;
  requiresDependencies?: boolean;
  
  // Provenance metadata
  requiresOriginalRequirements?: boolean;
  requiresAiEnhancementTracking?: boolean;
  
  // Query capabilities
  requiresMetadataQuery?: boolean;
  requiresFullTextSearch?: boolean;
  
  // Update mechanism preferences
  allowsSpecialWorkspace?: boolean;
  requiresTransactions?: boolean;
  requiresRealTimeSync?: boolean;
}

/**
 * Backend selection result
 */
export interface BackendSelectionResult {
  backend: TaskBackend;
  capabilities: BackendCapabilities;
  score: number;
  reasons: string[];
  limitations: string[];
}

/**
 * Smart backend selector based on capabilities and requirements
 */
export class BackendSelector {
  private availableBackends: Map<string, () => TaskBackend> = new Map();

  constructor() {
    // Register available backend factories
    this.availableBackends.set("markdown", () => 
      createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: process.cwd(), // Default workspace
      })
    );
    
    this.availableBackends.set("json-file", () => 
      createJsonFileTaskBackend({
        name: "json-file", 
        workspacePath: process.cwd(), // Default workspace
      })
    );
  }

  /**
   * Select the best backend based on requirements
   */
  selectBackend(requirements: BackendRequirements): BackendSelectionResult {
    const candidates: BackendSelectionResult[] = [];

    // Evaluate each available backend
    for (const [name, factory] of this.availableBackends) {
      try {
        const backend = factory();
        const capabilities = backend.getCapabilities();
        const evaluation = this.evaluateBackend(capabilities, requirements);
        
        candidates.push({
          backend,
          capabilities,
          score: evaluation.score,
          reasons: evaluation.reasons,
          limitations: evaluation.limitations,
        });

        log.debug(`Backend evaluation: ${name}`, {
          score: evaluation.score,
          reasons: evaluation.reasons,
          limitations: evaluation.limitations,
        });
      } catch (error) {
        log.warn(`Failed to evaluate backend: ${name}`, { error });
      }
    }

    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      throw new Error("No suitable backends found");
    }

    const selected = candidates[0];
    
    if (selected.score === 0) {
      log.warn("Selected backend has score 0 - requirements may not be met", {
        backend: selected.backend.name,
        limitations: selected.limitations,
      });
    }

    log.info("Backend selected", {
      backend: selected.backend.name,
      score: selected.score,
      reasons: selected.reasons,
    });

    return selected;
  }

  /**
   * Evaluate how well a backend meets the requirements
   */
  private evaluateBackend(
    capabilities: BackendCapabilities,
    requirements: BackendRequirements
  ): { score: number; reasons: string[]; limitations: string[] } {
    let score = 0;
    const reasons: string[] = [];
    const limitations: string[] = [];

    // Core operations (high priority)
    if (requirements.requiresTaskCreation && capabilities.supportsTaskCreation) {
      score += 20;
      reasons.push("Supports task creation");
    } else if (requirements.requiresTaskCreation) {
      limitations.push("Does not support task creation");
    }

    if (requirements.requiresTaskUpdate && capabilities.supportsTaskUpdate) {
      score += 20;
      reasons.push("Supports task updates");
    } else if (requirements.requiresTaskUpdate) {
      limitations.push("Does not support task updates");
    }

    if (requirements.requiresTaskDeletion && capabilities.supportsTaskDeletion) {
      score += 15;
      reasons.push("Supports task deletion");
    } else if (requirements.requiresTaskDeletion) {
      limitations.push("Does not support task deletion");
    }

    // Essential metadata (medium priority)
    if (requirements.requiresStatus && capabilities.supportsStatus) {
      score += 10;
      reasons.push("Supports status tracking");
    } else if (requirements.requiresStatus) {
      limitations.push("Does not support status tracking");
    }

    // Structural metadata (high priority for Tasks #238, #239)
    if (requirements.requiresSubtasks && capabilities.supportsSubtasks) {
      score += 25;
      reasons.push("Supports subtasks (Task #238)");
    } else if (requirements.requiresSubtasks) {
      limitations.push("Does not support subtasks - consider JSON backend");
      score -= 10; // Penalty for missing critical feature
    }

    if (requirements.requiresDependencies && capabilities.supportsDependencies) {
      score += 25;
      reasons.push("Supports dependencies (Task #239)");
    } else if (requirements.requiresDependencies) {
      limitations.push("Does not support dependencies - consider JSON backend");
      score -= 10; // Penalty for missing critical feature
    }

    // Provenance metadata (medium priority)
    if (requirements.requiresOriginalRequirements && capabilities.supportsOriginalRequirements) {
      score += 15;
      reasons.push("Supports original requirements tracking");
    } else if (requirements.requiresOriginalRequirements) {
      limitations.push("Does not support original requirements tracking");
    }

    if (requirements.requiresAiEnhancementTracking && capabilities.supportsAiEnhancementTracking) {
      score += 15;
      reasons.push("Supports AI enhancement tracking");
    } else if (requirements.requiresAiEnhancementTracking) {
      limitations.push("Does not support AI enhancement tracking");
    }

    // Query capabilities (medium priority)
    if (requirements.requiresMetadataQuery && capabilities.supportsMetadataQuery) {
      score += 15;
      reasons.push("Supports metadata queries");
    } else if (requirements.requiresMetadataQuery) {
      limitations.push("Does not support metadata queries");
    }

    if (requirements.requiresFullTextSearch && capabilities.supportsFullTextSearch) {
      score += 10;
      reasons.push("Supports full-text search");
    } else if (requirements.requiresFullTextSearch) {
      limitations.push("Does not support full-text search");
    }

    // Update mechanism preferences (low priority)
    if (requirements.allowsSpecialWorkspace === false && capabilities.requiresSpecialWorkspace) {
      score -= 5;
      limitations.push("Requires special workspace (may be inconvenient)");
    } else if (requirements.allowsSpecialWorkspace !== false && capabilities.requiresSpecialWorkspace) {
      reasons.push("Uses special workspace for consistency");
    }

    if (requirements.requiresTransactions && capabilities.supportsTransactions) {
      score += 10;
      reasons.push("Supports transactions for data integrity");
    } else if (requirements.requiresTransactions) {
      limitations.push("Does not support transactions");
    }

    if (requirements.requiresRealTimeSync && capabilities.supportsRealTimeSync) {
      score += 5;
      reasons.push("Supports real-time synchronization");
    } else if (requirements.requiresRealTimeSync) {
      limitations.push("Does not support real-time sync");
    }

    return { score, reasons, limitations };
  }

  /**
   * Get recommendations for future task requirements
   */
  getRecommendationsForTasks(taskNumbers: string[]): BackendSelectionResult {
    const requirements: BackendRequirements = {
      requiresTaskCreation: true,
      requiresTaskUpdate: true,
      requiresTaskDeletion: true,
      requiresStatus: true,
    };

    // Add requirements based on task numbers
    if (taskNumbers.includes("238")) {
      requirements.requiresSubtasks = true;
      requirements.requiresMetadataQuery = true;
    }

    if (taskNumbers.includes("239")) {
      requirements.requiresDependencies = true;
      requirements.requiresMetadataQuery = true;
    }

    if (taskNumbers.some(t => parseInt(t) > 300)) {
      // Future tasks likely need advanced features
      requirements.requiresOriginalRequirements = true;
      requirements.requiresAiEnhancementTracking = true;
      requirements.requiresTransactions = true;
    }

    return this.selectBackend(requirements);
  }
}

/**
 * Create a backend selector instance
 */
export function createBackendSelector(): BackendSelector {
  return new BackendSelector();
}

/**
 * Convenience function for quick backend selection
 */
export function selectOptimalBackend(requirements: BackendRequirements): TaskBackend {
  const selector = createBackendSelector();
  const result = selector.selectBackend(requirements);
  return result.backend;
}