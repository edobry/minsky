# refactor(#097): Standardize option descriptions across CLI and MCP adapters

## Summary

This PR introduces a centralized system for option and parameter descriptions to ensure consistency between CLI and MCP (Model-Code-Platform) adapters. By creating a shared description registry, we eliminate string duplication, improve maintenance, and ensure consistent documentation across all interfaces.

## Changes

### Added

- New utility module `src/utils/option-descriptions.ts` with:
  - Centralized constants for all option descriptions
  - Logical grouping of descriptions by functional area
  - Comprehensive JSDoc documentation

### Changed

- Extended shared options from task #096 to use centralized descriptions
- Updated MCP adapter interfaces to reference the same description strings
- Applied consistent descriptions across all commands:
  - Git commands
  - Task commands
  - Session commands
  - Rule commands

### Fixed

- Inconsistent descriptions between CLI and MCP for the same parameters
- Duplicated description strings throughout the codebase
- Potential documentation drift between interfaces

## Testing

- Verified that CLI help text correctly uses the centralized descriptions
- Confirmed that MCP documentation is consistent with CLI descriptions
- Added tests to verify description consistency between interfaces
- Manually verified that all descriptions are clear and appropriate for both contexts

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
