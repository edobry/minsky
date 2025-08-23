# Move AI Commands from Core to AI Category

## Context

The ai.fast-apply command was incorrectly registered under CommandCategory.CORE instead of CommandCategory.AI, causing it to be misplaced in the command hierarchy.

## Problem

- Command was accessible under wrong category
- Should be 'minsky ai fast-apply' not under CORE category
- Issue introduced in task #249

## Requirements

1. **Fix ai.fast-apply command registration** to use CommandCategory.AI
2. **Ensure command is accessible** via 'minsky ai fast-apply'
3. **Verify categorization** is correct for AI-related commands

## Solution

- Update src/adapters/shared/commands/ai.ts to use CommandCategory.AI instead of CommandCategory.CORE
- Test that command is properly accessible under AI category

## Success Criteria

- [ ] ai.fast-apply command uses CommandCategory.AI
- [ ] Command accessible via 'minsky ai fast-apply'
- [ ] No longer misplaced under CORE category

## Impact

Improves command discoverability and logical organization for users.

## Status

DONE - Fixed in commit 6844f010a
