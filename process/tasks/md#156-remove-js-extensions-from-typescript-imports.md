# Remove .js Extensions from TypeScript Imports

## Context

The codebase currently uses `.js` extensions in TypeScript import statements throughout the project. While this is technically correct for ES modules and works with Bun's module resolution, it's unnecessary and unconventional for a TypeScript-only, Bun-only, non-library project.

Examples of current imports:

```typescript
import { resolveRepoPath } from "../repo-utils.js";
import { resolveWorkspacePath } from "../workspace.js";
import { createTaskService } from "./taskService.js";
```

These should be:

```typescript
import { resolveRepoPath } from "../repo-utils";
import { resolveWorkspacePath } from "../workspace";
import { createTaskService } from "./taskService";
```

## Requirements

1. **Investigation Phase**:

   - Research Bun's module resolution with extensionless imports
   - Test current TypeScript configuration compatibility
   - Verify that removing extensions won't break functionality
   - Check if any tsconfig.json changes are needed

2. **Implementation Phase**:

   - Remove `.js` extensions from all TypeScript imports across the codebase
   - Update TypeScript configuration if necessary
   - Ensure all tests continue to pass
   - Verify CLI functionality remains intact

3. **Verification**:
   - All imports work correctly without extensions
   - No runtime errors or module resolution issues
   - Tests pass completely
   - CLI commands function properly
   - Linting passes without issues

## Implementation Steps

1. [ ] Research Bun extensionless import configuration
2. [ ] Create a test branch for the changes
3. [ ] Update tsconfig.json if needed (likely `moduleResolution` setting)
4. [ ] Run a systematic find/replace to remove `.js` extensions
5. [ ] Test that everything still works (runtime + tests)
6. [ ] Fix any issues that arise
7. [ ] Update any related documentation
8. [ ] Commit and verify the changes

## Verification

- [ ] All TypeScript files compile without errors
- [ ] All tests pass: `bun test`
- [ ] CLI works: `minsky tasks list`
- [ ] No module resolution errors in any functionality
- [ ] Linting passes: `bun run lint`
- [ ] Code looks cleaner and more conventional

## Notes

- This is a cosmetic/developer experience improvement
- Should have no impact on runtime functionality
- Makes the codebase more conventional for TypeScript projects
- Reduces visual noise in import statements
- Aligns with typical TypeScript project patterns
