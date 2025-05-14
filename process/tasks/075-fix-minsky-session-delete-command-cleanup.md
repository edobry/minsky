# Task #075: Fix Minsky Session Delete Command Cleanup

## Context

The `minsky session delete` command is intended to remove both the session repository directory and the session record from the database. However, during recent usage (SpecStory history [YYYY-MM-DD_HH-MM-topic](.specstory/history/YYYY-MM-DD_HH-MM-topic.md)), it was observed that the command reported success but failed to remove the session record from the database, requiring manual intervention. This indicates a potential bug in the command's implementation.

## Requirements

1.  Investigate the implementation of `minsky session delete` in `src/commands/session/delete.ts` and the related domain logic in `src/domain/session.ts`.
2.  Identify the root cause of the failure to remove the session record from the database.
3.  Implement the necessary changes to ensure that the `minsky session delete` command reliably removes both the session directory and the database record.
4.  Add or update tests in `src/commands/session/delete.test.ts` and `src/domain/session.test.ts` to cover the fixed cleanup logic and prevent regressions.

## Implementation Steps

1.  Analyze existing code and identify the bug.
2.  Implement the fix in the relevant files (`src/commands/session/delete.ts`, `src/domain/session.ts`).
3.  Update tests to verify the fix.
4.  Ensure error handling is robust and informative.

## Verification

- Run `minsky session delete <session-name>` for a test session.
- Verify that the session directory is removed.
- Verify that the session record is removed from `/Users/edobry/.local/state/minsky/session-db.json`.
- All tests pass.

## Acceptance Criteria

- [ ] The `minsky session delete` command successfully removes both the session repository directory and the session record from the database.
- [ ] Appropriate error handling is in place for cases where cleanup fails.
- [ ] Tests cover the corrected cleanup logic.

## Related

- Task #015: Add `session delete` command to remove session repos and records
