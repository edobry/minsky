# Replace Direct process.exit() Calls with Custom exit() Utility

## Overview

Systematically replace all direct `process.exit()` calls throughout the codebase with our custom `exit()` utility from `src/utils/process.ts` to ensure consistent behavior and proper TypeScript compatibility in the Bun environment.

## Background

The codebase has a custom `exit()` function in `src/utils/process.ts` that properly handles process termination in the Bun environment. However, many files are still calling `process.exit()` directly, which causes TypeScript errors because Bun's type definitions don't include `process.exit`.

Current analysis shows direct `process.exit()` calls in these files:

- `src/cli.ts` (already partially fixed)
- `src/adapters/cli/cli-command-factory.ts`
- `src/adapters/shared/commands/config/config-commands.ts`
- `src/adapters/shared/commands/git/git-commands.ts`
- `src/adapters/shared/commands/init/init-commands.ts`
- `src/adapters/shared/commands/session/session-commands.ts`
- `src/adapters/shared/commands/tasks/task-commands.ts`
- `src/domain/configuration/config-service.ts`
- `src/domain/git.ts`
- `src/domain/session/session-service.ts`
- `src/domain/tasks/task-service.ts`
- `src/mcp/tools/session-tool.ts`
- `src/utils/exec.ts`

## Requirements

### Core Requirements

1. **Identify all direct process.exit() calls** across the codebase (excluding the process.ts utility itself)
2. **Replace each call systematically** with proper import and usage of our custom `exit()` function
3. **Maintain exact same exit codes** - no behavioral changes to exit logic
4. **Ensure proper imports** - add `import { exit } from "./utils/process.js"` (with correct relative paths)
5. **Verify functionality** - ensure all affected commands still work correctly

### Implementation Steps

1. **Audit Phase**

   - Run `grep -r "process\.exit" src/ --exclude="src/utils/process.ts"` to get complete list
   - Document each occurrence with file, line number, and context
   - Identify any complex cases that might need special handling

2. **Replacement Phase**

   - For each file:
     - Add import statement: `import { exit } from "path/to/utils/process.js"`
     - Replace `process.exit(code)` with `exit(code)`
     - Ensure correct relative path for import
   - Handle files that might already have the import

3. **Verification Phase**
   - Run TypeScript compilation to ensure no new errors
   - Test key CLI commands to ensure functionality is preserved
   - Run existing tests to ensure no regressions

### Success Criteria

- [ ] No direct `process.exit()` calls remain in the codebase (except in `src/utils/process.ts`)
- [ ] All affected files properly import and use the custom `exit()` function
- [ ] TypeScript compilation succeeds without process-related errors
- [ ] Core CLI functionality verified working (tasks list, session commands, etc.)
- [ ] No behavioral changes to exit codes or termination logic

### Testing Requirements

- Verify `minsky tasks list` still works
- Verify `minsky session start` works
- Verify error conditions that trigger exits still work correctly
- Run relevant test suites to ensure no regressions

## Technical Notes

- The custom `exit()` function in `src/utils/process.ts` handles Bun environment compatibility
- Import paths should use `.js` extension for proper ESM compatibility
- Some files may need relative path adjustments for the import
- The function signature is identical: `exit(code: number): never`

## Estimated Effort

Medium - affects ~13 files with straightforward find-and-replace operations, but requires careful testing to ensure no behavioral changes.
