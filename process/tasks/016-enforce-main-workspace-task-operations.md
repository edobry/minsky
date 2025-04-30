# Task #016: Enforce Task Operations in Main Workspace

## Context

Currently, task management operations (like changing task state, creating new tasks, etc.) can be performed from any location, including session repositories. This can lead to inconsistencies and confusion since task-related files should always be managed in the main workspace repository. We need to ensure that all task operations are performed in the context of the main workspace, even when executed from a session repository.

## Requirements

1. **Session Repository Detection**
   - Detect when a task operation is being executed from within a session repository
   - Identify the associated main workspace repository path
   - Use the main workspace path for all task-related operations

2. **Task Operations to Handle**
   - Task state changes (`minsky tasks status set`)
   - Task creation (`minsky tasks create`)
   - Task listing and querying (`minsky tasks list`, `minsky tasks get`)
   - Any other commands that read or modify task-related files

3. **Implementation Approach**
   - Add a new option `--workspace <path>` to explicitly specify the main workspace path
   - When in a session repo, automatically detect and use the main workspace path
   - Maintain backward compatibility for commands run from the main workspace
   - No physical directory change should be required

4. **Error Handling**
   - Provide clear error messages when main workspace cannot be determined
   - Handle cases where session repository state is invalid or corrupted
   - Validate workspace path exists and contains required Minsky configuration

## Implementation Steps

1. [ ] Add workspace path detection to core Minsky functionality:
   - [ ] Create utility function to detect if current directory is a session repository
   - [ ] Add function to resolve main workspace path from session repository
   - [ ] Add workspace path validation function

2. [ ] Update TaskService and TaskBackend:
   - [ ] Add workspace path parameter to relevant methods
   - [ ] Modify file operations to use workspace path for task-related files
   - [ ] Update tests to cover workspace path handling

3. [ ] Modify task-related commands:
   - [ ] Add `--workspace` option to all task commands
   - [ ] Implement automatic workspace detection when in session repos
   - [ ] Update command handlers to use workspace path for operations

4. [ ] Add session repository utilities:
   - [ ] Create function to get session info from repository path
   - [ ] Add method to validate session-workspace relationship
   - [ ] Implement caching for workspace path resolution

5. [ ] Update documentation and error messages:
   - [ ] Document new behavior in command help text
   - [ ] Add clear error messages for workspace-related issues
   - [ ] Update README with workspace path handling details

6. [ ] Add comprehensive tests:
   - [ ] Test workspace detection in various scenarios
   - [ ] Verify task operations use correct paths
   - [ ] Test error handling for invalid configurations

## Verification

- [ ] All task operations work correctly when run from:
  - [ ] Main workspace directory
  - [ ] Session repository directory
  - [ ] Arbitrary directory with `--workspace` option
- [ ] Task files are always created/modified in the main workspace
- [ ] Clear error messages are shown when:
  - [ ] Main workspace cannot be determined
  - [ ] Session repository is invalid
  - [ ] Workspace path is invalid
- [ ] All existing task operations maintain backward compatibility
- [ ] All tests pass
- [ ] Documentation is complete and accurate 
