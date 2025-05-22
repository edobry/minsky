# feat(#125): implement CLI bridge for shared command registry

## Summary

This PR implements a CLI bridge that auto-generates Commander.js commands from the shared command registry. This eliminates the need for maintaining separate CLI adapters and shared command implementations, reducing duplication and ensuring consistency across interfaces.

## Changes

### Added

- Implemented CLI bridge in `src/adapters/shared/bridges/cli-bridge.ts` that converts shared commands to Commander.js commands
- Added shared command registration for `init` command
- Migrated `tasks spec`, `tasks list`, `tasks get`, and `tasks create` commands to use the shared command registry
- Migrated `git commit` and `git push` commands to use the shared command registry
- Updated CLI entrypoint to use the CLI bridge for all command categories

### Changed

- Refactored manual CLI command implementations to use the shared command registry
- Simplified the CLI entrypoint by using the CLI bridge for command registration
- Fixed duplicate command registration in shared session commands
- Updated CHANGELOG.md with migration details

## Testing

All migrated commands have been tested and verified to work correctly through the CLI bridge. Basic functionality tests were performed to ensure that the commands work the same way as before the migration.

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
