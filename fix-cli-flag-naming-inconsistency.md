# Fix CLI Flag Naming Inconsistency for Task Identification

## Problem

There is an inconsistency in CLI flag naming for task identification across different Minsky commands:

- **Session commands** (session get, session start, etc.) use `--task`
- **Git PR command** uses `--task-id` (because the parameter name is `taskId` which gets converted to kebab-case)

This inconsistency confuses users who expect the same flag name across all commands when referring to tasks.

## Root Cause Analysis

The inconsistency stems from:

1. **Session commands** define their parameter as `task` in the shared command registry, resulting in the CLI flag `--task`
2. **Git PR command** defines its parameter as `taskId` in the shared command registry, which gets converted to `--task-id` by the automatic camelCase-to-kebab-case conversion in `paramNameToFlag()` function

## Evidence

From our testing session:

```bash
# This works (session commands):
❯ minsky session get --task 079

# This fails (git pr command):
❯ minsky git pr --task 132
Error: Unknown argument: task

# This works (git pr command):
❯ minsky git pr --task-id 132
```

## Expected Behavior

All commands that accept task identification should use the same CLI flag: `--task`

This provides:

- **Consistency**: Same flag name across all commands
- **User Experience**: Users don't need to remember different flag names
- **Intuitive Interface**: `--task` is more natural than `--task-id`

## Proposed Solution

**Option 1 (Recommended)**: Standardize on `--task`

- Change git PR command parameter from `taskId` to `task` to match session commands
- Update any other commands using `taskId` parameter to use `task`
- This maintains consistency with the majority of existing commands

**Option 2**: Standardize on `--task-id`

- Change all session command parameters from `task` to `taskId`
- More verbose but technically more descriptive

**Option 3**: Use CLI parameter mapping customization

- Keep internal parameter names as-is but customize CLI flag names via the CLI bridge

## Implementation Requirements

If choosing Option 1 (recommended):

1. **Update Git Commands**:

   - Change `taskId` parameter to `task` in `src/adapters/shared/commands/git.ts`
   - Update any interfaces and type definitions that reference `taskId` for git commands

2. **Update Domain Functions**:

   - Ensure git domain functions accept `task` parameter instead of `taskId`
   - Update any internal parameter passing

3. **Update Schemas**:

   - Update git command schemas to use `task` instead of `taskId`

4. **Update Documentation**:

   - Update any documentation, help text, or examples that reference `--task-id`

5. **Add Tests**:
   - Verify that `minsky git pr --task <id>` works correctly
   - Ensure backward compatibility testing if needed

## Acceptance Criteria

- [ ] All task-identification commands use the same CLI flag: `--task`
- [ ] `minsky git pr --task <id>` works correctly
- [ ] `minsky session get --task <id>` continues to work
- [ ] All other commands with task parameters use `--task` consistently
- [ ] Help text and documentation reflects the consistent flag naming
- [ ] No breaking changes to command functionality (only flag naming)

## Verification Commands

```bash
# All of these should work consistently:
minsky session get --task 079
minsky session start --task 080
minsky git pr --task 079
minsky session dir --task 079
minsky tasks status get --task 079  # (if this command uses task parameter)
```
