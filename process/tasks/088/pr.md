# feat(#88): Standardize Repository URI Handling

## Summary

This PR implements consistent repository URI handling across the codebase as outlined in Task #088. It creates a standardized approach to parsing, normalizing, validating, and converting repository URIs between different formats, ensuring consistent behavior across all repository operations.

## Changes

### Added

- New `repository-uri.ts` module that builds on top of existing `uri-utils.ts` functionality
- Comprehensive URI parsing that supports all required formats:
  - HTTPS URLs: `https://github.com/org/repo.git`
  - SSH URLs: `git@github.com:org/repo.git`
  - Local file URIs: `file:///path/to/repo`
  - Plain filesystem paths: `/path/to/repo`
  - GitHub shorthand notation: `org/repo`
- Utility functions for common URI operations:
  - Parsing repository URIs into components
  - Normalizing URIs to standard formats
  - Validating URIs according to format rules
  - Converting between URI formats
  - Detecting repository URIs from current directory
- Comprehensive test suite with 100% coverage for new functionality

### Changed

- Updated `repo-utils.ts` to use the new `repository-uri.ts` module
- Updated repository backends (GitHub, Remote, Local) to use standardized URI utilities
- Enhanced error handling for URI parsing and validation
- Updated JSDoc comments with standardized terminology
- Removed deprecated `normalizeRepoName` function in favor of direct `normalizeRepositoryURI` usage

### Fixed

- Inconsistent handling of repository URLs and paths
- Confusion between different URI formats across the codebase
- Missing validation for repository URIs in several places
- Compatibility issues with GitHub shorthand notation

## Testing

The implementation includes comprehensive tests that:
- Verify parsing for all supported URI formats
- Test normalization of various URI types
- Validate repository URI formats
- Verify conversion between formats
- Ensure backward compatibility with existing code

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated 
