/**
 * FakeGitService — in-memory test double for GitServiceInterface.
 *
 * Follows the canonical FakeX pattern established in
 * `src/domain/persistence/fake-persistence-provider.ts` and continued
 * in `fake-task-service.ts` and `fake-session-provider.ts`.
 *
 * This fake is more elaborate than the others because:
 * - Git operations are stateful (current branch, branch list per workdir)
 * - Tests routinely assert on the SEQUENCE of executed commands
 *
 * The fake records every command via `recordedCommands`, exposes a
 * `callCount` getter, and supports `setCommandResponse(pattern, response)`
 * for tests that need specific command-pattern matching (the old factory's
 * `branchExists` flag is implemented via this), and `setCommandError(pattern,
 * error)` for tests that need specific commands to throw.
 *
 * Hermetic by construction: no shell, no git binary, no filesystem.
 *
 * Default behavior mirrors the former `createMockGitService` factory
 * from `src/utils/test-utils/dependencies.ts` (now deleted):
 *   - execInRepository → pattern-matched responses (rev-list, show-ref, ls-remote, status)
 *   - clone → { workdir: "/mock/workdir", session: "test-session" }
 *   - branch → { workdir: "/mock/workdir", branch: "test-branch" }
 *   - getSessionWorkdir → "/mock/session/workdir" (sync)
 *   - stashChanges → { workdir: "/mock/workdir", stashed: true }
 *   - pullLatest → { workdir: "/mock/workdir", updated: true }
 *   - fetchLatest → { workdir: "/mock/workdir", updated: true }
 *   - mergeBranch → { workdir: "/mock/workdir", merged: true, conflicts: false }
 *   - push → { workdir: "/mock/workdir", pushed: true }
 *   - popStash → { workdir: "/mock/workdir", stashed: false }
 *   - getStatus → { modified: [], untracked: [], deleted: [] }
 *   - getCurrentBranch → "main"
 *   - hasUncommittedChanges → false
 *   - fetchDefaultBranch → "main"
 *
 * @see src/domain/persistence/fake-persistence-provider.ts
 * @see src/domain/tasks/fake-task-service.ts
 * @see src/domain/session/fake-session-provider.ts
 */

import type {
  GitServiceInterface,
  CloneOptions,
  CloneResult,
  BranchOptions,
  BranchResult,
  StashResult,
  PullResult,
  MergeResult,
  PushOptions,
  PushResult,
  GitStatus,
} from "./types";
import type {
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
} from "./conflict-detection-types";
import { ConflictType, ConflictSeverity } from "./conflict-detection-types";

export class FakeGitService implements GitServiceInterface {
  /** All commands passed to execInRepository, in order. */
  readonly recordedCommands: Array<{ workdir: string; command: string }> = [];
  /** All calls to push(), in order. */
  readonly pushedCalls: Array<PushOptions> = [];
  /** Configurable command-pattern responses (first match wins). */
  private readonly responses: Array<{ pattern: RegExp | string; response: string }> = [];
  /** Configurable command-pattern errors (first match wins; checked before responses). */
  private readonly errors: Array<{ pattern: RegExp | string; error: Error }> = [];

  private readonly defaultBranch: string;
  private readonly sessionWorkdir: string;
  private readonly mockWorkdir: string;
  private branchExists: boolean;

  /**
   * When set, smartSessionUpdate() returns this result instead of the default
   * happy-path response. Use this in tests to simulate conflict scenarios.
   */
  private smartSessionUpdateOverride: SmartUpdateResult | undefined;

  constructor(
    options: {
      defaultBranch?: string;
      sessionWorkdir?: string;
      mockWorkdir?: string;
      branchExists?: boolean;
    } = {}
  ) {
    this.defaultBranch = options.defaultBranch ?? "main";
    this.sessionWorkdir = options.sessionWorkdir ?? "/mock/session/workdir";
    this.mockWorkdir = options.mockWorkdir ?? "/mock/workdir";
    this.branchExists = options.branchExists ?? true;
  }

  /** Number of times execInRepository has been called. */
  get callCount(): number {
    return this.recordedCommands.length;
  }

  resetCallCount(): void {
    this.recordedCommands.length = 0;
    this.pushedCalls.length = 0;
  }

  /** Configure a response for a specific command pattern. First match wins. */
  setCommandResponse(pattern: RegExp | string, response: string): void {
    this.responses.push({ pattern, response });
  }

  /** Configure an error to be thrown for a specific command pattern. First match wins. Errors take priority over responses. */
  setCommandError(pattern: RegExp | string, error: Error | string): void {
    this.errors.push({
      pattern,
      error: typeof error === "string" ? new Error(error) : error,
    });
  }

  setBranchExists(value: boolean): void {
    this.branchExists = value;
  }

  /**
   * Override the result returned by smartSessionUpdate().
   * Useful for simulating merge-conflict scenarios in tests.
   */
  setSmartSessionUpdateResult(result: SmartUpdateResult): void {
    this.smartSessionUpdateOverride = result;
  }

  async execInRepository(workdir: string, command: string): Promise<string> {
    this.recordedCommands.push({ workdir, command });

    // Check user-configured errors first — they take priority over responses
    for (const { pattern, error } of this.errors) {
      if (typeof pattern === "string" ? command.includes(pattern) : pattern.test(command)) {
        throw error;
      }
    }

    // Check user-configured responses next
    for (const { pattern, response } of this.responses) {
      if (typeof pattern === "string" ? command.includes(pattern) : pattern.test(command)) {
        return response;
      }
    }

    // Default command-pattern responses (preserved from createMockGitService)
    if (command.includes("rev-list --left-right --count")) return "0\t0";
    // Upstream resolution: @{u} throws by default (no upstream configured), causing
    // the caller to fall back to the conventional origin/<branch> ref name.
    if (command.includes("@{u}")) {
      throw new Error("fatal: no upstream configured for branch");
    }
    // show-ref for remote tracking refs: default to success (ref exists) unless the
    // command targets a pr/ branch (handled separately by branchExists flag).
    if (command.includes("show-ref") && command.includes("refs/remotes/")) {
      if (command.includes("pr/")) {
        return this.branchExists ? "ref-exists" : "not-exists";
      }
      // For non-pr remote refs, return success (ref exists) so the rev-list check runs.
      return "ref-exists";
    }
    if (command.includes("show-ref") && command.includes("pr/")) {
      return this.branchExists ? "ref-exists" : "not-exists";
    }
    if (command.includes("ls-remote") && command.includes("pr/")) {
      return this.branchExists ? "remote-ref-exists" : "";
    }
    if (command.includes("status --porcelain")) return "";
    return "mock git output";
  }

  async clone(_options: CloneOptions): Promise<CloneResult> {
    return { workdir: this.mockWorkdir, session: "test-session" };
  }

  async branch(_options: BranchOptions): Promise<BranchResult> {
    return { workdir: this.mockWorkdir, branch: "test-branch" };
  }

  async branchWithoutSession(_options: {
    repoName: string;
    session: string;
    branch: string;
  }): Promise<BranchResult> {
    return { workdir: this.mockWorkdir, branch: _options.branch };
  }

  getSessionWorkdir(_session: string): string {
    return this.sessionWorkdir;
  }

  async stashChanges(_repoPath: string): Promise<StashResult> {
    return { workdir: this.mockWorkdir, stashed: true };
  }

  async fetchLatest(_repoPath: string, _remote?: string): Promise<PullResult> {
    return { workdir: this.mockWorkdir, updated: true };
  }

  async pullLatest(_repoPath: string, _remote?: string): Promise<PullResult> {
    return { workdir: this.mockWorkdir, updated: true };
  }

  async mergeBranch(_repoPath: string, _branch: string): Promise<MergeResult> {
    return { workdir: this.mockWorkdir, merged: true, conflicts: false };
  }

  async push(options: PushOptions): Promise<PushResult> {
    this.pushedCalls.push(options);
    return { workdir: this.mockWorkdir, pushed: true };
  }

  async popStash(_repoPath: string): Promise<StashResult> {
    return { workdir: this.mockWorkdir, stashed: false };
  }

  async getStatus(_repoPath?: string): Promise<GitStatus> {
    return { modified: [], untracked: [], deleted: [] };
  }

  async getCurrentBranch(_repoPath: string): Promise<string> {
    return this.defaultBranch;
  }

  async hasUncommittedChanges(_repoPath: string): Promise<boolean> {
    return false;
  }

  async fetchDefaultBranch(_repoPath: string): Promise<string> {
    return this.defaultBranch;
  }

  async predictMergeConflicts(
    _repoPath: string,
    _sourceBranch: string,
    _targetBranch: string
  ): Promise<ConflictPrediction> {
    return {
      hasConflicts: false,
      conflictType: ConflictType.NONE,
      severity: ConflictSeverity.NONE,
      affectedFiles: [],
      resolutionStrategies: [],
      userGuidance: "No conflicts predicted",
      recoveryCommands: [],
    };
  }

  async analyzeBranchDivergence(
    _repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    return {
      sessionBranch,
      baseBranch,
      aheadCommits: 0,
      behindCommits: 0,
      lastCommonCommit: "abc123",
      sessionChangesInBase: false,
      divergenceType: "none" as const,
      recommendedAction: "none" as const,
    };
  }

  async mergeWithConflictPrevention(
    _repoPath: string,
    _sourceBranch: string,
    _targetBranch: string,
    _options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult> {
    return { merged: true, conflicts: false, workdir: this.mockWorkdir };
  }

  async smartSessionUpdate(
    _repoPath: string,
    _sessionBranch: string,
    _baseBranch: string,
    _options?: { skipIfAlreadyMerged?: boolean; autoResolveConflicts?: boolean }
  ): Promise<SmartUpdateResult> {
    if (this.smartSessionUpdateOverride !== undefined) {
      return this.smartSessionUpdateOverride;
    }
    return { workdir: this.mockWorkdir, updated: true, skipped: false };
  }
}
