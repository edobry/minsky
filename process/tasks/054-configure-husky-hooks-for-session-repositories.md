# Configure Husky Hooks for Session Repositories

## Context

When a new Minsky session is created using `minsky session start`, the Git hooks (specifically pre-commit and pre-push hooks) from the main repository are not automatically set up in the session repository. This means that code quality checks like linting and formatting are not enforced in session repositories, potentially leading to inconsistent code quality and issues when merging changes back to the main repository.

Currently, session repositories only have sample hooks but not the actual hooks from the main repo. This was discovered during work on fixing linting issues in the rules command files, where linting errors could be committed in the session repository without being caught by pre-commit hooks.

## Requirements

1. **Session Creation Hook Integration**

   - Modify `minsky session start` to properly set up Git hooks in session repositories
   - Ensure that the hooks use the same configuration as the main repository
   - Make the process automatic and transparent to users

2. **Hook Configuration**

   - Pre-commit hooks should run linting in session repositories
   - Pre-push hooks should be properly configured in session repositories
   - The hooks should use the same configuration files (.eslintrc.json, .lintstagedrc.json)

3. **Hook Maintenance**
   - Consider how hooks will be maintained if the main repository's hooks change
   - Document the approach and any manual steps required for updates

## Implementation Steps

1. [ ] Investigate the current session creation process in `src/commands/session/start.ts`
2. [ ] Analyze how Husky is set up in the main repository
3. [ ] Explore potential approaches:
   - [ ] Copying hook files from main repo to session repo
   - [ ] Configuring Husky in the session directory
   - [ ] Investigating if Git supports sharing hooks between repositories
4. [ ] Implement the chosen approach:
   - [ ] Modify `src/commands/session/start.ts` to set up hooks
   - [ ] Handle path differences between main and session repositories
   - [ ] Ensure proper error handling
5. [ ] Add tests for the new functionality
6. [ ] Update documentation to reflect the changes
7. [ ] Consider updating existing sessions:
   - [ ] Develop a command to update hooks in existing sessions
   - [ ] Document the process for users

## Verification

- [ ] Creating a new session properly sets up Git hooks
- [ ] Pre-commit hooks in session repositories catch linting errors
- [ ] Pre-push hooks function correctly
- [ ] The process is transparent to users
- [ ] Documentation is clear and comprehensive
- [ ] Tests pass
