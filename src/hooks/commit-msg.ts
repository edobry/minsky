/**
 * Unified Commit Message Hook
 *
 * Replaces the two separate scripts (validate-commit-message.ts and check-title-duplication.ts)
 * with a unified class-based approach following the PreCommitHook pattern.
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { log } from "../utils/logger";

// Import actual validation logic instead of duplicating it
import { isDuplicateContent } from "../domain/session/pr-validation";

export interface CommitMsgResult {
  success: boolean;
  message: string;
  errors: string[];
}

const FORBIDDEN_MESSAGES = [
  "minimal commit",
  "amended commit",
  "test commit",
  "placeholder commit",
  "temp commit",
  "temporary commit",
  "wip",
  "work in progress",
  "fix",
  "update",
  "change",
];

const CONVENTIONAL_COMMIT_PATTERN =
  /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert|merge)(\(.+\))?: .{1,50}/;

/**
 * Unified commit message validation hook
 */
export class CommitMsgHook {
  constructor(private commitMsgFile: string) {}

  /**
   * Run all commit message validations
   */
  async run(): Promise<CommitMsgResult> {
    const errors: string[] = [];

    try {
      // Load and parse commit message
      const commitMessage = readFileSync(this.commitMsgFile, "utf-8").trim();

      if (!commitMessage) {
        log.cli("✅ Empty commit message, validation skipped");
        return { success: true, message: "Empty commit message", errors: [] };
      }

      const { title, body } = this.parseCommitMessage(commitMessage);

      // Run all validations
      const formatValidation = this.validateCommitFormat(title, commitMessage);
      if (!formatValidation.valid) {
        errors.push(formatValidation.error || "Format validation failed");
      }

      const duplicationValidation = this.validateTitleDuplication(title, body);
      if (!duplicationValidation.valid) {
        errors.push(duplicationValidation.error || "Title duplication detected");
      }

      // Return result
      if (errors.length > 0) {
        log.error("❌ Commit message validation failed:");
        errors.forEach((error) => log.error(`   • ${error}`));
        return { success: false, message: "Validation failed", errors };
      }

      log.cli("✅ Commit message validation passed");
      return { success: true, message: "All validations passed", errors: [] };
    } catch (error) {
      const errorMsg = `Error processing commit message: ${error}`;
      log.error(errorMsg);
      return { success: false, message: errorMsg, errors: [errorMsg] };
    }
  }

  /**
   * Parse commit message into title and body
   */
  private parseCommitMessage(message: string): { title: string; body: string } {
    const lines = message.split("\n");
    const title = lines[0]?.trim() || "";

    // Body starts after the first blank line (standard git commit format)
    let bodyStartIndex = 1;
    while (bodyStartIndex < lines.length && lines[bodyStartIndex]?.trim() === "") {
      bodyStartIndex++;
    }

    const body = lines.slice(bodyStartIndex).join("\n").trim();

    return { title, body };
  }

  /**
   * Validate commit message format and content
   */
  private validateCommitFormat(
    title: string,
    fullMessage: string
  ): { valid: boolean; error?: string } {
    if (!title) {
      return { valid: false, error: "Commit message cannot be empty" };
    }

    // Check for forbidden placeholder messages
    const normalizedMessage = title.toLowerCase();
    if (FORBIDDEN_MESSAGES.includes(normalizedMessage)) {
      return {
        valid: false,
        error: `Forbidden placeholder message: "${title}". Please use a descriptive conventional commit message.`,
      };
    }

    // Handle merge commits with branch-specific rules
    if (this.isMergeCommit(fullMessage)) {
      const currentBranch = this.getCurrentBranch();

      if (currentBranch === "main" || currentBranch === "master") {
        return {
          valid: false,
          error: `Merge commits into ${currentBranch} must use conventional commit format. Use squash merge or reword the commit message.`,
        };
      }

      // Allow merge commits for other branches
      log.cli(`✅ Merge commit allowed on branch: ${currentBranch}`);
      return { valid: true };
    }

    // Check conventional commit format for regular commits
    if (!CONVENTIONAL_COMMIT_PATTERN.test(title)) {
      return {
        valid: false,
        error: `Invalid commit message format. Please use conventional commits format: "type(scope): description"
Examples:
  feat(auth): add user authentication
  fix(#123): resolve login validation issue
  merge(#276): integrate main branch changes
  docs: update README with new features`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate title duplication using shared logic
   */
  private validateTitleDuplication(
    title: string,
    body: string
  ): { valid: boolean; error?: string } {
    if (!title || !body) {
      return { valid: true }; // Skip if either is empty
    }

    // Parse body for first line duplication check
    const lines = body.split("\n");
    const firstLine = lines[0]?.trim();

    if (!firstLine) {
      return { valid: true };
    }

    // Use the same validation logic as PR validation (now with substring matching)
    if (isDuplicateContent(title, firstLine)) {
      return {
        valid: false,
        error: `Title "${title}" appears to be duplicated as the first line of the body: "${firstLine}"`,
      };
    }

    return { valid: true };
  }

  /**
   * Check if message is a merge commit
   */
  private isMergeCommit(message: string): boolean {
    return message.trim().startsWith("Merge ");
  }

  /**
   * Get current git branch
   */
  private getCurrentBranch(): string {
    try {
      const result = execSync("git branch --show-current", { encoding: "utf8" });
      return typeof result === "string" ? result.trim() : "unknown";
    } catch (error) {
      try {
        const result = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" });
        return typeof result === "string" ? result.trim() : "unknown";
      } catch {
        return "unknown";
      }
    }
  }
}

/**
 * CLI entry point - matches PreCommitHook pattern
 */
async function main() {
  const commitMsgFile = process.argv[2];

  if (!commitMsgFile) {
    log.error("Usage: bun src/hooks/commit-msg.ts <commit-msg-file>");
    process.exit(1);
  }

  const hook = new CommitMsgHook(commitMsgFile);
  const result = await hook.run();

  if (!result.success) {
    process.exit(1);
  }

  process.exit(0);
}

// Run if called directly
if (import.meta.main) {
  main();
}
