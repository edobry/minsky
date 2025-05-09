# Task #043: Add Session Information to Task Details

## Context

Currently, when viewing task details in Minsky, users cannot see whether there's an existing session associated with that task. This makes it difficult to know if work is already in progress on a task and which session they should connect to when resuming work.

Adding session information to task details would improve visibility and workflow by showing whether a task already has an associated session, eliminating the need to run a separate command to check for this information.

## Requirements

1. **Update Task Output Structure**
   - Modify the `tasks get` command output to include session information when a session exists for the task
   - Add a clear indicator when no session exists for the task

2. **Session Data Integration**
   - Use the existing `SessionDB.getSessionByTaskId` method to check if a session exists for the task
   - Display relevant session details (session name, creation date) when available

3. **JSON Output Updates**
   - For the `--json` output format, include the session information in a structured way
   - Ensure backward compatibility by making session-related fields optional

4. **UI/UX Improvements**
   - Present the session information in a clear, readable format
   - Make it visually distinct to ensure it's noticed by users

## Implementation Steps

1. [ ] Update the `createGetCommand` function in `src/commands/tasks/get.ts`:
   - [ ] Import the `SessionDB` class from the session domain module
   - [ ] Create a new instance of `SessionDB` in the command action handler
   - [ ] Use `getSessionByTaskId` to check if a session exists for the current task
   - [ ] Add session information to the output display

2. [ ] Update the non-JSON output format:
   - [ ] Add a "Session" section to the output
   - [ ] Display session name, creation date, and other relevant details if a session exists
   - [ ] Display "No active session" if no session exists

3. [ ] Update the JSON output format:
   - [ ] Add a `session` property to the output JSON object
   - [ ] Include session details or null if no session exists

4. [ ] Add tests for the updated functionality:
   - [ ] Test when a session exists for a task
   - [ ] Test when no session exists for a task
   - [ ] Test the JSON output format

5. [ ] Update related documentation to reflect the new feature

## Verification

- [ ] Running `minsky tasks get <task-id>` displays session information when a session exists
- [ ] The command clearly indicates when no session exists for a task
- [ ] The `--json` output includes session information when available
- [ ] All tests for the updated functionality pass 
