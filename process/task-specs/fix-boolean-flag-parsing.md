# Fix Boolean Flag Parsing Issue

## Problem

The `--no-update` flag for `session pr` command is not working correctly. When specified, the flag remains `undefined` instead of being set to `true`.

## Root Cause Analysis

Investigation revealed a structural problem with boolean flag handling in the CLI system:

1. **Multiple Registration Points**: Boolean flags must be registered in multiple places:

   - Schema layer (`src/schemas/session.ts`)
   - Shared command layer (`src/adapters/shared/commands/session.ts`)
   - CLI factory layer (`src/adapters/cli/cli-command-factory.ts`)

2. **CLI Factory Disconnect**: The CLI factory customizations are not being properly applied to shared command registry commands. The `session.pr` command is missing from CLI factory customizations.

3. **Parameter Normalization Issue**: The `normalizeCliParameters` function skips optional parameters that are `undefined`, but boolean flags should be handled differently.

## Broader Structural Problem

This reveals a fundamental architectural issue: **Why do we need to register flags in multiple places?** This violates DRY principles and creates maintenance burden.

## Solution Approach

1. **Immediate Fix**: Add missing `session.pr` customization to CLI factory
2. **Structural Fix**: Implement centralized boolean flag handling or context injection for parameter detection
3. **Architecture Review**: Consider consolidating the multiple CLI layers

## Impact

This affects all boolean flags across the CLI system, not just `--no-update`.

## Acceptance Criteria

- [ ] `--no-update` flag works correctly for `session pr` command
- [ ] Boolean flags are handled consistently across all CLI commands
- [ ] Reduce duplication in flag registration
- [ ] Document the proper way to add new boolean flags
