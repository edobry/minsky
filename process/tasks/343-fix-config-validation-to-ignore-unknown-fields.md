# Task #343: Fix configuration validation to ignore unknown fields

## Description

Fix overly strict configuration validation that causes the CLI to break when encountering unknown configuration fields. Unknown fields should be ignored rather than causing fatal errors.

## Problem

Currently, when the configuration system encounters an unknown field (like `ai.providers: 'morph'`), it throws a fatal error that completely breaks the CLI:

```
Configuration validation failed: ai.providers: Unrecognized key(s) in object: 'morph'
```

This prevents ANY minsky command from working, including basic commands like `minsky tasks list`.

## Root Cause

The configuration validation is using strict Zod schemas that reject unknown fields instead of allowing them and filtering them out.

## Solution

1. Update configuration schemas to be more permissive
2. Use `.passthrough()` or `.strip()` on Zod schemas to handle unknown fields gracefully
3. Add warning logging for unknown fields instead of failing
4. Ensure backward compatibility for configuration files
5. Add tests for unknown field handling

## Acceptance Criteria

- [ ] CLI works when configuration contains unknown fields
- [ ] Unknown fields are logged as warnings, not errors
- [ ] Known configuration fields still validate correctly
- [ ] Configuration loading is backward compatible
- [ ] Tests cover unknown field scenarios

## Files to Investigate

- `src/domain/configuration/loader.ts` - Configuration loading logic
- `src/domain/configuration/config-schemas.ts` - Zod schemas
- Configuration validation logic

## Priority

High - This is breaking basic CLI functionality

## Impact

- Users can't use the CLI if their config has unknown fields
- Makes the tool fragile to configuration changes
- Poor user experience when experimenting with config
