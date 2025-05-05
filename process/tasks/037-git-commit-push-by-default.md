# Task #037: Make git commit command push by default, unless --no-push flag is supplied

## Context

Currently, the `git commit` command only stages and commits changes, but does not push them to the remote repository. This can lead to unpushed commits and workflow inconsistencies. To streamline the workflow and reduce the risk of unpushed work, the command should push by default after committing, unless the user explicitly opts out.

## Requirements

1. **Default Push Behavior**
   - After a successful commit, the command should automatically push the current branch to the remote repository.
   - This should be the default behavior.

2. **Opt-Out Flag**
   - Add a `--no-push` flag to the command.
   - If `--no-push` is supplied, the command should skip the push step and only commit.

3. **User Feedback**
   - Clearly indicate in the output whether a push was performed or skipped.
   - If the push fails, display an error message and exit with a non-zero code.

4. **Tests**
   - Add or update tests to verify:
     - Default behavior includes a push after commit
     - Supplying `--no-push` skips the push
     - Proper error handling and output for push failures

5. **Documentation**
   - Update help text and documentation to describe the new default behavior and the `--no-push` flag.

## Implementation Steps

- [ ] Update the git commit command implementation to push by default
- [ ] Add the `--no-push` flag
- [ ] Update output and error handling
- [ ] Add or update tests
- [ ] Update documentation and help text
- [ ] Update the changelog

## Verification

- [ ] By default, running the git commit command pushes the branch after committing
- [ ] Supplying `--no-push` skips the push
- [ ] Output clearly indicates whether a push was performed or skipped
- [ ] Tests cover both behaviors and error cases
- [ ] Documentation is updated 
