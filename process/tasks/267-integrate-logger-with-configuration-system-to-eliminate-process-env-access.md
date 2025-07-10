# Integrate logger with configuration system to eliminate process.env access

## Status

BACKLOG

## Priority

MEDIUM

## Description

The logger currently accesses process.env.MINSKY_LOG_MODE directly, which violates the test isolation principle. It should use the configuration system instead to properly support dependency injection and avoid global state interference in tests.

## Background

The current logger implementation in `src/utils/logger.ts` directly accesses several environment variables:
- `process.env.MINSKY_LOG_MODE` (line 23)
- `process.env.LOGLEVEL` (line 7) 
- `process.env.ENABLE_AGENT_LOGS` (line 42)

This creates several issues:
1. **Test isolation violations**: Tests cannot properly mock or isolate logger behavior
2. **Global state interference**: Changes to environment variables affect other parts of the system
3. **Bypasses configuration system**: The logger doesn't use the centralized configuration that supports dependency injection
4. **Inconsistent with architecture**: Other components use the configuration system properly

## Requirements

### 1. Configuration Integration

- [ ] Remove direct `process.env` access from logger.ts
- [ ] Integrate logger with the existing configuration system (`configurationService`)
- [ ] Use the 5-level configuration hierarchy: CLI flags > env vars > global user config > repo config > defaults
- [ ] Support dependency injection for logger configuration

### 2. Configuration Schema Updates

- [ ] Add logger configuration options to the configuration schema
- [ ] Support these configuration options:
  - `logger.mode`: "HUMAN" | "STRUCTURED" | "auto"
  - `logger.level`: "debug" | "info" | "warn" | "error"
  - `logger.enableAgentLogs`: boolean
- [ ] Add environment variable mappings in `config/custom-environment-variables.yaml`

### 3. Logger Service Refactoring

- [ ] Create a configurable logger service that accepts configuration
- [ ] Support both singleton pattern (for backward compatibility) and dependency injection
- [ ] Maintain existing API surface for gradual migration
- [ ] Ensure proper error handling when configuration is unavailable

### 4. Test Isolation

- [ ] Update logger tests to use proper configuration mocking
- [ ] Remove direct process.env manipulation in tests
- [ ] Ensure tests can run in isolation without affecting each other
- [ ] Add tests for configuration-driven behavior

## Success Criteria

### 1. No Direct Environment Access

- [ ] `src/utils/logger.ts` contains no direct `process.env` access
- [ ] All environment variables are accessed through configuration system
- [ ] Configuration system handles environment variable resolution

### 2. Test Isolation Achieved

- [ ] Logger tests can run in parallel without interference
- [ ] Tests can mock logger configuration independently
- [ ] No global state modifications in test files
- [ ] All logger tests pass consistently

### 3. Backward Compatibility

- [ ] Existing code using the logger continues to work unchanged
- [ ] Same environment variables continue to work (through configuration)
- [ ] No breaking changes to the public logger API
- [ ] Migration path is clear for future dependency injection

### 4. Configuration Integration

- [ ] Logger configuration is available through `minsky config show`
- [ ] Logger respects the 5-level configuration hierarchy
- [ ] Configuration validation works for logger settings
- [ ] Environment variables map correctly to configuration options

## Implementation Plan

### Phase 1: Configuration Schema
1. Add logger configuration types to `src/domain/configuration/types.ts`
2. Update `config/default.yaml` with logger defaults
3. Add environment variable mappings to `config/custom-environment-variables.yaml`

### Phase 2: Logger Service
1. Create configurable logger factory function
2. Modify logger.ts to use configuration instead of process.env
3. Maintain backward compatibility with existing API
4. Add proper error handling for configuration failures

### Phase 3: Test Updates
1. Update logger tests to use configuration mocking
2. Remove direct process.env manipulation
3. Add tests for configuration-driven behavior
4. Ensure test isolation works properly

### Phase 4: Integration Testing
1. Test end-to-end configuration flow
2. Verify environment variables work through configuration
3. Test CLI flag overrides
4. Validate test isolation in full test suite

## Files to Modify

- `src/utils/logger.ts` - Main logger implementation
- `src/utils/logger.test.ts` - Logger tests
- `src/domain/configuration/types.ts` - Configuration types
- `config/default.yaml` - Default logger configuration
- `config/custom-environment-variables.yaml` - Environment variable mappings

## Dependencies

- Existing configuration system
- node-config integration
- Test framework (bun:test) 
