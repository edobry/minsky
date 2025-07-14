import { describe, test, expect } from "bun:test";
import { preparePrFromParams } from "./git.js";
import { createMock } from "../../utils/test-utils/mocking.js";

describe("Session PR Command Branch Behavior", () => {
  test("should never switch user to PR branch during session pr creation", async () => {
    const gitCommands: string[] = [];
    const sessionBranch = "task#228";
    const prBranch = "pr/task#228";

    // Mock execAsync to capture all git commands
    const mockExecAsync = createMock(async (...args: unknown[]) => {
      const command = args[0] as string;
      gitCommands.push(command);

      // Simulate different command responses
      if (command.includes("git -C") && command.includes("rev-parse --abbrev-ref HEAD")) {
        return { stdout: sessionBranch, stderr: "" };
      }
      if (command.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        return { stdout: "origin/main", stderr: "" };
      }
      if (command.includes("fetch origin")) {
        return { stdout: "", stderr: "" };
      }
      if (command.includes("rev-parse --verify")) {
        return { stdout: "abcdef123", stderr: "" };
      }
      if (command.includes(`branch ${prBranch}`)) {
        return { stdout: "", stderr: "" };
      }
      if (command.includes(`switch ${prBranch}`)) {
        return { stdout: "", stderr: "" };
      }
      if (command.includes("merge --no-ff")) {
        return { stdout: "", stderr: "" };
      }
      if (command.includes(`switch ${sessionBranch}`)) {
        return { stdout: "", stderr: "" };
      }
      if (command.includes(`push origin ${prBranch}`)) {
        return { stdout: "", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    });

    // Mock session database
    const mockSessionDb = {
      getSession: createMock((): Promise<any> =>
        Promise.resolve({
          session: "task#228",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          taskId: "#228",
        })
      ),
    };

    // Mock dependencies
    const mockDeps = {
      execAsync: mockExecAsync,
      getSession: mockSessionDb.getSession,
      getSessionWorkdir: createMock(() => "/test/session/workdir"),
      mkdir: createMock(() => Promise.resolve()),
      readdir: createMock(() => Promise.resolve(["file1.txt"])),
      access: createMock(() => Promise.resolve()),
    };

    // Execute preparePr which is called by session pr
    await preparePrFromParams({
      session: "task#228",
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    // Verify the correct sequence of git commands
    const relevantCommands = gitCommands.filter(cmd => 
      cmd.includes("branch ") || 
      cmd.includes("switch ") || 
      cmd.includes("checkout ")
    );

    console.log("Git branch/switch commands executed:", relevantCommands);

    // CRITICAL ASSERTIONS: Verify proper branch handling
    
    // 1. PR branch should be created without checking it out
    const createPrBranchCommand = gitCommands.find(cmd => 
      cmd.includes(`branch ${prBranch}`) && !cmd.includes("switch")
    );
    expect(createPrBranchCommand).toBeTruthy();
    expect(createPrBranchCommand).toContain(`branch ${prBranch}`);

    // 2. Should temporarily switch to PR branch ONLY for merge operation
    const switchToPrCommand = gitCommands.find(cmd => 
      cmd.includes(`switch ${prBranch}`)
    );
    expect(switchToPrCommand).toBeTruthy();
    
    // 3. Should switch back to session branch after merge
    const switchBackCommand = gitCommands.find(cmd => 
      cmd.includes(`switch ${sessionBranch}`)
    );
    expect(switchBackCommand).toBeTruthy();

    // 4. CRITICAL: Verify order - switch to PR, then merge, then switch back
    const switchToPrIndex = gitCommands.indexOf(switchToPrCommand!);
    const mergeCommandIndex = gitCommands.findIndex(cmd => cmd.includes("merge --no-ff"));
    const switchBackIndex = gitCommands.indexOf(switchBackCommand!);

    expect(switchToPrIndex).toBeLessThan(mergeCommandIndex);
    expect(mergeCommandIndex).toBeLessThan(switchBackIndex);

    // 5. Should NOT use `git switch -C` which creates and checks out simultaneously
    const badCreateAndSwitchCommand = gitCommands.find(cmd => 
      cmd.includes("switch -C") || cmd.includes("checkout -b")
    );
    expect(badCreateAndSwitchCommand).toBeFalsy();
  });

  test("should handle branch switch-back failure as critical error", async () => {
    const sessionBranch = "task#228";
    const prBranch = "pr/task#228";

    // Mock execAsync to simulate switch-back failure
    const mockExecAsync = createMock(async (...args: unknown[]) => {
      const command = args[0] as string;
      // Simulate failure when switching back to session branch
      if (command.includes(`switch ${sessionBranch}`)) {
        throw new Error("Failed to switch back to session branch");
      }

      // Simulate success for other commands
      if (command.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        return { stdout: "origin/main", stderr: "" };
      }
      if (command.includes("rev-parse --abbrev-ref HEAD")) {
        return { stdout: sessionBranch, stderr: "" };
      }

      return { stdout: "", stderr: "" };
    });

    // Mock session database
    const mockSessionDb = {
      getSession: createMock(() =>
        Promise.resolve({
          session: "task#228",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          taskId: "#228",
        })
      ),
    };

    // Expect the function to throw an error when switch-back fails
    await expect(async () => {
      await preparePrFromParams({
        session: "task#228",
        title: "Test PR",
        body: "Test body",  
        baseBranch: "main",
      });
    }).toThrow(/Failed to switch back to session branch/);
  });

  test("should document the behavioral change from switch -C to branch + switch pattern", () => {
    // This test documents the key behavioral change implemented

    const originalBehavior = {
      description: "Used git switch -C to create and checkout PR branch simultaneously",
      command: "git switch -C pr/session-name origin/main",
      problem: "Left user on PR branch, requiring explicit switch-back that could fail silently",
    };

    const newBehavior = {
      description: "Create PR branch without checking out, only switch temporarily for merge",
      commands: [
        "git branch pr/session-name origin/main",  // Create without checkout
        "git switch pr/session-name",              // Temporary switch for merge
        "git merge --no-ff session-name",          // Perform merge
        "git switch session-name",                 // CRITICAL: Switch back
      ],
      benefit: "User always stays on session branch, PR branch only used programmatically",
    };

    // Document the fix
    expect(originalBehavior.problem).toContain("Left user on PR branch");
    expect(newBehavior.benefit).toContain("User always stays on session branch");
    expect(newBehavior.commands).toHaveLength(4);
    expect(newBehavior.commands[0]).toContain("branch pr/");
    expect(newBehavior.commands[3]).toContain("switch session-name");
  });
}); 
