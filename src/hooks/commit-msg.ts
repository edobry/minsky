/**
 * Unified Commit Message Hook
 *
 * Replaces the two separate scripts (validate-commit-message.ts and check-title-duplication.ts)
 * with a unified class-based approach following the PreCommitHook pattern.
 */

import { readFileSync as nodeReadFileSync } from "fs";
import { execSync as nodeExecSync } from "child_process";
import { log } from "@minsky/shared/logger";

// Import actual validation logic instead of duplicating it
import { isDuplicateContent } from "@minsky/domain/session/pr-validation";
// mt#2821: the format/placeholder check below is the SAME function
// `commitImpl` (packages/domain/src/git/git-core-operations.ts) now runs
// BEFORE shelling out to `git commit`, so a malformed message fails in
// milliseconds for any Minsky-issued commit without ever reaching this hook
// (and therefore without paying for the pre-commit suite that always runs
// first in git's fixed hook order). This hook remains the enforcement
// backstop for commits made outside Minsky's own commit path. See
// packages/domain/src/git/commit-message-format.ts for the full finding.
import { validateCommitMessageFormat } from "@minsky/domain/git/commit-message-format";

export interface CommitMsgResult {
  success: boolean;
  message: string;
  errors: string[];
}

export interface CommitMsgDeps {
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  execSync?: (command: string, options?: { encoding: string }) => string;
}

/**
 * Unified commit message validation hook
 */
export class CommitMsgHook {
  private readonly readFileSync: (path: string, encoding: BufferEncoding) => string;
  private readonly execSync: (command: string, options?: { encoding: string }) => string;

  constructor(
    private commitMsgFile: string,
    deps?: CommitMsgDeps
  ) {
    this.readFileSync =
      deps?.readFileSync ??
      ((p: string, e: BufferEncoding) => String(nodeReadFileSync(p, { encoding: e })));
    this.execSync =
      deps?.execSync ??
      ((cmd: string, opts?: { encoding: string }) =>
        nodeExecSync(cmd, { encoding: (opts?.encoding ?? "utf8") as BufferEncoding }).toString());
  }

  /**
   * Run all commit message validations
   */
  async run(): Promise<CommitMsgResult> {
    const errors: string[] = [];

    try {
      // Load and parse commit message
      const commitMessage = this.readFileSync(this.commitMsgFile, "utf-8" as BufferEncoding).trim();

      // mt#2821 PR #1976 R1: an empty (or whitespace-only) message is no
      // longer skipped as a pass-through success — it falls through to the
      // normal validation path below, where validateCommitFormat's
      // `!title` check (and the shared validateCommitMessageFormat's own
      // empty check, for parity with commitImpl's fast-fail path) rejects
      // it. `git commit --allow-empty-message` is a real escape hatch this
      // hook exists to catch; silently treating it as "validation skipped"
      // defeated that purpose.

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

    // Handle merge commits with branch-specific rules. This case stays
    // hook-local because it requires a git branch lookup
    // (validateCommitMessageFormat is a pure function and does not shell
    // out); merge commits also don't flow through commitImpl in practice
    // (PR merges use the GitHub API, not a local `git commit`).
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

    // Forbidden-placeholder + conventional-commit-format checks: delegate to
    // the SAME validator `commitImpl` runs before shelling out to
    // `git commit` (mt#2821), so the two enforcement points can never drift
    // apart. See packages/domain/src/git/commit-message-format.ts.
    return validateCommitMessageFormat(fullMessage);
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
      const result = this.execSync("git branch --show-current", { encoding: "utf8" });
      return result.toString().trim();
    } catch (error) {
      try {
        const result = this.execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" });
        return result.toString().trim();
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
