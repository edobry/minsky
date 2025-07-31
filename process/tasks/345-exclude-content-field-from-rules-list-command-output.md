# Exclude Content Field from Rules.list Command Output

## Context

The `rules.list` command currently returns the full `content` field in both CLI `--json` and MCP outputs, making the responses unnecessarily large and unwieldy. While the CLI formatted output already shows only summary information (ID, format, description), the raw data returned by the command still includes the content field.

## Problem

1. **CLI with `--json` flag**: Returns full rule objects including large content fields
2. **MCP interface**: Returns full rule objects including large content fields
3. **Inconsistent behavior**: Formatted CLI output excludes content, but raw data includes it

## Requirements

1. **Modify Shared Command Implementation**
   - Update the `rules.list` command in `src/adapters/shared/commands/rules.ts`
   - Transform the rules array to exclude the `content` field before returning
   - Ensure all other metadata (id, name, description, globs, tags, format, etc.) is preserved

2. **Maintain Interface Consistency**
   - Both CLI `--json` and MCP should return the same content-free structure
   - Formatted CLI output should continue working as before
   - Other rules commands (`rules.get`, `rules.search`) should not be affected

3. **Preserve Existing Functionality**
   - All filtering options (format, tag, debug) should continue working
   - Command should maintain the same API structure (success/rules response)
   - No breaking changes to the command interface

## Implementation Plan

1. **Update Shared Command Execute Function**
   ```typescript
   // In src/adapters/shared/commands/rules.ts, lines 282-291
   const rules = await ruleService.listRules({
     format,
     tag: params.tag,
     debug: params.debug,
   });

   // Transform to exclude content field
   const rulesWithoutContent = rules.map(({ content, ...rule }) => rule);

   return {
     success: true,
     rules: rulesWithoutContent,
   };
   ```

2. **Verification Steps**
   - Test CLI `minsky rules list --json` returns no content fields
   - Test MCP `rules.list` tool returns no content fields
   - Test CLI formatted output continues working
   - Test filtering options still work correctly
   - Verify `rules.get` still returns content when needed

## Files to Modify

- `src/adapters/shared/commands/rules.ts` (main implementation)

## Tests to Update

- Any tests that expect `content` field in `rules.list` output should be updated
- Add tests to verify content is excluded from the response

## Related

- Task #119 (previous incomplete attempt at this issue)
- MCP rules interface consistency
