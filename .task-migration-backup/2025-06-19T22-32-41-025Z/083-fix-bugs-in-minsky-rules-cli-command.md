# Task #083: Fix Bugs in Minsky Rules CLI Command

## Context

While working on Task #078 (fixing the minsky rules CLI to operate on rules in the current workspace), we discovered several bugs in the rules command implementation:

1. When creating/updating rules with the `--content` parameter pointing to a file path, the command uses the file path as the content instead of reading the file's contents.
2. There's an inconsistency between how the CLI accepts globs (as a comma-separated string) and how they're stored in the rule file (as a YAML array).

## Requirements

1. **Fix Content File Loading**

   - When a file path is provided with `--content`, read the file's contents rather than using the path as content
   - Verify the file exists before attempting to read it
   - Provide a clear error message if the file cannot be read

2. **Improve Glob Format Handling**

   - Make the CLI more resilient to different glob format inputs (both comma-separated strings and YAML array formats)
   - Add validation that ensures globs are properly formatted
   - Provide clear error messages when glob formats are incorrect
   - Consider supporting multiple formats or explicitly documenting the expected format

3. **Add Tests for Edge Cases**
   - Add tests for file content loading
   - Add tests for different glob format inputs
   - Add tests for error handling edge cases

## Implementation Steps

1. [ ] Fix content file loading in `src/adapters/cli/rules.ts`

   - [ ] Detect if the content parameter is a file path
   - [ ] Read the file contents if it exists
   - [ ] Add appropriate error handling for file reading

2. [ ] Update glob parsing logic to be more robust

   - [ ] Handle both comma-separated strings and array formats
   - [ ] Add validation for globs format
   - [ ] Document the expected format in help text

3. [ ] Add appropriate error handling and validation

   - [ ] Provide clear error messages for invalid inputs
   - [ ] Add validation for file existence
   - [ ] Add validation for glob format

4. [ ] Add tests for the fixed functionality

   - [ ] Test file content loading with various file paths
   - [ ] Test glob parsing with different input formats
   - [ ] Test error handling for edge cases

5. [ ] Update documentation to clarify correct usage
   - [ ] Update help text for `--content` and `--globs` parameters
   - [ ] Add examples in the documentation

## Notes

This bug was discovered while trying to create a new rule using a file for content:

```bash
minsky rules create workspace-verification --description "..." --globs "..." --content workspace-verification-content.md
```

The resulting rule file contained the literal path `workspace-verification-content.md` as content instead of the file's contents.

Additionally, when specifying globs, there's confusion about whether they should be provided as a comma-separated string or in YAML array format.

The proper fix should make the command more user-friendly and less prone to these kinds of errors.
