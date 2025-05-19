# Bug Fix: Minsky Rules CLI Command Issues

## Summary

This task addresses the issues found in the previous fix attempt for the Minsky rules CLI command. There are two main bugs that need to be fixed:

1. File content loading: The `--content` parameter doesn't correctly read file contents when a file path is provided. Instead, it uses the file path as the literal content.
2. Glob format parsing: The command doesn't properly handle glob formats, especially when using JSON array format.

## Implementation Details

### 1. File Content Loading Fix

Added a helper function `readContentFromFileIfExists` that:
- Checks if the provided content path exists as a file
- If it exists, reads and returns the file contents
- If not, returns the original string (treating it as inline content)
- Handles errors appropriately

This function is used in both the create and update commands to process the `--content` parameter.

### 2. Glob Format Parsing Fix

Added a helper function `parseGlobs` that:
- Detects if the globs string is in JSON array format (starts with `[` and ends with `]`)
- If in JSON format, attempts to parse it as JSON
- Falls back to comma-separated handling if JSON parsing fails
- Returns the globs as an array of strings

### 3. Documentation Updates

- Updated the help text for the `--content` and `--globs` parameters to make their usage clearer
- Added better error handling for file reading operations

## Testing

The fix can be verified by:
1. Creating a rule with `--content` pointing to a file
2. Creating a rule with `--globs` in JSON array format
3. Retrieving the rules to confirm the content and globs were properly processed

## Notes

This implementation properly handles both file content loading and glob format parsing, making the CLI more user-friendly and less error-prone. 
