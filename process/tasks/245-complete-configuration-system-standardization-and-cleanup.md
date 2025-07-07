# Complete configuration system standardization and cleanup

## Status

TODO

## Priority

HIGH

## Description

Address remaining inconsistencies identified in the configuration audit report. This task implements a comprehensive fix for configuration system inconsistencies across the Minsky codebase, including path resolution, environment variable handling, and backend detection standardization.

## Background

The configuration audit revealed significant inconsistencies in how configuration is loaded and used across the codebase. While the system has a well-designed configuration architecture, many components bypass the centralized system and use direct environment variable access or hardcoded paths.

## Requirements

### Phase 1: Critical Storage and Session Fixes

1. **Centralize Path Resolution**
   - Extend `src/utils/paths.ts` with all path utilities
   - Replace all direct `process.env.HOME/.local/state` access  
   - Fix typo: `XDGSTATE_HOME` → `XDG_STATE_HOME`
   - Update these critical files:
     - `src/adapters/shared/commands/sessiondb.ts`
     - `src/domain/session/session-db-io.ts`
     - `src/domain/session/session-adapter.ts`

2. **Standardize Configuration Loading**
   - All components MUST use `configurationService.loadConfiguration()`
   - Remove direct `config.get()` calls outside configuration system
   - Fix `src/domain/tasks/taskService.ts` to use ConfigurationService not direct node-config
   - Ensure proper working directory is passed

3. **Remove Hardcoded Database Paths**
   - Move all database filenames to configuration
   - Replace hardcoded `session-db.json` and `sessions.db` references
   - Use configuration-driven paths throughout

### Phase 2: Environment Variable Cleanup

1. **Audit All Process.env Access**
   - Replace direct `process.env` access in session-related files
   - Channel environment variables through configuration system
   - Add proper fallbacks and validation

2. **Consistent Backend Detection**
   - Standardize backend selection across all storage components
   - Ensure session database backend consistency
   - Test environment variable overrides

### Phase 3: Configuration Schema and Validation

1. **Configuration Validation**
   - Implement comprehensive config validation
   - Add better error messages for misconfigurations
   - Test configuration loading in different environments

2. **Long-term Schema Definition**
   - Define strict TypeScript interfaces for all config
   - Add runtime validation using JSON Schema
   - Generate documentation from schema

## Success Criteria

### Phase 1 Completion Criteria
- [ ] All components use `configurationService.loadConfiguration()`
- [ ] No direct `process.env.HOME/.local/state` access in critical files
- [ ] No hardcoded `session-db.json` or `sessions.db` paths
- [ ] Consistent XDG_STATE_HOME handling (typo fixed)
- [ ] `src/domain/tasks/taskService.ts` uses ConfigurationService
- [ ] All tests pass after changes

### Phase 2 Completion Criteria
- [ ] All environment variables channeled through config system
- [ ] Database backend selection consistent across all commands
- [ ] Session commands use unified configuration loading
- [ ] No direct `process.env` access except in utils/configuration layers

### Phase 3 Completion Criteria
- [ ] Configuration schema defined and validated
- [ ] Runtime configuration validation implemented
- [ ] Comprehensive error messages for misconfigurations
- [ ] Documentation generated from schema

## Testing Requirements

1. **Configuration Integration Tests**
   - Test all configuration sources work together
   - Verify precedence order (CLI > env > user > repo > defaults)
   - Test with missing configuration files

2. **Path Resolution Tests**
   - Test XDG_STATE_HOME variations
   - Test HOME directory edge cases
   - Verify consistent behavior across OS

3. **Backend Selection Tests**
   - Test all configuration paths for backend selection
   - Verify session database backend consistency
   - Test environment variable overrides

## Implementation Notes

- Focus on Phase 1 first - critical storage and session fixes
- Each phase should be completed and tested before moving to next
- Use absolute paths throughout session workspace
- Maintain backward compatibility where possible
- Document any breaking changes

## Files to Update (Priority Order)

### Critical (Phase 1)
1. `src/utils/paths.ts` - Extend with centralized path utilities
2. `src/adapters/shared/commands/sessiondb.ts` - Replace hardcoded paths
3. `src/domain/session/session-db-io.ts` - Use centralized path resolution
4. `src/domain/session/session-adapter.ts` - Use centralized path resolution
5. `src/domain/tasks/taskService.ts` - Use ConfigurationService not direct node-config

### Important (Phase 2)
6. All storage backend files - Consistent configuration loading
7. `src/utils/logger.ts` - Use configuration for log mode
8. All session-related commands - Consistent backend detection
9. Test files - Use proper configuration mocking

### Future (Phase 3)
10. Configuration schema definition
11. Runtime validation implementation
12. Documentation generation

## References

- See `CONFIGURATION_AUDIT_FINDINGS.md` for detailed analysis
- Configuration architecture documentation
- Session-first workflow requirements
