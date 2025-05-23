# feat(#87): Implement Unified Session and Repository Resolution

## Summary

This PR implements a unified approach to resolve session and repository references, following the concepts and terminology defined in the migration guide. The implementation addresses inconsistencies in the current codebase, where multiple approaches are used to resolve repositories and sessions.

## Changes

### Added

- Created URI normalization utilities in `src/domain/uri-utils.ts` to handle multiple URI formats
- Implemented `resolveRepository` function with consistent interfaces and clear auto-detection strategy
- Implemented `resolveSession` function for unified session resolution
- Added support for multiple input types (URI, path, session name, task ID, auto-detection)
- Created backward-compatible APIs for migration from old functions
- Added comprehensive test coverage for URI normalization and resolution functions

### Changed

- Updated `repository.ts` to use the new URI utilities and resolution strategy
- Updated `session.ts` to use consistent terminology aligned with concepts.md
- Improved error handling with clear, actionable error messages

## Testing

The implementation includes comprehensive unit tests for:

- URI normalization for different URI formats (HTTPS, SSH, file://, plain paths, Windows paths)
- URI validation and conversion between different formats
- Repository information extraction
- Error handling for all edge cases (empty URIs, invalid formats, unsupported conversions)
- Proper handling of local and remote repository URIs

All tests use Bun's testing utilities with appropriate mocking to avoid filesystem dependencies.

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated
