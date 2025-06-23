# feat(#148): Fix CLI Bridge Direct Usage Warnings

## Summary

Fixed the CLI Bridge direct usage warnings that were appearing during CLI initialization. The warnings were triggered because the CLI Command Factory was internally calling the CLI Bridge methods, which were designed to warn about direct usage to encourage proper factory pattern usage.

## Problem

Multiple warning messages were being output during CLI initialization:

```
{"level":"warn","message":"[CLI Bridge] Direct usage of generateAllCategoryCommands detected. Consider using CLI Command Factory for proper customization support.","timestamp":"2025-06-19T01:21:14.141Z"}
{"level":"warn","message":"[CLI Bridge] Direct usage detected for category 'GIT'. Consider using CLI Command Factory for proper customization support.","timestamp":"2025-06-19T01:21:14.142Z"}
{"level":"warn","message":"[CLI Bridge] Direct usage detected for command 'git.commit'. Consider using CLI Command Factory for proper customization support.","timestamp":"2025-06-19T01:21:14.142Z"}
// ... many more similar warnings
```

These warnings were being triggered even when using the recommended CLI Command Factory pattern.

## Solution

Added an optional `context` parameter to CLI Bridge methods to distinguish between direct usage and proper factory usage:

### Changes

#### CLI Bridge (`src/adapters/shared/bridges/cli-bridge.ts`)
- **Modified method signatures** to accept optional `context?: { viaFactory?: boolean }` parameter:
  - `generateCommand(commandId, context?)`
  - `generateCategoryCommand(category, context?)`
  - `generateAllCategoryCommands(program, context?)`
- **Updated warning logic** to suppress warnings when `context?.viaFactory` is true
- **Updated internal method calls** to propagate the context parameter

#### CLI Command Factory (`src/adapters/cli/cli-command-factory.ts`)
- **Modified factory methods** to pass `{ viaFactory: true }` context:
  - `createCommand()` → `cliBridge.generateCommand(commandId, { viaFactory: true })`
  - `createCategoryCommand()` → `cliBridge.generateCategoryCommand(category, { viaFactory: true })`
  - `registerAllCommands()` → `cliBridge.generateAllCategoryCommands(program, { viaFactory: true })`

## Testing

Created and ran a test script to verify:
- ✅ CLI initialization in development mode produces no warnings
- ✅ All commands still function properly
- ✅ Factory pattern continues to work as expected

## Impact

- **Eliminates noisy warning logs** during normal CLI usage
- **Preserves warning functionality** for actual direct usage cases
- **Maintains architectural integrity** by encouraging proper factory usage
- **No functional changes** to CLI behavior or capabilities

## Checklist

- [x] All requirements implemented
- [x] Changes tested successfully
- [x] No regression in CLI functionality
- [x] Warning logs eliminated when using factory pattern
- [x] Warnings still appear for true direct usage
- [x] Code committed and pushed
- [x] Documentation updated (inline comments)

## Files Modified

- `src/adapters/shared/bridges/cli-bridge.ts` - Added context parameter and updated warning logic
- `src/adapters/cli/cli-command-factory.ts` - Updated to pass factory context
- Minor test files (automatically generated, will be cleaned up) 
