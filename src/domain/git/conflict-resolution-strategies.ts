/**
 * Conflict Resolution Strategies
 *
 * Operations for generating resolution strategies and user guidance for different
 * types of conflicts. Extracted from ConflictDetectionService for better modularity.
 */
import {
  ConflictFile,
  ConflictType,
  ConflictSeverity,
  ResolutionStrategy,
} from "./conflict-detection-types";

/**
 * Generates resolution strategies based on conflict type and files
 */
export function generateResolutionStrategies(
  conflictFiles: ConflictFile[],
  conflictType: ConflictType
): ResolutionStrategy[] {
  const strategies: ResolutionStrategy[] = [];

  if (conflictType === ConflictType.DELETE_MODIFY) {
    const allAutoResolvable = conflictFiles
      .filter((f) => f.deletionInfo)
      .every((f) => f.deletionInfo?.canAutoResolve);

    if (allAutoResolvable) {
      strategies.push({
        type: "automatic",
        description: "Accept deletions (recommended for removed files)",
        commands: [
          ...conflictFiles
            .filter((f) => f.deletionInfo)
            .map((f) => `git rm ${f.path}`),
          "git commit -m \"resolve conflicts: accept file deletions\"",
        ],
        riskLevel: "low",
      });
    }
  }

  // Always provide manual resolution option
  strategies.push({
    type: "manual",
    description: "Manually resolve conflicts by editing files",
    commands: [
      "git status",
      "# Edit conflicted files to resolve <<<<<<< ======= >>>>>>> markers",
      "git add .",
      "git commit -m \"resolve merge conflicts\"",
    ],
    riskLevel: "medium",
  });

  return strategies;
}

/**
 * Generates user guidance text based on conflict type, severity, and affected files
 */
export function generateUserGuidance(
  conflictType: ConflictType,
  severity: ConflictSeverity,
  conflictFiles: ConflictFile[]
): string {
  switch (conflictType) {
  case ConflictType.DELETE_MODIFY: {
    const deletedFiles = conflictFiles
      .filter((f) => f.deletionInfo)
      .map((f) => f.path);
    return `
🗑️  Deleted file conflicts detected

Files deleted in main branch but modified in your session:
${deletedFiles.map((f) => `  • ${f}`).join("\n")}

These conflicts are typically auto-resolvable by accepting the deletion.
The files were removed for a reason (likely part of refactoring or cleanup).

Recommended action: Accept the deletions and remove your changes to these files.
        `.trim();
  }
  case ConflictType.CONTENT_CONFLICT:
    return `
✏️  Content conflicts detected

${
  conflictFiles.length
} file(s) have conflicting changes between your session and main branch.
These require manual resolution by editing the files and choosing which changes to keep.

📋 Next Steps:
1. Run: git status                    (see which files are conflicted)
2. Edit the conflicted files          (look for <<<<<<< markers)
3. Run: git add <file>               (mark conflicts as resolved)
4. Run: git commit                    (complete the merge)
5. Run: minsky session pr [options]   (retry PR creation)

🔧 Quick Check:
• Run 'git status' now to see the conflicted files
• Edit files and remove conflict markers
• Choose which changes to keep between <<<<<<< and >>>>>>>

Look for conflict markers:
  <<<<<<< HEAD (your changes)
  =======
  >>>>>>> main (main branch changes)
        `.trim();

  case ConflictType.ALREADY_MERGED:
    return `
✅ Changes already merged

Your session changes appear to already be present in the main branch.
You can skip the update step and proceed directly to PR creation.
        `.trim();

  default:
    return `
⚠️  Conflicts detected

Manual resolution is required. Please review the conflicted files and resolve them manually.
        `.trim();
  }
} 
