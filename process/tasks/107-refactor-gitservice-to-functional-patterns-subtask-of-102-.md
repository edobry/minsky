# Refactor GitService to Functional Patterns (Subtask of #102)

## Context

This task is a subtask of #102 (Refactor Domain Objects to Follow Functional Patterns). It focuses on refactoring the `GitService` module to align with functional programming principles. The goal is to make Git operations more predictable, testable, and easier to reason about by separating pure logic from side effects (like executing actual git commands).

## Requirements

1.  **Pure Functions for `GitService` Operations**:

    - Convert all core methods in `GitService` (e.g., `clone`, `branch`, `commit`, `push`, `pullLatest`, `mergeBranch`, `stashChanges`, `popStash`, `execInRepository`, `getRemoteUrl`, `getCurrentBranch`, etc.) into pure functions where feasible.
    - These functions should not directly execute git commands or interact with the file system where avoidable.
    - State (like repository path, current branch, remote URLs if not discoverable through pure means) and necessary configurations should be passed explicitly.
    - Functions that would conceptually modify repository state should describe the intended operation or return parameters for an effect-handling function.

2.  **Explicit Command Generation/Description**:

    - Instead of directly executing git commands, pure functions should primarily generate the git command strings or a descriptive structure of the git operation to be performed.
    - For example, a `commitFn` might take commit details and return an object like `{ command: "git", args: ["commit", "-m", "message"] }`.

3.  **Isolation of Side Effects (Git Command Execution)**:

    - The actual execution of git commands must be isolated from the pure functions.
    - This will likely involve a dedicated executor module/service that takes the command descriptions generated by the pure functions and executes them, handling any output or errors.

4.  **Functional Composition**:

    - Utilize functional composition for complex git workflows, building them from simpler, pure command-generating functions.

5.  **Update Tests**:

    - Rewrite unit tests to focus on the pure functions, verifying correct command generation or operation description based on inputs.
    - Integration tests will need to mock the git command executor to verify that the correct commands are sent for execution and to simulate different outcomes (success, failure, specific outputs).

6.  **Maintain Interface Contracts**:
    - The public interface of `GitService` (or its replacement) should aim to fulfill existing contracts used by other parts of the application, though the underlying implementation will change significantly. Document any unavoidable breaking changes.

## Implementation Steps

1. **Analyze Current GitService Implementation**

   - [ ] Document all core methods in `GitService` and their primary responsibilities
   - [ ] Identify methods with side effects (file system interactions, git command execution)
   - [ ] Create an inventory of input parameters and return values for each method
   - [ ] Analyze dependencies between methods to identify compositional opportunities

2. **Design Data Structures and Types**

   - [ ] Define a `GitCommand` type to represent git commands (e.g., `{ command: string, args: string[], cwd: string }`)
   - [ ] Create type definitions for all command parameters and results
   - [ ] Design error types for various git operation failures

3. **Create Pure Command Generator Functions**

   - [ ] Implement `generateCloneCommand`: Creates command for cloning a repository
   - [ ] Implement `generateBranchCommand`: Creates command for creating/checking out a branch
   - [ ] Implement `generateCommitCommand`: Creates command for committing changes
   - [ ] Implement `generatePushCommand`: Creates command for pushing changes
   - [ ] Implement `generatePullCommand`: Creates command for pulling latest changes
   - [ ] Implement `generateMergeCommand`: Creates command for merging branches
   - [ ] Implement `generateStashCommand`: Creates command for stashing changes
   - [ ] Implement `generatePopStashCommand`: Creates command for applying stashed changes
   - [ ] Implement `generateStatusCommand`: Creates command for checking git status
   - [ ] Implement `generateFetchCommand`: Creates command for fetching from remote
   - [ ] Implement additional command generators for other GitService operations

4. **Create GitCommandExecutor Service**

   - [ ] Implement `executeGitCommand`: Executes a git command and processes results
   - [ ] Add error handling and standardized error responses
   - [ ] Implement parsing functions for processing git command output
   - [ ] Add logging and debugging capabilities

5. **Create Higher-Order Functions for Common Workflows**

   - [ ] Implement compositional functions for multi-step git operations
   - [ ] Create utility functions for common git tasks (e.g., ensuring a clean working directory)
   - [ ] Add helper functions for standard git workflows

6. **Refactor GitService Interface**

   - [ ] Create a new `GitServiceFunctional` module that implements the same interface using pure functions
   - [ ] Ensure backward compatibility with existing callers
   - [ ] Add inline documentation explaining the functional approach

7. **Update Tests**

   - [ ] Refactor unit tests for pure command generator functions
   - [ ] Create tests for the GitCommandExecutor
   - [ ] Add tests for compositional functions and workflows
   - [ ] Create integration tests that verify the full stack

8. **Migrate Existing Code**

   - [ ] Update code that depends on GitService to use the new implementation
   - [ ] Fix any issues with integration points
   - [ ] Verify all functionality remains intact

9. **Finalize and Document**
   - [ ] Complete API documentation
   - [ ] Add usage examples
   - [ ] Document design decisions and patterns
   - [ ] Create architecture diagrams showing the new functional approach

## Verification

- [ ] All pure functions have no side effects and are deterministic
- [ ] Command execution is fully isolated in the GitCommandExecutor
- [ ] All tests pass with the new implementation
- [ ] The refactored code maintains backward compatibility with existing callers
- [ ] The code follows functional programming principles (immutability, pure functions, composition)
- [ ] Documentation is complete and accurate
- [ ] Performance is equivalent or better than the previous implementation

## Implementation Sketch

Below is a sketch of how the refactored code might look:

### Types and Interfaces

```typescript
// Types for git commands
export interface GitCommand {
  command: string;
  args: string[];
  cwd: string;
}

// Types for command results
export interface GitCommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
  exitCode: number;
}

// Error types
export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly command: GitCommand,
    public readonly result: GitCommandResult
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}
```

### Pure Command Generator Functions

```typescript
// Pure function to generate a clone command
export function generateCloneCommand(
  repoUrl: string,
  destination: string,
  options?: { branch?: string; depth?: number }
): GitCommand {
  const args = ["clone", repoUrl, destination];

  if (options?.branch) {
    args.push("--branch", options.branch);
  }

  if (options?.depth) {
    args.push("--depth", options.depth.toString());
  }

  return {
    command: "git",
    args,
    cwd: process.cwd(), // This is the only non-pure aspect but is required for the initial clone
  };
}

// Pure function to generate a commit command
export function generateCommitCommand(message: string, options?: { amend?: boolean }): GitCommand {
  const args = ["commit", "-m", message];

  if (options?.amend) {
    args.push("--amend");
  }

  return {
    command: "git",
    args,
    cwd: "", // Will be filled in by the executor
  };
}
```

### Command Executor

```typescript
// Isolated side-effect handler
export async function executeGitCommand(command: GitCommand): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(`${command.command} ${command.args.join(" ")}`, {
      cwd: command.cwd,
    });

    return {
      stdout,
      stderr,
      success: true,
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return {
        stdout: "",
        stderr: error.message,
        success: false,
        exitCode: (error as any).code || 1,
      };
    }

    throw error;
  }
}

// Parse git status output into structured data
export function parseGitStatus(statusOutput: string): GitStatus {
  const modified: string[] = [];
  const untracked: string[] = [];
  const deleted: string[] = [];

  // Parsing logic here

  return { modified, untracked, deleted };
}
```

### Functional GitService Implementation

```typescript
export class GitServiceFunctional implements GitServiceInterface {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ||
      join(
        process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
        "minsky",
        "git"
      );
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    const { repoUrl, session = this.generateSessionId(), branch } = options;

    const repoName = normalizeRepoName(repoUrl);
    const workdir = this.getSessionWorkdir(repoName, session);

    // Generate session directory
    await mkdir(join(this.baseDir, repoName, "sessions"), { recursive: true });

    // Generate command
    const cloneCommand = generateCloneCommand(repoUrl, workdir, { branch });

    // Execute command
    const result = await executeGitCommand(cloneCommand);

    if (!result.success) {
      throw new GitCommandError(`Failed to clone repository: ${repoUrl}`, cloneCommand, result);
    }

    return { workdir, session };
  }

  // Other methods would follow the same pattern:
  // 1. Process inputs and validate
  // 2. Generate command(s) using pure functions
  // 3. Execute command(s)
  // 4. Process results
  // 5. Return typed response
}
```

### Example Test for a Pure Function

```typescript
describe("generateCommitCommand", () => {
  test("should generate correct commit command", () => {
    const command = generateCommitCommand("feat: add new feature");

    expect(command).toEqual({
      command: "git",
      args: ["commit", "-m", "feat: add new feature"],
      cwd: "",
    });
  });

  test("should include amend flag when option is provided", () => {
    const command = generateCommitCommand("fix: update bug", { amend: true });

    expect(command).toEqual({
      command: "git",
      args: ["commit", "-m", "fix: update bug", "--amend"],
      cwd: "",
    });
  });
});
```

Parent Task: #102
