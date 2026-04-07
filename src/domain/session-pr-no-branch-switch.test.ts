import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { preparePrFromParams } from "./git/git-commands-modular";
import { preparePrImpl } from "./git/prepare-pr-operations";
import { FakeGitService } from "./git/fake-git-service";
import { FakeSessionProvider } from "./session/fake-session-provider";
import {
  setSharedSessionProvider,
  resetSharedSessionProvider,
} from "./session/session-provider-cache-seams";
import type { GitServiceInterface } from "./git/types";
import { initializeConfiguration, CustomConfigFactory } from "./configuration";

const SESSION_BRANCH = "task#228";
const PR_BRANCH = "pr/task#228";
const WORKDIR = "/mock/repo/path";

/**
 * Build a FakeGitService wired up so that `gitService.preparePr(...)` runs
 * the real `preparePrImpl` pipeline but routes every command through
 * `fakeGitService.execInRepository`, which records them in
 * `recordedCommands`. This is the seam the assertions read from.
 */
function buildFakeGitService(
  fakeSessionProvider: FakeSessionProvider
): FakeGitService & GitServiceInterface {
  const fakeGitService = new FakeGitService();

  // Default responses so preparePrImpl can complete the happy path:
  //   - current branch lookup returns the session branch
  //   - rev-parse --verify succeeds for the base branch (returns a commit hash)
  //   - rev-parse --verify for the PR branch falls through to the default
  //     "mock git output" response, causing preparePrImpl to treat the PR
  //     branch as existing and take the recovery path. Tests that want the
  //     clean-create path use setCommandError to make the PR-branch check fail.
  fakeGitService.setCommandResponse(/rev-parse --abbrev-ref HEAD/, SESSION_BRANCH);
  fakeGitService.setCommandResponse(/rev-parse --verify main$/, "abcdef123");

  const wired = fakeGitService as FakeGitService & GitServiceInterface;
  wired.preparePr = async (options) =>
    preparePrImpl(options, {
      sessionDb: fakeSessionProvider,
      getSessionWorkdir: () => WORKDIR,
      execInRepository: (workdir, cmd) => fakeGitService.execInRepository(workdir, cmd),
      gitFetch: async () => {},
      gitPush: async () => {},
    });

  return wired;
}

describe("Session PR Command Branch Behavior", () => {
  let fakeSessionProvider: FakeSessionProvider;
  let fakeGitService: FakeGitService & GitServiceInterface;

  beforeEach(async () => {
    // Configuration is still required for various downstream code paths.
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory);

    fakeSessionProvider = new FakeSessionProvider({
      initialSessions: [
        {
          session: SESSION_BRANCH,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          taskId: "228",
          createdAt: "2026-01-01T00:00:00Z",
          branch: SESSION_BRANCH,
        },
      ],
      repoPath: WORKDIR,
      sessionWorkdir: WORKDIR,
    });
    setSharedSessionProvider(fakeSessionProvider);

    fakeGitService = buildFakeGitService(fakeSessionProvider);
  });

  afterEach(() => {
    resetSharedSessionProvider();
  });

  test("should never switch user to PR branch (recovery path: PR branch already exists)", async () => {
    await preparePrFromParams(
      {
        session: SESSION_BRANCH,
        title: "Test PR",
        body: "Test body",
        baseBranch: "main",
      },
      { createGitService: () => fakeGitService }
    );

    const gitCommands = fakeGitService.recordedCommands.map((entry) => entry.command);

    // 1. PR branch should be created (via `git branch ...`, not `git switch -C`)
    const createPrBranchCommand = gitCommands.find(
      (cmd) => cmd.includes(`branch ${PR_BRANCH}`) && !cmd.includes("switch")
    );
    expect(createPrBranchCommand).toBeTruthy();
    expect(createPrBranchCommand).toContain(`branch ${PR_BRANCH}`);

    // 2. Should temporarily switch to PR branch (for the merge)
    const switchToPrCommand = gitCommands.find((cmd) => cmd.includes(`switch ${PR_BRANCH}`));
    expect(switchToPrCommand).toBeTruthy();

    // 3. Should switch back to session branch after merge
    const switchBackCommand = gitCommands.find((cmd) => cmd.includes(`switch ${SESSION_BRANCH}`));
    expect(switchBackCommand).toBeTruthy();

    // 4. CRITICAL: Verify order — switch to PR, then merge, then switch back
    const switchToPrIndex = gitCommands.indexOf(switchToPrCommand!);
    const mergeCommandIndex = gitCommands.findIndex((cmd) => cmd.includes("merge --no-ff"));
    // switch-back after the merge, not the preparatory switch before it
    const switchBackIndex = gitCommands.findIndex(
      (cmd, i) => i > mergeCommandIndex && cmd.includes(`switch ${SESSION_BRANCH}`)
    );

    expect(mergeCommandIndex).toBeGreaterThan(-1);
    expect(switchToPrIndex).toBeLessThan(mergeCommandIndex);
    expect(switchBackIndex).toBeGreaterThan(mergeCommandIndex);

    // 5. Should NOT use `git switch -C` or `git checkout -b` (create + checkout in one)
    const badCreateAndSwitchCommand = gitCommands.find(
      (cmd) => cmd.includes("switch -C") || cmd.includes("checkout -b")
    );
    expect(badCreateAndSwitchCommand).toBeFalsy();
  });

  test("should cleanly create PR branch when none exists (first-time case)", async () => {
    // Configure the fake so rev-parse --verify of the PR branch throws
    // (simulating "branch does not exist"). This forces preparePrImpl to
    // take the clean-create path, not the recovery-cleanup path.
    fakeGitService.setCommandError(
      /rev-parse --verify pr\//,
      new Error("fatal: Needed a single revision")
    );

    await preparePrFromParams(
      {
        session: SESSION_BRANCH,
        title: "Test PR",
        body: "Test body",
        baseBranch: "main",
      },
      { createGitService: () => fakeGitService }
    );

    const gitCommands = fakeGitService.recordedCommands.map((entry) => entry.command);

    // 1. PR branch created via `git branch ...`, not `git switch -C`
    const createPrBranchCommand = gitCommands.find(
      (cmd) => cmd.includes(`branch ${PR_BRANCH}`) && !cmd.includes("switch")
    );
    expect(createPrBranchCommand).toBeTruthy();

    // 2. No `branch -D` cleanup commands — the recovery path was NOT taken
    const cleanupCommand = gitCommands.find((cmd) => cmd.includes(`branch -D ${PR_BRANCH}`));
    expect(cleanupCommand).toBeFalsy();

    // 3. Should NOT use `git switch -C` or `git checkout -b`
    const badCreateAndSwitchCommand = gitCommands.find(
      (cmd) => cmd.includes("switch -C") || cmd.includes("checkout -b")
    );
    expect(badCreateAndSwitchCommand).toBeFalsy();
  });

  test("should handle branch switch-back failure without corrupting the workflow", async () => {
    // NOTE: setCommandError doesn't yet support "fire only after merge" semantics
    // (it would require stateful/nth-occurrence configuration). Using method
    // reassignment here to distinguish the pre-merge switch (preparatory) from
    // the post-merge switch-back (the one we want to fail).
    //
    // If FakeGitService gains stateful error configuration in the future, this
    // test can be migrated to use setCommandError.
    let mergeSeen = false;
    const originalExec = fakeGitService.execInRepository.bind(fakeGitService);
    fakeGitService.execInRepository = async (workdir: string, command: string) => {
      if (command.includes("merge --no-ff")) {
        mergeSeen = true;
      }
      if (mergeSeen && command.includes(`switch ${SESSION_BRANCH}`)) {
        // recordedCommands still captures the command (invariant: record before throwing)
        fakeGitService.recordedCommands.push({ workdir, command });
        throw new Error("Failed to switch back to session branch");
      }
      return originalExec(workdir, command);
    };

    await expect(
      preparePrFromParams(
        {
          session: SESSION_BRANCH,
          title: "Test PR",
          body: "Test body",
          baseBranch: "main",
        },
        { createGitService: () => fakeGitService }
      )
    ).rejects.toThrow(/switch back to session branch|Failed to create prepared merge commit/i);

    const gitCommands = fakeGitService.recordedCommands.map((entry) => entry.command);
    const mergeIdx = gitCommands.findIndex((cmd) => cmd.includes("merge --no-ff"));
    expect(mergeIdx).toBeGreaterThan(-1);

    // The workflow must attempt the switch-back after merging (which is the
    // failing operation we configured above).
    const postMergeSwitchBack = gitCommands.findIndex(
      (cmd, i) => i > mergeIdx && cmd.includes(`switch ${SESSION_BRANCH}`)
    );
    expect(postMergeSwitchBack).toBeGreaterThan(mergeIdx);
  });

  test("should document the behavioral change from switch -C to branch + switch pattern", () => {
    // This test documents the key behavioral change implemented

    const originalBehavior = {
      description: "Used git switch -C to create and checkout PR branch simultaneously",
      command: "git switch -C pr/session-id origin/main",
      problem: "Left user on PR branch, requiring explicit switch-back that could fail silently",
    };

    const newBehavior = {
      description: "Create PR branch without checking out, only switch temporarily for merge",
      commands: [
        "git branch pr/session-id origin/main", // Create without checkout
        "git switch pr/session-id", // Temporary switch for merge
        "git merge --no-ff session-id", // Perform merge
        "git switch session-id", // CRITICAL: Switch back
      ],
      benefit: "User always stays on session branch, PR branch only used programmatically",
    };

    // Document the fix
    expect(originalBehavior.problem).toContain("Left user on PR branch");
    expect(newBehavior.benefit).toContain("User always stays on session branch");
    expect(newBehavior.commands).toHaveLength(4);
    expect(newBehavior.commands[0]).toContain("branch pr/");
    expect(newBehavior.commands[3]).toContain("switch session-id");
  });
});
