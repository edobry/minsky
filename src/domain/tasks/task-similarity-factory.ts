/**
 * Task Similarity Service Factory
 *
 * Creates TaskSimilarityService instances with proper dependency injection.
 * This demonstrates the pattern for service integration with PersistenceProvider.
 */

import { TaskSimilarityService } from "./task-similarity-service";
import { PersistenceProvider } from "../persistence";
import { createEmbeddingServiceFromConfig } from "../ai/embedding-service-factory";
import { getEmbeddingDimension } from "../ai/embedding-models";
import { getConfiguration } from "../configuration";
import { log } from "../../utils/logger";

/**
 * Create TaskSimilarityService with injected persistence provider
 */
export async function createTaskSimilarityServiceWithProvider(
  persistence: PersistenceProvider,
  taskService: any  // Avoid circular dependency
): Promise<TaskSimilarityService> {
  // Check capabilities
  if (!persistence.capabilities.vectorStorage) {
    throw new Error('Vector storage not supported by current persistence backend');
  }
  
  // Get configuration for model settings
  const cfg = await getConfiguration();
  const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);
  
  // Create services
  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await persistence.getVectorStorage!(dimension);
  
  if (!vectorStorage) {
    throw new Error('Failed to create vector storage from persistence provider');
  }
  
  // Create task accessor functions
  const findTaskById = async (id: string) => taskService.getTask(id);
  const searchTasks = async (_: { text?: string }) => taskService.listTasks({});
  const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);
  
  log.debug(`Creating TaskSimilarityService with ${persistence.getConnectionInfo()}`);
  
  return new TaskSimilarityService(
    embeddingService,
    vectorStorage,
    findTaskById,
    searchTasks,
    getTaskSpecContent,
    {
      vectorLimit: 10,
      model,
      dimension,
    }
  );
}

/**
 * Example usage in application initialization:
 * 
 * ```typescript
 * import { PersistenceService } from "../persistence";
 * import { createConfiguredTaskService } from "../tasks/taskService";
 * import { createTaskSimilarityServiceWithProvider } from "./task-similarity-factory";
 * 
 * async function initializeServices() {
 *   // Initialize persistence first
 *   await PersistenceService.initialize();
 *   const persistence = PersistenceService.getProvider();
 *   
 *   // Create task service
 *   const taskService = await createConfiguredTaskService({ workspacePath: process.cwd() });
 *   
 *   // Create similarity service with injected persistence
 *   const similarityService = await createTaskSimilarityServiceWithProvider(
 *     persistence,
 *     taskService
 *   );
 *   
 *   return { persistence, taskService, similarityService };
 * }
 * ```
 */
