# Fix Session Start CLI Design

## Problem

The current `minsky session start` command has incorrect argument design:

- Current: `minsky session start <task-id>` treats the positional argument as a task ID
- Desired: `minsky session start <session-name>` treats the positional argument as a session name
- Should support: `minsky session start <session-name> --task <task-id>` to associate with a task

The user tried `minsky session start --task 049` and got "unknown option '--task'".

## Requirements

1. Change the `session start` command to:

   - Accept a session name as the positional argument
   - Add a `--task` option to associate the session with a task ID
   - Maintain backward compatibility where possible

2. Update the command signature to:

   ```
   minsky session start [options] <session-name>

   Options:
     --task <task-id>    Associate session with a task
   ```

3. Update help documentation accordingly

## Expected Behavior

- `minsky session start my-session` → Creates session named "my-session"
- `minsky session start my-session --task 049` → Creates session "my-session" associated with task 049
- Existing sessions that were created with task IDs should continue to work

## Files Likely Affected

- Session start command implementation
- CLI argument parsing
- Help text/documentation
