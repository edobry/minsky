# Task #074: Implement Auto-Dependency Installation for Session Workspaces

## Context

When creating a new Minsky session workspace with `minsky session start`, the CLI sets up a git repository clone and creates a branch but currently does not handle dependency installation steps. As discovered during bug fixing, developers often need to manually run `bun install` (or equivalent commands for other package managers) in the new session workspace before they can effectively work with the codebase, run tests, or use the tools in that workspace.

This creates friction in the developer workflow, especially for first-time session users, and can lead to confusing errors (like missing modules or TypeScript linter complaints) that distract from the actual task at hand.

## Requirements

1. **Auto-Detection of Project Type**
   - Automatically detect the type of project in the session workspace (e.g., Bun, Node.js, npm, pnpm, Yarn, etc.)
   - Support detection based on presence of files like `package.json`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, etc.

2. **Configurable Dependency Installation**
   - Add options to control dependency installation behavior:
     - `--install-dependencies`: Flag to trigger automatic dependency installation (default: true)
     - `--skip-install`: Flag to skip dependency installation
     - `--package-manager <pm>`: Override the detected package manager (e.g., `bun`, `npm`, `yarn`, `pnpm`)

3. **Feedback and Logging**
   - Display appropriate messages during the installation process
   - Provide clear error messages if installation fails
   - Support the `--quiet` flag by suppressing installation output when enabled

4. **Integration with Existing Command**
   - Integrate the feature into the existing `minsky session start` command
   - Ensure backward compatibility with existing scripts and workflows
   - Add related documentation to command help text

## Implementation Steps

1. **Update Command Interface**
   - Modify `src/commands/session/start.ts` to add the new command-line options
   - Update the help text and description

2. **Implement Detection Logic**
   - Create a utility function to detect the project type and package manager from repository files
   - Handle detection of common project types (Node.js, Bun, etc.)

3. **Implement Installation Logic**
   - Create a function to execute the appropriate installation command based on detected package manager
   - Handle execution of commands like `bun install`, `npm install`, `yarn`, etc.
   - Implement proper error handling and timeouts

4. **Update Session Start Flow**
   - Integrate the detection and installation steps into the session start workflow
   - Update the success messages to include dependency installation results

5. **Add Unit Tests**
   - Add tests for the detection logic
   - Add tests for the installation logic
   - Update existing session command tests

## Acceptance Criteria

- The command correctly detects the project type and package manager
- Dependencies are installed automatically by default when creating a new session
- Users can control the installation behavior with the provided options
- The command provides appropriate feedback during the process
- All tests pass
- Documentation is updated to reflect the new functionality

## Future Considerations

- Support for other dependency management systems (Cargo for Rust, pip for Python, etc.)
- Support for custom installation commands or hooks defined in project configuration
- Integration with workspace-specific configuration to customize dependency installation per project 
