# Task #095: Fix git prepare-pr Branch Naming Issues

## Context

The `minsky git prepare-pr` command has inconsistent behavior when determining the PR branch name. When used with a title parameter, it uses the title to generate the branch name instead of using the git branch name directly, causing confusion and requiring explicit parameters.

## Requirements

1. **Consistent Branch Naming**

   - The PR branch name should consistently use the current git branch name as the base for naming
   - The PR branch name should always be in the format `pr/<current-git-branch-name>` regardless of whether other parameters (like title) are provided

2. **Title Parameter Usage**

   - When a title parameter is provided, it should only be used for the commit message, not for determining the branch name
   - This maintains separation of concerns: branch naming comes from git, descriptive titles come from parameters

3. **Backward Compatibility**
   - Maintain backward compatibility with current command options
   - Ensure session-specific behavior continues to work correctly

## Implementation Steps

1. [ ] Update GitService preparePr method in src/domain/git.ts:

   - [ ] Modify branch name determination to consistently use the git branch name
   - [ ] Only use title parameter for the commit message, not for branch naming
   - [ ] Add logging to indicate which branch name is being used
   - [ ] Ensure compatibility with session-specific workflow

2. [ ] Add tests:

   - [ ] Test that branch name is derived from git branch name even when title is provided
   - [ ] Test that commit message uses the title parameter when provided

3. [ ] Update documentation:
   - [ ] Update command documentation to clarify branch naming behavior
   - [ ] Update PR workflow documentation and rules to reflect the changes

## Verification

- [ ] Running `minsky git prepare-pr` creates a PR branch named after the current git branch
- [ ] Running `minsky git prepare-pr --title "Some title"` still creates a PR branch named after the current git branch, not derived from the title
- [ ] The commit message uses the provided title when available
- [ ] All tests pass
- [ ] Documentation accurately reflects the behavior
