# Task #074: Implement Auto-Dependency Installation for Session Workspaces

## Context

When creating a new Minsky session workspace with `minsky session start`, the CLI sets up a git repository clone and creates a branch but currently does not handle dependency installation steps. As discovered during bug fixing, developers often need to manually run `bun install` (or equivalent commands for other package managers) in the new session workspace before they can effectively work with the codebase, run tests, or use the tools in that workspace.

This creates friction in the developer workflow, especially for first-time session users, and can lead to confusing errors (like missing modules or TypeScript linter complaints) that distract from the actual task at hand.

## Approach

This task will follow a phased implementation approach:

1. **Phase 1 (Current Task)**: Implement basic detection and installation for Node.js/Bun projects

   - Focus on detecting common package managers through lock files
   - Provide simple command-line overrides
   - Keep the implementation lightweight and focused

2. **Phase 2 (Future Enhancement)**: Add support for devcontainer
   - Detect and utilize devcontainer configurations when available
   - Use the Phase 1 approach as a fallback for repositories without devcontainer
   - Implement proper integration with the devcontainer specification

## Requirements

1. **Auto-Detection of Project Type**

   - Automatically detect Node.js and Bun projects based on presence of files
   - Check for lock files in this priority order:
     1. `bun.lockb` (use Bun)
     2. `yarn.lock` (use Yarn)
     3. `pnpm-lock.yaml` (use pnpm)
     4. `package-lock.json` (use npm)
   - If only `package.json` exists with no lock files, default to npm

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

1. **Create Package Manager Detection Utility**

   - Implement utility functions to detect the project type and package manager
   - Support detection of Node.js/Bun projects using file presence checks
   - Provide a mapping from package manager to corresponding install command

2. **Update Command Interface**

   - Modify `src/commands/session/start.ts` to add the new command-line options
   - Update the help text and description

3. **Implement Installation Logic**

   - Add code to execute the appropriate installation command based on detected package manager
   - Use proper error handling (report errors but don't attempt to recover)
   - Respect the quiet flag for installation output

4. **Add Unit Tests**
   - Add tests for the detection logic
   - Add tests for the command-line interface
   - Update existing session command tests

## Out of Scope (For This Phase)

- No special handling for monorepo structures
- No performance optimizations or caching mechanisms
- No complex recovery mechanisms for failed installations
- No special handling of environment variables or registry configuration
- No automatic execution of custom scripts beyond the standard install command

## Implementation Details

```typescript
// Example implementation of detectPackageManager utility
export type PackageManager = "bun" | "npm" | "yarn" | "pnpm" | undefined;

export function detectPackageManager(repoPath: string): PackageManager {
  if (existsSync(join(repoPath, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  if (existsSync(join(repoPath, "package.json"))) {
    return "npm"; // Default to npm if only package.json exists
  }
  return undefined; // Not a Node.js/Bun project
}
```

## Acceptance Criteria

- The command correctly detects Node.js/Bun projects and their package managers
- Dependencies are installed automatically by default when creating a new session
- Users can control the installation behavior with the provided options
- The command provides appropriate feedback during the process
- All tests pass
- Documentation is updated to reflect the new functionality

## Future Considerations

- Support for devcontainer in Phase 2
- Expansion to other ecosystems (Rust/Cargo, Python/pip, etc.)
- Support for monorepo structures
- Repository-specific configuration
- Integration with custom project setup scripts

## Work Log

- **2025-05-23**: Initial investigation revealed auto-dependency installation was implemented but had bugs
- **2025-05-23**: **BUG FOUND**: Package manager detection was looking for `bun.lockb` instead of `bun.lock` 
- **2025-05-23**: **BUG FIXED**: Updated `detectPackageManager` function to check for correct `bun.lock` file
- **2025-05-23**: **ENHANCEMENT**: Added missing `--packageManager` CLI flag to override auto-detection
- **2025-05-23**: Updated test case to reflect correct Bun lock file name
- **2025-05-23**: **VERIFIED**: All package manager utility tests pass (17/17)
- **2025-05-23**: **COMPLETED**: Task functionality now works as originally specified

## Bug Fix Summary

The auto-dependency installation feature was **implemented but broken** due to incorrect file detection:

### Issues Found:
1. **Primary Bug**: Code checked for `bun.lockb` but Bun actually uses `bun.lock` 
2. **Missing CLI Flag**: `--packageManager` option was not exposed in the CLI interface

### Issues Fixed:
1. ✅ Changed `bun.lockb` → `bun.lock` in `detectPackageManager()` function
2. ✅ Added `--packageManager` parameter to CLI command interface  
3. ✅ Updated test case description for clarity
4. ✅ Verified all 17 tests pass

### Result:
- Session creation now correctly detects Bun and runs `bun install` instead of `npm install`
- Users can override package manager detection with `--packageManager` flag
- Feature works as originally specified in requirements
