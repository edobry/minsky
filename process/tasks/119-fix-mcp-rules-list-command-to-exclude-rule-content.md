# Task #119: Fix MCP Rules.list Command to Exclude Rule Content

## Context

The MCP version of the `rules.list` command currently returns the full content of each rule, which makes the output excessively large and difficult to use. This needs to be modified to exclude the rule content from the output, similar to how command-line interfaces typically handle list operations (showing metadata only).

## Requirements

1. **Modify MCP rules.list Command**

   - Update the MCP adapter for the `rules.list` command to exclude the `content` field from the returned rules
   - Implement a transformation step that removes the content before returning the results
   - Ensure all other rule metadata (id, name, description, globs, tags, etc.) is still returned

2. **Maintain Behavior Consistency**

   - The command should still function the same way in terms of filtering (by format, tag, etc.)
   - Only the output format should change (excluding content)
   - The change should not affect other commands like `rules.get` which should still return the full rule content

3. **Testing**
   - Update tests if needed to reflect the new output format

## Implementation Steps

1. [x] Locate the MCP adapter implementation for the rules.list command
2. [x] Modify the command's execute function to exclude rule content
3. [-] Consider adding an option to include content if explicitly requested (decided against this)
4. [x] Test the command to ensure it works correctly
5. [x] Verify that other rules commands are not affected

## Verification

- [x] Running the MCP `rules.list` command returns rules without the content field
- [x] All metadata is still present and correct
- [x] The command respects all existing filter options
- [x] All tests pass
- [x] Other rules commands continue to function correctly

## Detailed Implementation Plan

### Analysis

The MCP adapter for the `rules.list` command is implemented in `src/adapters/mcp/rules.ts`. The command currently uses the `RuleService.listRules()` method from the domain layer to fetch rules, then returns all rule data including the content.

The issue is that the rule content can be large, making the output difficult to use. We need to modify the MCP adapter to filter out the content field before returning the results.

### Steps

1. **Modify MCP Adapter**

   - Update the `rules.list` command in `src/adapters/mcp/rules.ts` to:
     - Fetch rules using the existing domain service
     - Map over the returned rules to create a new array with all properties except `content`
     - The rule content should always be excluded from the response

2. **Implementation Approach**

   - After fetching rules from the domain service, transform the result to exclude content
   - Always exclude content from the `rules.list` output, following CLI convention
   - Ensure the `rules.get` command still returns the full rule content

3. **Test the Changes**

   - Verify the content field is excluded from rules.list results
   - Check that other rules commands (like `rules.get`) still include content
   - Note: Testing the MCP commands directly in unit tests is complex due to the FastMCP dependency

### Implementation Details

The main modification is in the `execute` function of the `rules.list` command in `src/adapters/mcp/rules.ts`:

1. After fetching rules from the domain service, transform the result to exclude content:
   ```typescript
   const transformedRules = rules.map(({ content, ...rest }) => rest);
   ```
2. Return the transformed rules in the response

This approach:
- Makes the command more usable for typical list operations
- Reduces response size and improves performance
- Follows the principle of least surprise (list commands typically return metadata only)
