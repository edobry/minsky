# Auto-detect Session Context in Session Commands

## Problem

Currently, when running commands like `minsky session get` or `minsky session dir` within a session workspace, users must explicitly provide the session name. This creates unnecessary friction as the session context is already implicitly available from the workspace location.

## Solution

This PR implements auto-detection of session context in session commands. When running commands like `session dir` or `session get` from within a session workspace, Minsky now automatically detects and uses the current session, eliminating the need to specify the session name explicitly.

Key changes:
- Added `getCurrentSession` utility function in the workspace module
- Updated `session dir` and `session get` commands to use auto-detection when no session name is provided
- Added `--ignore-workspace` option to bypass auto-detection when needed
- Created proper test coverage using dependency injection testing approach
- Improved error messages for better user experience
- Fixed linting issues in session command files

## Testing

Since direct module property modification doesn't work well with Bun's testing environment (causing "Attempted to assign to readonly property" errors), we created an alternative testing approach:

1. A mock helper module that uses dependency injection to provide a mocked getCurrentSession
2. A manual test script that verifies all auto-detection scenarios

This approach successfully tests:
- Auto-detection in `session dir` and `session get` commands
- JSON output formatting with auto-detection
- Explicit session name overriding auto-detection
- The `--ignore-workspace` flag bypassing auto-detection

## Status
All tests are now passing with the implementation of proper dependency injection for the session commands, and all linting issues have been resolved. Task is marked as DONE.

## Future Considerations
If a `session update` command is added in the future, it should include the same auto-detection pattern.

## Related
- Builds on the existing workspace detection functionality from Task #016

# Pull Request for branch `task#027`

## Commits
08a24a0 fix: Fix linting issues in session command files with dependency injection
384ea73 docs: Add PR description for task #027
d87b6cc docs: Add explanatory comment about test approach for autodetect.test.ts
4f5dc1d docs: Update task #027 Remaining Work section to reflect progress with mock helper approach
59fc075 docs: Update task #027 work log with new test approach
2f9c5d7 test: Add mock helper for session auto-detection tests
72716b9 Update task #027 status to DONE
130a132 Implement auto-detection of session context in session commands
0ab7144 test: Add test script to demonstrate fixed workspace detection
700bfef fix: Update workspace detection to handle nested directory structures
0ff9ca3 task#027: Add PR description
1d69d88 task#027: Implement auto-detection of session context in session commands
e8c1e7b task#027: Update task documentation and changelog
855e4f0 task#027: Add Standard Session Navigation Pattern section to minsky-workflow rule


## Modified Files (Changes compared to merge-base with main)
.cursor/rules/minsky-workflow.mdc
CHANGELOG.md
process/tasks.md
process/tasks/027-autodetect-session-in-commands.md
process/tasks/027/pr-summary.md
process/tasks/027/pr.md
src/commands/session/autodetect.test.ts
src/commands/session/cd.test.ts
src/commands/session/cd.ts
src/commands/session/get.test.ts
src/commands/session/get.ts
src/commands/session/index.ts
src/domain/workspace.test.ts
src/domain/workspace.ts
test-fixed-functions.ts
test-session-detection.ts


## Stats
 .cursor/rules/minsky-workflow.mdc                  |  17 +
 CHANGELOG.md                                       |   1 +
 process/tasks.md                                   |   2 +-
 .../tasks/027-autodetect-session-in-commands.md    |  57 +--
 process/tasks/027/pr-summary.md                    |  56 +++
 process/tasks/027/pr.md                            |  43 ++
 src/commands/session/autodetect.test.ts            | 383 +++++++++++++++++++++
 src/commands/session/cd.test.ts                    |  21 ++
 src/commands/session/cd.ts                         |  27 +-
 src/commands/session/get.test.ts                   |  42 +++
 src/commands/session/get.ts                        | 130 ++++---
 src/commands/session/index.ts                      |  10 +
 src/domain/workspace.test.ts                       | 119 +++++--
 src/domain/workspace.ts                            | 132 ++++---
 test-fixed-functions.ts                            |  36 ++
 test-session-detection.ts                          |  84 +++++
 16 files changed, 1013 insertions(+), 150 deletions(-)
