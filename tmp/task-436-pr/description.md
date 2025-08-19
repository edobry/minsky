## Summary

Enhance `minsky session commit` output to show actionable commit details, improving user feedback after commits.

## Changes

### Added

- New `--oneline` flag: single-line commit summary output
- New `--no-files` flag: hide per-file list while keeping summary

### Changed

- `session commit` now returns commit metadata from the domain, not just CLI formatting:
  - `commitHash`, `shortHash`, `subject`, `branch`, `authorName`, `authorEmail`, `timestamp`
  - Diffstat: `filesChanged`, `insertions`, `deletions`
  - Per-file list with status codes and paths (supports R/C)

### CLI Output

- Human default prints: short hash + subject + branch, author/time, diffstat, and per-file list
- `--oneline`: `<hash> <subject> | <branch> | <N files, +X -Y>`
- `--json`: Structured fields only (no extra logs)

## Files Touched (high-level)

- `src/adapters/shared/commands/session-parameters.ts` (flags)
- `src/domain/schemas/session-schemas.ts` (schemas)
- `src/domain/session/session-commands.ts` (domain logic and metadata collection)
- `src/adapters/shared/bridges/cli/result-formatter.ts` (human output rendering)
- `CHANGELOG.md` and task spec updated

## Testing

- Manual verification paths:
  - Default human: `bun src/cli.ts session commit -m "msg"`
  - Oneline: `bun src/cli.ts session commit -m "msg" --oneline`
  - No files: `bun src/cli.ts session commit -m "msg" --no-files`
  - JSON: `bun src/cli.ts session commit -m "msg" --json`

## Notes

- Backward compatible; exit codes and side effects unchanged.
- JSON mode unaffected aside from additional fields.
