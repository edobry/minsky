/**
 * Simple unified diff generator for text content
 * Generates a basic unified diff format for displaying changes between two strings
 */

/**
 * Generate a unified diff between two strings
 * @param original - The original content
 * @param modified - The modified content
 * @param filename - Optional filename to include in diff header
 * @returns Unified diff string
 */
export function generateUnifiedDiff(original: string, modified: string, filename?: string): string {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // Simple line-by-line comparison
  const diffLines: string[] = [];

  // Add diff header
  const fileLabel = filename || "file";
  diffLines.push(`--- ${fileLabel}`);
  diffLines.push(`+++ ${fileLabel}`);

  // Find differences using a simple approach
  const maxLines = Math.max(originalLines.length, modifiedLines.length);
  let contextStart = -1;
  let contextLines: string[] = [];
  let hasChanges = false;

  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || "";
    const modifiedLine = modifiedLines[i] || "";

    if (originalLine !== modifiedLine) {
      // Start a new hunk if we haven't started one
      if (contextStart === -1) {
        contextStart = Math.max(0, i - 3); // 3 lines of context

        // Add context before the change
        const contextStartIndex = Math.max(0, i - 3);
        for (let j = contextStartIndex; j < i; j++) {
          if (originalLines[j] !== undefined) {
            contextLines.push(` ${originalLines[j]}`);
          }
        }
      }

      // Add removed line (from original)
      if (i < originalLines.length) {
        contextLines.push(`-${originalLine}`);
      }

      // Add added line (from modified)
      if (i < modifiedLines.length) {
        contextLines.push(`+${modifiedLine}`);
      }

      hasChanges = true;
    } else if (hasChanges && contextStart !== -1) {
      // Add context after changes (up to 3 lines)
      contextLines.push(` ${originalLine}`);

      // Check if we should close this hunk (no more changes in next few lines)
      let nextChanges = false;
      for (let j = i + 1; j < Math.min(i + 4, maxLines); j++) {
        const nextOriginal = originalLines[j] || "";
        const nextModified = modifiedLines[j] || "";
        if (nextOriginal !== nextModified) {
          nextChanges = true;
          break;
        }
      }

      if (!nextChanges) {
        // Close this hunk
        const contextEnd = Math.min(i + 1, maxLines);
        const hunkOriginalStart = contextStart + 1;
        const hunkOriginalLength = Math.min(
          contextEnd - contextStart,
          originalLines.length - contextStart
        );
        const hunkModifiedStart = contextStart + 1;
        const hunkModifiedLength = contextEnd - contextStart;

        diffLines.push(
          `@@ -${hunkOriginalStart},${hunkOriginalLength} +${hunkModifiedStart},${hunkModifiedLength} @@`
        );
        diffLines.push(...contextLines);

        // Reset for next hunk
        contextStart = -1;
        contextLines = [];
        hasChanges = false;
      }
    }
  }

  // Close any remaining hunk
  if (hasChanges && contextStart !== -1) {
    const hunkOriginalStart = contextStart + 1;
    const hunkOriginalLength = originalLines.length - contextStart;
    const hunkModifiedStart = contextStart + 1;
    const hunkModifiedLength = modifiedLines.length - contextStart;

    diffLines.push(
      `@@ -${hunkOriginalStart},${hunkOriginalLength} +${hunkModifiedStart},${hunkModifiedLength} @@`
    );
    diffLines.push(...contextLines);
  }

  return diffLines.join("\n");
}

/**
 * Generate a concise summary of changes between two strings
 * @param original - The original content
 * @param modified - The modified content
 * @returns Summary object with statistics
 */
export function generateDiffSummary(
  original: string,
  modified: string
): {
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
  totalLines: number;
} {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // Handle empty strings properly
  if (original === "") {
    return {
      linesAdded: modifiedLines.length,
      linesRemoved: 0,
      linesChanged: 0,
      totalLines: modifiedLines.length,
    };
  }

  if (modified === "") {
    return {
      linesAdded: 0,
      linesRemoved: originalLines.length,
      linesChanged: 0,
      totalLines: 0,
    };
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  let linesChanged = 0;

  const minLines = Math.min(originalLines.length, modifiedLines.length);
  const maxLines = Math.max(originalLines.length, modifiedLines.length);

  // Compare overlapping lines first
  for (let i = 0; i < minLines; i++) {
    const originalLine = originalLines[i];
    const modifiedLine = modifiedLines[i];

    if (originalLine !== modifiedLine) {
      // This counts as both a removal and an addition (substitution)
      linesRemoved++;
      linesAdded++;
    }
  }

  // Handle additional lines
  if (originalLines.length > modifiedLines.length) {
    // More original lines than modified = some lines were removed
    linesRemoved += originalLines.length - modifiedLines.length;
  } else if (modifiedLines.length > originalLines.length) {
    // More modified lines than original = some lines were added
    linesAdded += modifiedLines.length - originalLines.length;
  }

  return {
    linesAdded,
    linesRemoved,
    linesChanged,
    totalLines: modifiedLines.length,
  };
}
