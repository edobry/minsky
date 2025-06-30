# Task #213: Make session update default branch configurable

**Status:** TODO
**Type:** Enhancement
**Priority:** Medium

## Description

Make the default branch that session update merges from configurable through config, defaulting to 'main'

## Current Behavior

Session update currently hardcodes 'main' as the default branch to merge from:

```typescript
const branchToMerge = branch || "main";
```

The --branch parameter allows overriding this per-command, but there's no way to configure a different default for the project.

## Requirements

### 1. Configuration Support

- Add 'defaultBranch' configuration option in config files (default.yaml, etc.)
- Support standard config hierarchy (default → environment → local overrides)
- Default value should be 'main' for backward compatibility

### 2. Session Update Integration

- Modify updateSessionFromParams to read defaultBranch from config
- Fallback chain: CLI --branch param → config defaultBranch → hardcoded 'main'
- Update schema and documentation

### 3. Configuration Schema

- Add defaultBranch to configuration validation
- Ensure it accepts valid git branch names
- Consider validation against actual remote branches (optional)

### 4. Testing

- Test configuration reading and fallback behavior
- Test session update with different default branch configs
- Verify CLI parameter still overrides config setting

### 5. Documentation

- Update config documentation with new defaultBranch option
- Add examples for common scenarios (master vs main)
- Document in session update command help

## Implementation Notes

- This addresses repos that use 'master', 'develop', or other default branches
- Should work with existing --branch parameter seamlessly
- Consider adding to session start/clone operations as well

## Acceptance Criteria

- [ ] Config option 'defaultBranch' added with 'main' default
- [ ] Session update respects config defaultBranch when --branch not specified
- [ ] CLI --branch parameter overrides config setting
- [ ] Tests cover config reading and fallback behavior
- [ ] Documentation updated with examples

## Files to Modify

- `src/domain/session.ts` - Update updateSessionFromParams function
- `config/default.yaml` - Add defaultBranch configuration option
- `src/schemas/session.ts` - Update documentation for branch parameter
- `src/types/config.ts` - Add configuration type definitions
- Tests for configuration reading and session update behavior

## Related Issues

- Task #181: Investigate and improve configuration system design
- Task #177: Review and improve session update command design
