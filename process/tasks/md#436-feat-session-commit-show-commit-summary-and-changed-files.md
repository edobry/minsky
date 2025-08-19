# feat(session commit): show commit summary and changed files

## Context

## Problem

`minsky session commit` currently commits but provides minimal feedback. Users need immediate, actionable output that summarizes what was committed and which files were affected.

## Goal

Enhance `minsky session commit` output to include concise commit metadata and a list of changed files, following meaningful-output-principles.

## Requirements

- After a successful commit, print a summary that includes:
  - Commit hash (short) and subject line
  - Current branch name
  - Author and timestamp (local time)
  - Diffstat summary: files changed, insertions (+), deletions (-)
  - List of changed files with status codes (A/M/D/R/C) and paths
- Provide `--json` flag to output the same information as JSON only (no extra text)
- Provide `--no-files` to hide the per-file list while keeping the summary
- Provide `--oneline` to print a single human-readable line: `<hash> <subject> | <branch> | <N files, +X -Y>`
- Preserve existing flags and behavior; do not change default side-effects other than printing the summary
- Exit codes unchanged

## Output Examples

- Default (human):
  ```
  Committed 3c1a5d9 "session: include commit summary" to branch feature/improve-commit
  Author: Jane Doe <jane@example.com> at 2025-08-19 14:22:03
  5 files changed, 42 insertions(+), 7 deletions(-)
  M src/session/commit.ts
  A src/session/format.ts
  D test/obsolete.spec.ts
  ```
- `--oneline`:
  ```
  3c1a5d9 session: include commit summary | feature/improve-commit | 5 files, +42 -7
  ```
- `--json`:
  ```json
  {
    "hash": "3c1a5d9",
    "subject": "session: include commit summary",
    "branch": "feature/improve-commit",
    "authorName": "Jane Doe",
    "authorEmail": "jane@example.com",
    "timestamp": "2025-08-19T14:22:03-04:00",
    "filesChanged": 5,
    "insertions": 42,
    "deletions": 7,
    "files": [
      { "path": "src/session/commit.ts", "status": "M" },
      { "path": "src/session/format.ts", "status": "A" },
      { "path": "test/obsolete.spec.ts", "status": "D" }
    ]
  }
  ```

## Acceptance Criteria

- Running `minsky session commit` on a repo with staged changes prints the summary and per-file list as specified
- `--json` emits only valid JSON with all specified keys and no extra logs
- `--no-files` hides file list but shows summary lines
- `--oneline` prints a single line with correct values
- Works on repos with rename/copy detection (R/C codes shown)
- Handles 0-file commits (e.g., amend with no changes) gracefully with a clear message
- Covered by tests per framework-specific-tests and meaningful-output-principles

## Notes / Implementation Sketch

- After commit, read: latest commit via `git log -1 --pretty=...` and diffstat via `git show --stat --pretty=...` or use `--numstat` for machine parsing
- Parse changed files from `git show --name-status -1 --pretty=format:`
- Centralize formatting in a small formatter module so both human and JSON share the same data source
- Respect `--verbose` to potentially include full commit body in future; out of scope for now

## Testing

- Add integration tests for human output, `--json`, `--oneline`, `--no-files`
- Include cases: added/modified/deleted/renamed, no changes, many files
- Validate JSON schema and that no extra logs pollute `--json` output

## Non-Goals

- Showing diffs or patch content
- Changing commit behavior itself

## References

- Rules: meaningful-output-principles, framework-specific-tests, tests
- Related command: `session pr` output style for consistency

## Implementation

- Added flags to `sessionCommitCommandParams`: `oneline`, `noFiles`
- Extended `SessionCommitParametersSchema` and `SessionCommitResponseSchema` with metadata fields
- Enhanced domain `sessionCommit()` to collect commit metadata and file-status list using git commands
- Updated CLI formatter to render summary, per-file list, and `--oneline` variant; JSON output unchanged except for extra fields
