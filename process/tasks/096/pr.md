# feat(#96): Improve CLI Adapter Structure for Shared Options

## Summary

This PR introduces a shared options system for CLI commands to reduce code duplication and ensure consistency across the Minsky CLI interface. The implementation includes shared TypeScript interfaces, option application functions, and parameter normalization helpers.

## Changes

### Added

- Created `src/adapters/cli/utils/shared-options.ts` with:
  - Type definitions for common option groups (`RepoOptions`, `OutputOptions`, etc.)
  - Helper functions to add options to Commander commands
  - Normalization functions to standardize parameter handling
- Added tests for the shared options module
- Created implementation notes documenting the approach and benefits

### Changed

- Updated `tasks.ts` to use the shared option utilities
- Updated `session.ts` (list command) to use the shared option utilities
- Modified `index.ts` to export the new shared options module

## Testing

The implementation includes comprehensive tests that verify:

- Options are correctly added to commands with consistent descriptions
- Normalization functions properly convert CLI options to domain parameters
- The shared option utilities work correctly together with CLI adapters

Manual testing was performed to ensure that the refactored commands continue to work as expected.

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
