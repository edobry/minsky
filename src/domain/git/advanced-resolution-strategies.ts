/**
 * Advanced Resolution Strategies
 *
 * Provides advanced conflict resolution strategy generation extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import type { AdvancedResolutionStrategy, ConflictFile } from "./conflict-detection-types";
import { FileConflictStatus } from "./conflict-detection-types";

/**
 * Identifies conflicts that are purely formatting/whitespace differences
 */
export async function identifyFormattingOnlyConflicts(
  repoPath: string,
  conflictFiles: ConflictFile[]
): Promise<ConflictFile[]> {
  const formattingOnlyFiles: ConflictFile[] = [];

  for (const file of conflictFiles) {
    // Skip files that aren't content conflicts
    if (file.status !== FileConflictStatus.MODIFIED_BOTH) {
      continue;
    }

    try {
      // Get the conflict markers content
      const { stdout: fileContent } = await execAsync(
        `git -C ${repoPath} show :1:${file.path} | tr -d '\\r\\n\\t '`
      );
      const { stdout: ourContent } = await execAsync(
        `git -C ${repoPath} show :2:${file.path} | tr -d '\\r\\n\\t '`
      );
      const { stdout: theirContent } = await execAsync(
        `git -C ${repoPath} show :3:${file.path} | tr -d '\\r\\n\\t '`
      );

      // If the content is the same when whitespace is removed, it's a formatting-only conflict
      if (
        ourContent.toString().trim() === theirContent.toString().trim() &&
        ourContent.toString().trim() !== fileContent.toString().trim()
      ) {
        formattingOnlyFiles.push(file);
      }
    } catch (error) {
      // Skip this file if we can't analyze it
      log.warn("Could not analyze file for formatting-only conflicts", {
        file: file.path,
        error,
      });
    }
  }

  return formattingOnlyFiles;
}

/**
 * Creates a resolution strategy for package.json conflicts
 */
export function createPackageJsonStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "pattern_based",
    confidence: 0.85,
    description: "Intelligently merge package.json dependencies by combining both sets of changes",
    commands: [
      "# For each package.json file:",
      ...files.map(
        (file) => `
# 1. Extract dependencies from both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}
cp ${file.path} ${file.path}.ours

# 2. Use jq to merge dependencies
jq -s '.[0].dependencies * .[1].dependencies | {dependencies: .}' ${file.path}.ours ${file.path}.theirs > ${file.path}.deps
jq -s '.[0].devDependencies * .[1].devDependencies | {devDependencies: .}' ${file.path}.ours ${file.path}.theirs > ${file.path}.devdeps

# 3. Merge the dependencies back into the main file
jq -s '.[0] * .[1] * .[2]' ${file.path} ${file.path}.deps ${file.path}.devdeps > ${file.path}.merged
mv ${file.path}.merged ${file.path}

# 4. Clean up temporary files
rm ${file.path}.{ours,theirs,deps,devdeps}

# 5. Add the resolved file
git add ${file.path}`
      ),
      "# After resolving all files:",
      'git commit -m "Resolve package.json conflicts with intelligent dependency merge"',
    ],
    riskLevel: "medium",
    applicableFileTypes: ["package.json"],
  };
}

/**
 * Creates a resolution strategy for lock file conflicts
 */
export function createLockFileStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "pattern_based",
    confidence: 0.9,
    description: "Resolve lock file conflicts by regenerating from the merged package.json",
    commands: [
      "# First, ensure package.json is resolved correctly",
      "# Then regenerate lock files:",
      ...files.map((file) => `git checkout --ours ${file.path}`),
      "# Remove all lock files",
      ...files.map((file) => `rm ${file.path}`),
      "# Regenerate lock files based on your package manager:",
      "# For npm:",
      "npm install",
      "# For yarn:",
      "# yarn",
      "# For bun:",
      "# bun install",
      "# Add the regenerated lock files:",
      ...files.map((file) => `git add ${file.path}`),
      'git commit -m "Resolve lock file conflicts by regenerating lock files"',
    ],
    riskLevel: "low",
    applicableFileTypes: ["package-lock.json", "yarn.lock", "bun.lock"],
  };
}

/**
 * Creates a resolution strategy for formatting-only conflicts
 */
export function createFormattingOnlyStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "intelligent",
    confidence: 0.95,
    description: "Auto-resolve formatting-only conflicts by keeping our version and reformatting",
    commands: [
      "# For formatting-only conflicts, keep our version:",
      ...files.map((file) => `git checkout --ours ${file.path}`),
      "# Run formatter on the files:",
      "# For TypeScript/JavaScript:",
      ...files
        .filter(
          (file) =>
            file.path.endsWith(".ts") ||
            file.path.endsWith(".js") ||
            file.path.endsWith(".tsx") ||
            file.path.endsWith(".jsx")
        )
        .map((file) => `npx prettier --write ${file.path}`),
      "# Add the resolved files:",
      ...files.map((file) => `git add ${file.path}`),
      'git commit -m "Resolve formatting-only conflicts"',
    ],
    riskLevel: "low",
    applicableFileTypes: ["*.ts", "*.js", "*.tsx", "*.jsx", "*.css", "*.scss", "*.html"],
  };
}

/**
 * Creates a resolution strategy for documentation file conflicts
 */
export function createDocumentationStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "pattern_based",
    confidence: 0.8,
    description: "Resolve documentation conflicts by combining both versions with clear separation",
    commands: [
      "# For each documentation file:",
      ...files.map(
        (file) => `
# 1. Extract both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}

# 2. Combine the files with clear separation
echo "\\n\\n<!-- Combined from both versions during merge resolution -->\\n\\n" >> ${file.path}
cat ${file.path}.theirs >> ${file.path}

# 3. Clean up
rm ${file.path}.theirs

# 4. Add the resolved file
git add ${file.path}`
      ),
      'git commit -m "Resolve documentation conflicts by combining content"',
    ],
    riskLevel: "low",
    applicableFileTypes: ["*.md", "README*", "CHANGELOG*", "*.txt"],
  };
}

/**
 * Creates a resolution strategy for config file conflicts
 */
export function createConfigFileStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "pattern_based",
    confidence: 0.75,
    description: "Resolve config file conflicts by merging JSON/YAML structures",
    commands: [
      "# For each config file:",
      ...files.map(
        (file) => `
# 1. Extract both versions
git checkout --theirs ${file.path}
cp ${file.path} ${file.path}.theirs
git checkout --ours ${file.path}
cp ${file.path} ${file.path}.ours

# 2. For JSON files, use jq to merge
if [[ "${file.path}" == *.json ]]; then
  jq -s '.[0] * .[1]' ${file.path}.ours ${file.path}.theirs > ${file.path}
fi

# 3. For YAML files, consider manual merge or specialized tools
if [[ "${file.path}" == *.yml || "${file.path}" == *.yaml ]]; then
  # This is a placeholder - manual merge may be needed
  echo "# CONFLICT: Manual merge needed for YAML" > ${file.path}.merged
  echo "# OUR VERSION:" >> ${file.path}.merged
  cat ${file.path}.ours >> ${file.path}.merged
  echo "\\n# THEIR VERSION:" >> ${file.path}.merged
  cat ${file.path}.theirs >> ${file.path}.merged
  mv ${file.path}.merged ${file.path}
fi

# 4. Clean up
rm ${file.path}.ours ${file.path}.theirs

# 5. Add the resolved file
git add ${file.path}`
      ),
      'git commit -m "Resolve configuration file conflicts"',
    ],
    riskLevel: "medium",
    applicableFileTypes: ["*.json", "*.yaml", "*.yml", "*.toml"],
  };
}

/**
 * Creates a general resolution strategy for files that don't match specific patterns
 */
export function createGeneralStrategy(files: ConflictFile[]): AdvancedResolutionStrategy {
  return {
    type: "user_preference",
    confidence: 0.6,
    description: "General conflict resolution strategy with clear conflict markers",
    commands: [
      "# For each conflicted file:",
      ...files.map(
        (file) => `
# Open ${file.path} in your editor and resolve conflicts
# Look for <<<<<<< HEAD, =======, and >>>>>>> markers
# After resolving conflicts:
git add ${file.path}`
      ),
      "# After resolving all files:",
      'git commit -m "Resolve remaining conflicts"',
    ],
    riskLevel: "medium",
    applicableFileTypes: ["*"],
  };
}

/**
 * Generates advanced resolution strategies for conflict files.
 * Groups files by type and applies specialized strategies.
 */
export async function generateAdvancedResolutionStrategiesImpl(
  repoPath: string,
  conflictFiles: ConflictFile[]
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
    const packageJsonFiles = conflictFiles.filter((file) => file.path.endsWith("package.json"));
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
    const formattingOnlyConflicts = await identifyFormattingOnlyConflicts(repoPath, conflictFiles);

    // 1. Handle package.json conflicts
    if (packageJsonFiles.length > 0) {
      strategies.push(createPackageJsonStrategy(packageJsonFiles));
    }

    // 2. Handle lock file conflicts
    if (lockFiles.length > 0) {
      strategies.push(createLockFileStrategy(lockFiles));
    }

    // 3. Handle formatting-only conflicts
    if (formattingOnlyConflicts.length > 0) {
      strategies.push(createFormattingOnlyStrategy(formattingOnlyConflicts));
    }

    // 4. Handle documentation conflicts
    if (documentationFiles.length > 0) {
      strategies.push(createDocumentationStrategy(documentationFiles));
    }

    // 5. Handle configuration files
    if (configFiles.length > 0) {
      strategies.push(createConfigFileStrategy(configFiles));
    }

    // 6. Add a general strategy for remaining files
    const handledPaths = new Set(
      [
        ...packageJsonFiles,
        ...lockFiles,
        ...formattingOnlyConflicts,
        ...documentationFiles,
        ...configFiles,
      ].map((file) => file.path)
    );

    const remainingFiles = conflictFiles.filter((file) => !handledPaths.has(file.path));

    if (remainingFiles.length > 0) {
      strategies.push(createGeneralStrategy(remainingFiles));
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
