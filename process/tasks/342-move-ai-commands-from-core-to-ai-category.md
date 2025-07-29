# Task #342: Move AI commands from CORE to AI category

## Description
Move AI commands from CORE category to dedicated AI category for better UX and discoverability.

## Problem
Currently AI commands are nested under the CORE category, requiring users to use:
```bash
minsky core ai --help          # Unintuitive
minsky core ai models list     # Confusing path
```

Instead of the more natural:
```bash
minsky ai --help               # Expected
minsky ai models list          # Intuitive
```

## Solution
1. Add `AI = "AI"` to the `CommandCategory` enum
2. Update all AI command registrations to use `CommandCategory.AI`
3. Update the Zod schema to include the new AI category
4. Test that commands work correctly at the new path

## Acceptance Criteria
- [ ] `CommandCategory.AI` exists in the enum
- [ ] All AI commands use `CommandCategory.AI`
- [ ] `minsky ai --help` shows AI commands
- [ ] `minsky ai models list` works correctly
- [ ] All AI command hierarchies are preserved
- [ ] No references to CORE category in AI commands remain

## Files to Change
- `src/adapters/shared/command-registry.ts` - Add AI category
- `src/schemas/command-registry.ts` - Update Zod schema
- `src/adapters/shared/commands/ai.ts` - Change category for all commands
