# fix(#119): Fix MCP Rules.list Command to Exclude Rule Content

## Summary

This PR fixes the MCP `rules.list` command to exclude rule content from the output, making the response more manageable and consistent with CLI behavior. Previously, the MCP version of this command would return the full content of each rule, resulting in excessively large responses.

## Changes

### Fixed

- Modified the MCP adapter for the `rules.list` command to exclude the `content` field from the returned rules
- Implemented a transformation step that removes content before returning the results
- Ensured all other rule metadata (id, name, description, globs, tags, etc.) is still returned in the response
- Maintained behavior consistency for all filtering options (by format, tag, etc.)
- Verified that other commands like `rules.get` still return the full rule content as expected

### Added

- Created unit tests to verify correct content exclusion behavior
- Added entry to CHANGELOG.md documenting the fix

## Testing

The changes were tested by:
- Manually verifying that the MCP `rules.list` command now excludes content
- Confirming that other metadata fields are still present in the response
- Ensuring that filtering options still work as expected
- Verifying that the `rules.get` command still includes content
- Writing tests that check the expected behavior

## Checklist

- [x] All requirements implemented
- [x] All tests pass
- [x] Code quality is acceptable
- [x] Documentation is updated
- [x] Changelog is updated

## Base Branch: main
## PR Branch: pr/119
