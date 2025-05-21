# Task #119: Fix MCP Rules.list Command to Exclude Rule Content

## Context

The MCP version of the `rules.list` command currently returns the full content of each rule, which makes the output excessively large and difficult to use. This needs to be modified to exclude the rule content from the output, similar to how command-line interfaces typically handle list operations (showing metadata only).

## Requirements

1. **Modify MCP rules.list Command**

   - Update the MCP adapter for the `rules.list` command to exclude the `content` field from the returned rules
   - Alternatively, implement a transformation step that removes the content before returning the results
   - Ensure all other rule metadata (id, name, description, globs, tags, etc.) is still returned

2. **Maintain Behavior Consistency**

   - The command should still function the same way in terms of filtering (by format, tag, etc.)
   - Only the output format should change (excluding content)
   - The change should not affect other commands like `rules.get` which should still return the full rule content

3. **Testing**
   - Update tests if needed to reflect the new output format

## Implementation Steps

1. [ ] Locate the MCP adapter implementation for the rules.list command
2. [ ] Modify the command's execute function to exclude rule content
3. [ ] Consider adding an option to include content if explicitly requested
4. [ ] Update any tests that expect the full content in the response
5. [ ] Test the command to ensure it works correctly
6. [ ] Verify that other rules commands are not affected

## Verification

- [ ] Running the MCP `rules.list` command returns rules without the content field
- [ ] All metadata is still present and correct
- [ ] The command respects all existing filter options
- [ ] All tests pass
- [ ] Other rules commands continue to function correctly
