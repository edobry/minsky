# Add --body-path Option and Required Title/Body to Session PR Command

## Summary

This PR implements Task #150, adding the `--body-path` option to the `session pr` command and enforcing proper validation for title and body parameters.

## Changes Made

### ✅ Core Implementation
- **Added `--body-path` parameter** to `sessionPrParamsSchema` and command parameters
- **Implemented file reading logic** in `sessionPrFromParams` function with robust error handling
- **Added mutual exclusivity validation** between `--body` and `--body-path` parameters
- **Enhanced schema validation** to prevent ambiguous parameter combinations

### ✅ Validation & Error Handling
- **File not found errors**: Clear `ValidationError` when bodyPath file doesn't exist
- **Empty file validation**: Prevents PRs with empty body content from files
- **Mutual exclusivity**: Error when both `--body` and `--body-path` are provided
- **Required parameters**: Either `--body` or `--body-path` must be provided
- **Path resolution**: Supports both relative and absolute file paths

### ✅ Comprehensive Testing
- **Created 5 focused unit tests** covering all bodyPath functionality
- **Tested error scenarios**: Non-existent files, empty files, validation edge cases
- **Verified parameter validation**: Mutual exclusivity and required parameter enforcement
- **Manual testing**: All scenarios tested using session's local code

## Technical Implementation

### Schema Updates
```typescript
export const sessionPrParamsSchema = z
  .object({
    // ... existing fields
    bodyPath: z.string().optional().describe("Path to file containing PR body text"),
  })
  .refine((data) => data.body || data.bodyPath, {
    message: "Either 'body' or 'bodyPath' must be provided",
  })
  .refine((data) => !(data.body && data.bodyPath), {
    message: "Cannot provide both 'body' and 'bodyPath' - use one or the other",
  });
```

### File Reading Logic
- Resolves relative paths from current working directory
- Validates file exists and is readable
- Checks file is not empty
- Provides clear error messages for all failure scenarios

## Breaking Changes

⚠️ **Title parameter is now required** (was previously optional)
⚠️ **Either `--body` or `--body-path` must be provided** (mutual exclusivity enforced)

## Testing Results

### Unit Tests
```
✓ sessionPrFromParams bodyPath file reading functionality > should read body content from bodyPath when provided
✓ sessionPrFromParams bodyPath file reading functionality > should handle non-existent files correctly  
✓ sessionPrFromParams bodyPath file reading functionality > should detect empty files correctly
✓ sessionPrFromParams bodyPath file reading functionality > should work with relative paths correctly
✓ sessionPrFromParams bodyPath file reading functionality > should validate bodyPath parameter priority logic
```

### Manual Validation
- ✅ `--body-path` reads file content correctly
- ✅ Error handling for missing/empty files works
- ✅ Mutual exclusivity validation prevents confusion
- ✅ Help text displays new options properly
- ✅ Both relative and absolute paths supported

## Usage Examples

### Using file for PR body
```bash
minsky session pr --title "My Feature" --body-path pr-description.md --task 123
```

### Using direct body text
```bash
minsky session pr --title "My Feature" --body "Short description" --task 123
```

### Error cases now properly handled
```bash
# This will error - mutual exclusivity
minsky session pr --title "My Feature" --body "text" --body-path file.md

# This will error - missing required body
minsky session pr --title "My Feature" --task 123
```

## Documentation Updates

- Updated CLI help text to show `--body-path` option
- Title parameter now marked as required in help
- Clear parameter descriptions for both body options

## Task Requirements Verification

All Task #150 acceptance criteria have been met:

- [x] `--body-path` option is added to `session pr` command
- [x] Command reads file content when `--body-path` is provided
- [x] Title parameter is required
- [x] Either `--body` or `--body-path` is required
- [x] Clear validation errors for missing required parameters
- [x] File read errors are handled gracefully
- [x] Both relative and absolute file paths work correctly
- [x] Unit tests cover new functionality and edge cases
- [x] Documentation is updated to reflect new requirements

## Follow-up Tasks

This implementation is complete and ready for production use. The bodyPath functionality provides a clean, intuitive way to manage PR descriptions from files while maintaining backward compatibility for direct text input.
