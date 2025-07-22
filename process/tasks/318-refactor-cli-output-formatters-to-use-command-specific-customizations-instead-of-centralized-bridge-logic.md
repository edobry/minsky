# Refactor CLI output formatters to use command-specific customizations instead of centralized bridge logic

## Context

## Problem

Currently, command output formatters are centralized in the CLI bridge's `getDefaultFormatter` method (`src/adapters/shared/bridges/cli-bridge.ts` and `cli-command-generator.ts`). This creates several architectural issues:

1. **Violation of Separation of Concerns**: The CLI bridge contains command-specific formatting logic that should be with the commands themselves
2. **Code Duplication**: Same formatting logic exists in multiple bridge files
3. **Poor Maintainability**: Adding new command formatting requires modifying the central bridge files
4. **Inconsistent Architecture**: Some commands have formatters in customizations, others are hardcoded in bridges

## Current State

### Commands with centralized formatters in bridges:
- `session.get` → `formatSessionDetails`
- `session.list` → `formatSessionSummary` 
- `session.pr` → `formatSessionPrDetails`
- `session.approve` → `formatSessionApprovalDetails`
- `rules.list` → `formatRuleSummary`

### Commands with proper customization files:
- Session commands have some formatters in `src/adapters/cli/customizations/session-customizations.ts`

## Goals

1. **Move all formatters to command-specific customizations** where they belong
2. **Remove centralized formatting logic** from CLI bridges
3. **Establish consistent pattern** for all command output formatting
4. **Eliminate code duplication** between bridge files

## Investigation Tasks

1. **Audit current formatter locations**:
   - Map all commands with custom formatters in bridges
   - Identify which commands already have customization files
   - Document the current architecture inconsistencies

2. **Design new architecture**:
   - Define where formatters should live (customizations vs shared)
   - Create pattern for command-specific output formatting
   - Plan migration strategy for existing formatters

3. **Implementation plan**:
   - Move formatters to appropriate customization files
   - Update CLI bridges to use command-specific formatters
   - Remove hardcoded formatting logic from bridges
   - Ensure backwards compatibility

## Expected Outcome

- All command output formatting logic lives with the commands themselves
- CLI bridges are simplified and focus only on bridging concerns
- Consistent architecture pattern across all commands
- Easier maintenance and extension of command formatting

## Files to Investigate

- `src/adapters/shared/bridges/cli-bridge.ts` (lines 520-552)
- `src/adapters/shared/bridges/cli-command-generator.ts` (lines 463-496)
- `src/adapters/cli/customizations/session-customizations.ts`
- `src/adapters/shared/bridges/cli-result-formatters.ts`

## Requirements

## Solution

## Notes
