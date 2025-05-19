# refactor(#096): Improve CLI adapter structure for shared options

## Summary

This PR introduces a new shared options system for CLI commands to reduce code duplication and improve consistency across command implementations. It creates reusable option definitions for commonly used options (like repository resolution, output format, and task identification) and updates existing commands to use these shared definitions.

## Changes

### Added

- New utility module `src/adapters/cli/utils/shared-options.ts` with:
  - TypeScript interfaces for common option groups
  - Functions to add common options to Commander commands
  - Parameter normalization helpers

### Changed

- Updated all CLI commands to use shared option definitions:
  - Git commands
  - Task commands
  - Session commands
  - Rule commands
- Standardized option descriptions and behaviors across commands

### Fixed

- Inconsistencies in option handling between different commands
- Duplicate code for option handling across the codebase

## Testing

- All existing CLI command tests have been updated and pass
- New tests added for shared option utilities
- Manual verification of commands with shared options

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
