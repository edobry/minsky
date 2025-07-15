/**
 * Advanced Resolution Strategies
 * 
 * Provides advanced conflict resolution strategy generation extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { log } from "../../utils/logger";
import type {
  AdvancedResolutionStrategy,
  ConflictFile,
} from "./conflict-detection";

export interface AdvancedResolutionDependencies {
  identifyFormattingOnlyConflicts: (repoPath: string, conflictFiles: ConflictFile[]) => Promise<ConflictFile[]>;
  createPackageJsonStrategy: (packageJsonFiles: ConflictFile[]) => AdvancedResolutionStrategy;
  createLockFileStrategy: (lockFiles: ConflictFile[]) => AdvancedResolutionStrategy;
  createFormattingOnlyStrategy: (formattingOnlyConflicts: ConflictFile[]) => AdvancedResolutionStrategy;
  createDocumentationStrategy: (documentationFiles: ConflictFile[]) => AdvancedResolutionStrategy;
  createConfigFileStrategy: (configFiles: ConflictFile[]) => AdvancedResolutionStrategy;
  createGeneralStrategy: (remainingFiles: ConflictFile[]) => AdvancedResolutionStrategy;
}

export async function generateAdvancedResolutionStrategiesImpl(
  repoPath: string,
  conflictFiles: ConflictFile[],
  deps: AdvancedResolutionDependencies
): Promise<AdvancedResolutionStrategy[]> {
  log.debug("Generating advanced resolution strategies", {
    repoPath,
    conflictFiles,
  });

  try {
    const strategies: AdvancedResolutionStrategy[] = [];

    // No conflicts, no strategies needed
    if (conflictFiles.length === 0) {
      return strategies;
    }

    // Group files by type for specialized handling
    const packageJsonFiles = conflictFiles.filter((file) =>
      file.path.endsWith("package.json")
    );
    const lockFiles = conflictFiles.filter(
      (file) =>
        file.path.endsWith("package-lock.json") ||
        file.path.endsWith("yarn.lock") ||
        file.path.endsWith("bun.lock")
    );
    const configFiles = conflictFiles.filter(
      (file) =>
        file.path.endsWith(".json") ||
        file.path.endsWith(".yaml") ||
        file.path.endsWith(".yml") ||
        file.path.endsWith(".toml")
    );
    const documentationFiles = conflictFiles.filter(
      (file) =>
        file.path.endsWith(".md") ||
        file.path.endsWith(".txt") ||
        file.path.match(/README|CHANGELOG|LICENSE|CONTRIBUTING/)
    );
    const formattingOnlyConflicts = await deps.identifyFormattingOnlyConflicts(
      repoPath,
      conflictFiles
    );

    // 1. Handle package.json conflicts
    if (packageJsonFiles.length > 0) {
      strategies.push(deps.createPackageJsonStrategy(packageJsonFiles));
    }

    // 2. Handle lock file conflicts
    if (lockFiles.length > 0) {
      strategies.push(deps.createLockFileStrategy(lockFiles));
    }

    // 3. Handle formatting-only conflicts
    if (formattingOnlyConflicts.length > 0) {
      strategies.push(
        deps.createFormattingOnlyStrategy(formattingOnlyConflicts)
      );
    }

    // 4. Handle documentation conflicts
    if (documentationFiles.length > 0) {
      strategies.push(deps.createDocumentationStrategy(documentationFiles));
    }

    // 5. Handle configuration files
    if (configFiles.length > 0) {
      strategies.push(deps.createConfigFileStrategy(configFiles));
    }

    // 6. Add a general strategy for remaining files
    const handledPaths = new Set([
      ...packageJsonFiles,
      ...lockFiles,
      ...formattingOnlyConflicts,
      ...documentationFiles,
      ...configFiles,
    ].map((file) => file.path));

    const remainingFiles = conflictFiles.filter(
      (file) => !handledPaths.has(file.path)
    );

    if (remainingFiles.length > 0) {
      strategies.push(deps.createGeneralStrategy(remainingFiles));
    }

    return strategies;
  } catch (error) {
    log.error("Error generating advanced resolution strategies", {
      error,
      repoPath,
      conflictFiles,
    });
    return [];
  }
} 
