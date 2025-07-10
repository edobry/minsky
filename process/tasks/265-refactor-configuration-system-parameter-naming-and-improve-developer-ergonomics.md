# Task #265: Refactor Configuration System Parameter Naming and Improve Developer Ergonomics

## Problem Statement

The `ConfigurationLoader.loadConfiguration()` method has a misleading parameter name `cliFlags` that does not accurately reflect its actual purpose or usage:

### Current Issues:
1. **Misleading Name**: Parameter is called `cliFlags` but is never used for actual CLI flag parsing
2. **Conceptual Confusion**: Name suggests CLI-specific functionality when it's actually a generic configuration override mechanism
3. **Poor Developer Ergonomics**: Developers must understand that "cliFlags" actually means "high-priority config overrides"
4. **Test Confusion**: Test code uses `cliFlags` to inject test configuration, which is conceptually incorrect

### Evidence:
- **No CLI Usage**: Zero instances found of CLI commands parsing flags and passing them to this parameter
- **Primary Usage**: Used almost exclusively in tests for dependency injection
- **Production Usage**: All production code calls `loadConfiguration(workingDir)` without the second parameter

## Proposed Solution

### 1. Rename Parameter
Rename `cliFlags` to a more accurate name that reflects its actual purpose:

**Options:**
- `configOverrides` (recommended)
- `highPriorityConfig`
- `injectedConfig`
- `runtimeConfig`

### 2. Update Method Signature
```typescript
// Current (misleading)
async loadConfiguration(
  workingDir: string,
  cliFlags: Partial<ResolvedConfig> = {}
): Promise<ConfigurationLoadResult>

// Proposed (accurate)
async loadConfiguration(
  workingDir: string,
  configOverrides: Partial<ResolvedConfig> = {}
): Promise<ConfigurationLoadResult>
```

### 3. Review Configuration System API Design
Evaluate the overall configuration system for developer ergonomics:

#### Consider Adding:
- **Dedicated test configuration helper**: `createTestConfiguration(overrides)`
- **Builder pattern**: `ConfigurationBuilder.withOverrides(config).build()`
- **Separate methods**: `loadConfigurationWithOverrides(workingDir, overrides)`

#### Documentation Improvements:
- Clear JSDoc explaining the parameter's purpose
- Examples showing proper usage for testing
- Clarification of precedence hierarchy

## Implementation Plan

### Phase 1: Parameter Rename
1. **Update ConfigurationLoader**:
   - Rename `cliFlags` parameter to `configOverrides`
   - Update JSDoc documentation
   - Update internal variable names

2. **Update All Callers**:
   - Update test files using the parameter
   - Update any production code (if found)
   - Update type definitions

3. **Update Documentation**:
   - Update JSDoc with clear explanation
   - Add examples for test usage
   - Document precedence hierarchy

### Phase 2: API Design Review
1. **Evaluate Current API**:
   - Review all configuration loading patterns
   - Identify pain points in test setup
   - Assess developer ergonomics

2. **Design Improvements**:
   - Consider helper methods for common use cases
   - Evaluate builder pattern benefits
   - Design test-specific utilities

3. **Implement Improvements**:
   - Add helper methods if beneficial
   - Create test utilities
   - Update documentation

### Phase 3: Migration and Testing
1. **Comprehensive Testing**:
   - Verify all existing tests still pass
   - Add tests for new functionality
   - Test configuration loading in various scenarios

2. **Documentation Update**:
   - Update configuration guide
   - Add examples for new patterns
   - Document migration path

## Success Criteria

1. **Parameter Renamed**: `cliFlags` parameter renamed to `configOverrides` across codebase
2. **No Breaking Changes**: All existing functionality continues to work
3. **Improved Clarity**: Parameter name accurately reflects its purpose
4. **Better Documentation**: Clear JSDoc and examples for proper usage
5. **Enhanced Ergonomics**: Improved developer experience for configuration testing

## Files to Modify

### Core Files:
- `src/domain/configuration/config-loader.ts`
- `src/domain/configuration/types.ts`
- `src/domain/configuration/configuration-service.ts`

### Test Files:
- `src/domain/configuration/__tests__/sessiondb-config.test.ts`
- Any other test files using the parameter

### Documentation:
- Configuration system documentation
- API documentation
- Test setup guides

## Risk Assessment

**Low Risk**: This is primarily a naming change with no functional impact. The parameter's behavior remains identical.

**Mitigation**:
- Comprehensive testing to ensure no regressions
- Clear documentation of the change
- Gradual rollout if needed

## Dependencies

- No external dependencies
- Should be compatible with all existing code
- May want to coordinate with any ongoing configuration system work

## Complexity Assessment

**Small to Medium**: This is primarily a naming change with API design review. The parameter's behavior remains identical, minimizing functional risk.

## Notes

This task emerged from investigating test isolation issues in Task #244, where the misleading parameter name caused confusion about the configuration system's design and purpose.

### Configuration System Test Isolation Issue

During Task #244, we discovered that tests were incorrectly using `process.env` pollution instead of the configuration system's built-in dependency injection capabilities:

**Problem Pattern**:
```typescript
// ❌ WRONG: Tests were doing this (causes global state interference)
process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
process.env.MINSKY_SESSIONDB_SQLITE_PATH = "/custom/path/sessions.db";
const config = await loader.loadConfiguration(testDir);
```

**Correct Pattern**:
```typescript
// ✅ CORRECT: Tests should do this (proper dependency injection)
const testConfig: Partial<ResolvedConfig> = {
  sessiondb: {
    backend: "sqlite",
    dbPath: "/custom/path/sessions.db",
  } as SessionDbConfig,
};
const config = await loader.loadConfiguration(testDir, testConfig);
```

The misleading `cliFlags` parameter name contributed to developers not understanding that this was the proper way to inject test configuration. The rename will improve code clarity and reduce developer confusion when working with configuration injection in tests.

### Impact on Test Isolation

The proper use of the configuration override parameter (currently `cliFlags`) is critical for test isolation because:
- It avoids `process.env` pollution that affects other tests
- It provides explicit, scoped configuration injection
- It follows the configuration system's designed precedence hierarchy
- It eliminates global state interference between test processes
