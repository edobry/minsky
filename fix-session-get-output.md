# Fix CLI Output Formatting for Session Get Command

## Problem

The Minsky CLI's default output formatter for commands that return structured objects (like `session get`) was too simplistic. When a command returned an object containing nested objects (e.g., `{ success: true, session: { ...details... } }`), the default formatter would only display top-level primitive values, leading to incomplete output like just "success: true" for the `session get` command. Users had to use the `--json` flag to see all details.

## Original (Misleading) Problem Description

The `minsky session get --task <id>` command only displays `success: true` instead of showing the full session details by default. Users need to add the `--json` flag to see comprehensive session information.

## Root Cause Analysis

The `session get` command correctly returned a structured object containing the session details. The issue was located in the `getDefaultFormatter` method within `src/adapters/shared/bridges/cli-bridge.ts`. This formatter did not recursively process nested objects, and for the `session get` command, it only printed the `success: true` part, ignoring the `session: { ... }` object.

## Expected Behavior

The CLI's default output for commands like `session get` should provide a human-readable summary of the key information within the returned object, including details from nested objects, without requiring the `--json` flag.

## Implemented Solution

The `getDefaultFormatter` in `src/adapters/shared/bridges/cli-bridge.ts` was enhanced:

1.  **Specific Handling for `session.get`**: Added logic to call a new `formatSessionDetails` method when `commandDef.id === "session.get"` and a `result.session` object is present.
2.  **`formatSessionDetails` Method**: This new private method iterates through the properties of the session object and prints them in a user-friendly, multi-line format.
3.  **Specific Handling for `session.dir` and `session.list`**: Added similar targeted formatters for these commands to improve their default output.
4.  **Improved Generic Object Formatting**: For other commands returning objects, the formatter now attempts to display more details from nested objects or indicates the presence of complex data (e.g., `key: [X items]` for arrays).

## Acceptance Criteria

- [x] `minsky session get --task <id>` (and by session name) shows full session details in a human-readable format by default.
- [x] The `--json` flag continues to provide the complete, machine-readable JSON output.
- [x] Error messages are clear when a session is not found.
- [x] All existing functionality of the `session get` command and other CLI commands remains intact.
- [x] The default output for `session dir` and `session list` is also improved.
