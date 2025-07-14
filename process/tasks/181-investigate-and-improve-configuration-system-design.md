# Task #181: Complete Configuration System Migration to Node-Config

## Status

IN-PROGRESS

## Priority

HIGH

## Context

**UPDATED CONTEXT**: Investigation revealed that Task #209 started but did not complete the migration from our custom configuration system to node-config. The commit claimed "90% reduction in configuration-related code" but actually:

1. **Kept all custom configuration code** (2,500+ lines still exist)
2. **Added node-config usage** on top of existing system
3. **Disabled failing tests** instead of fixing them
4. **Created a hybrid system** that's more complex than before

We now have **two parallel configuration systems** running simultaneously:
- **Custom system**: `ConfigurationLoader`, `ConfigurationService`, custom environment variable mapping
- **Node-config system**: Direct `config.get()` calls, `custom-environment-variables.yaml`

## Problem Statement

The current configuration system has these critical issues:

1. **Incomplete Migration**: Task #209 was marked "DONE" but only partially completed the node-config migration
2. **Parallel Systems**: We're running both custom and node-config systems simultaneously
3. **Duplicated Environment Variable Handling**: Custom `loadEnvironmentConfig()` + node-config's `custom-environment-variables.yaml`
4. **Disabled Tests**: Critical tests were disabled instead of being properly migrated
5. **Over-Engineering**: 2,500+ lines of custom code that duplicates node-config functionality
6. **Inconsistent Usage**: Some components use `configurationService.loadConfiguration()`, others use `config.get()`

## Current Architecture Problems

### **Hybrid System Complexity**
```typescript
// Some components use custom system
import { configurationService } from "../configuration";
const result = await configurationService.loadConfiguration(workingDir);
const backend = result.resolved.backend;

// Others use node-config directly
import config from "config";
const backend = config.get("backend");
```

### **Duplicated Environment Variable Mapping**
```typescript
// Custom system (src/domain/configuration/config-loader.ts)
if (process.env[ENV_VARS.GITHUB_TOKEN]) {
  config.github = {
    credentials: { token: process.env[ENV_VARS.GITHUB_TOKEN] }
  };
}

// Node-config system (config/custom-environment-variables.yaml)
github:
  credentials:
    token: "GITHUB_TOKEN"
```

### **Maintained Custom Code That Should Be Deleted**
- `src/domain/configuration/config-loader.ts` (11,086 bytes)
- `src/domain/configuration/configuration-service.ts` (21,692 bytes)
- `src/domain/configuration/credential-manager.ts` (5,539 bytes)
- `src/domain/configuration/backend-detector.ts` (2,085 bytes)
- Plus all related test files and utilities

## Requirements

### **Phase 1: Test Suite Evaluation and Preservation (CRITICAL)**

**BEFORE ANY REFACTORING**, we must ensure all desired configuration behavior is captured in tests:

- [ ] **Audit existing test coverage** for configuration system
- [ ] **Document all configuration behaviors** that must be preserved
- [ ] **Identify test gaps** in current coverage
- [ ] **Create comprehensive test suite** covering all configuration scenarios
- [ ] **Ensure tests pass** with current hybrid system before migration
- [ ] **Re-enable disabled tests** from task #209 and fix them properly

**Key Test Areas to Verify:**
- [ ] Environment variable precedence and mapping
- [ ] Configuration file loading (repository, global user, defaults)
- [ ] Credential resolution (GitHub, AI providers)
- [ ] Backend detection and selection
- [ ] Error handling for missing/invalid configuration
- [ ] Working directory handling for different contexts
- [ ] Session database configuration
- [ ] AI provider configuration

### **Phase 2: Complete Node-Config Migration**

- [ ] **Replace all `configurationService.loadConfiguration()` calls** with `config.get()`
- [ ] **Remove custom environment variable mapping** (`loadEnvironmentConfig()` method)
- [ ] **Use node-config's `custom-environment-variables.yaml`** exclusively
- [ ] **Update all components** to use consistent node-config API
- [ ] **Ensure AI config service** uses same logic as general config system

### **Phase 3: Delete Custom Configuration System**

- [ ] **Delete custom configuration files** (2,400+ lines as originally planned):
  - `src/domain/configuration/config-loader.ts`
  - `src/domain/configuration/configuration-service.ts`
  - `src/domain/configuration/credential-manager.ts`
  - `src/domain/configuration/backend-detector.ts`
  - Related test files and utilities

- [ ] **Keep only essential files**:
  - `src/domain/configuration/types.ts` (TypeScript interfaces)
  - `src/domain/configuration/node-config-adapter.ts` (if needed for compatibility)
  - `src/domain/configuration/index.ts` (minimal exports)

### **Phase 4: Simplify Configuration Schema**

- [ ] **Remove unnecessary `source` field** from AI credentials configuration
- [ ] **Use automatic environment variable mapping** from config paths
- [ ] **Flatten credential structure** (remove unnecessary nesting)
- [ ] **Use generated environment variable names** (e.g., `AI_PROVIDERS_OPENAI_API_KEY`)

### **Phase 5: Validation and Documentation**

- [ ] **All tests pass** with simplified node-config system
- [ ] **No custom configuration code** remains
- [ ] **Environment variables work** via node-config mapping
- [ ] **Documentation updated** to reflect simplified system
- [ ] **Migration guide** for users with existing configurations

## Implementation Strategy

### **Step 1: Test Suite Audit (MANDATORY FIRST STEP)**

```bash
# Find all configuration-related tests
find src -name "*.test.ts" -exec grep -l "configuration\|config" {} \;

# Check disabled tests from task #209
find src -name "*.test.ts.disabled" -exec grep -l "configuration\|config" {} \;

# Document current test coverage
bun test --coverage src/domain/configuration/
```

**Deliverables:**
- [ ] **Test coverage report** showing current configuration test status
- [ ] **Behavior documentation** listing all configuration features that must work
- [ ] **Test gap analysis** identifying missing test scenarios
- [ ] **Re-enabled test plan** for previously disabled tests

### **Step 2: Environment Variable Mapping Analysis**

Compare current systems:
```typescript
// Document what custom system does
// Document what node-config system does
// Identify gaps and overlaps
// Plan unified approach
```

### **Step 3: Gradual Migration**

1. **Fix one component at a time**
2. **Test each change** before moving to next
3. **Maintain backward compatibility** during transition
4. **Delete custom code** only after all usages migrated

### **Step 4: Automatic Environment Variable Generation**

Instead of hardcoded mappings, use computed names:
```yaml
# config/custom-environment-variables.yaml
github:
  token: "GITHUB_TOKEN"  # github.token -> GITHUB_TOKEN
ai:
  providers:
    openai:
      api_key: "AI_PROVIDERS_OPENAI_API_KEY"  # ai.providers.openai.api_key -> AI_PROVIDERS_OPENAI_API_KEY
```

## Success Criteria

### **Functional Requirements**
- [ ] **Single configuration system**: Only node-config, no custom code
- [ ] **Environment variables work**: Via node-config's `custom-environment-variables.yaml`
- [ ] **All tests pass**: Including previously disabled tests
- [ ] **No regression**: All existing functionality preserved
- [ ] **Simplified schema**: No unnecessary `source` fields or nesting

### **Code Quality**
- [ ] **90% code reduction**: 2,400+ lines of custom configuration code deleted
- [ ] **Consistent API**: All components use `config.get()`
- [ ] **No duplication**: Single source of truth for configuration
- [ ] **Standard patterns**: Follows node-config conventions

### **User Experience**
- [ ] **Simpler configuration**: Environment variables work automatically
- [ ] **Better error messages**: Clear guidance when configuration is missing
- [ ] **Standard conventions**: Familiar to Node.js developers

## Risk Mitigation

### **Test-First Approach**
- **NEVER delete custom code** until all tests pass with node-config
- **Document all behaviors** before changing implementation
- **Gradual migration** with validation at each step

### **Rollback Plan**
- **Git branch** for each migration phase
- **Ability to revert** to hybrid system if needed
- **Comprehensive testing** before declaring complete

## References

- **Task #209**: Incomplete migration that created current hybrid system
- **Commit 5972bc1a**: Shows what was actually done vs. claimed
- **Node-config documentation**: https://github.com/node-config/node-config
- **Current hybrid system**: Mix of custom + node-config code

## Timeline

**Estimated effort**: 2-3 days
- **Day 1**: Test suite evaluation and documentation
- **Day 2**: Migration implementation and testing
- **Day 3**: Custom code deletion and validation

**Critical path**: Test suite evaluation MUST be completed before any refactoring begins.
