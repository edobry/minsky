# Configuration System Test Audit - Task #181

## Purpose
Document all configuration behaviors that must be preserved during the migration from custom configuration system to node-config. This ensures no functionality is lost during the transition.

## Current Test Status Summary

### Passing Tests
- **Configuration Service Tests** (`src/domain/configuration/configuration-service.test.ts`): ✅ All 18 tests passing
  - Repository config validation
  - Global user config validation  
  - SessionDB configuration validation
  - AI configuration validation
  - GitHub configuration validation
  - PostgreSQL configuration validation

### Failing Tests
- **Config Loader Tests** (`src/domain/configuration/config-loader.test.ts`): ❌ 4 of 6 tests failing
  - GitHub token loading: ✅ PASSING
  - AI provider environment variable loading: ❌ FAILING (all 4 tests)
  - Environment variable absence handling: ✅ PASSING

## Critical Behaviors That Must Be Preserved

### 1. Environment Variable Mapping
Current custom system uses automatic mapping:
- `GITHUB_TOKEN` → `github.token`
- `AI_PROVIDERS_OPENAI_API_KEY` → `ai.providers.openai.api_key`
- `AI_PROVIDERS_ANTHROPIC_API_KEY` → `ai.providers.anthropic.api_key`
- `AI_PROVIDERS_GOOGLE_API_KEY` → `ai.providers.google.api_key`
- `AI_PROVIDERS_COHERE_API_KEY` → `ai.providers.cohere.api_key`
- `AI_PROVIDERS_MISTRAL_API_KEY` → `ai.providers.mistral.api_key`

Node-config system uses different mapping:
- `GITHUB_TOKEN` → `github.credentials.token`
- `OPENAI_API_KEY` → `ai.providers.openai.credentials.api_key`
- `ANTHROPIC_API_KEY` → `ai.providers.anthropic.credentials.api_key`
- `GOOGLE_AI_API_KEY` → `ai.providers.google.credentials.api_key`
- `COHERE_API_KEY` → `ai.providers.cohere.credentials.api_key`
- `MISTRAL_API_KEY` → `ai.providers.mistral.credentials.api_key`

### 2. Configuration Hierarchy
Must preserve 5-level hierarchy:
1. Configuration overrides (highest priority)
2. Environment variables
3. Global user config (~/.config/minsky/config.yaml)
4. Repository config (.minsky/config.yaml)
5. Built-in defaults (lowest priority)

### 3. Credential Resolution
- GitHub token from environment
- Multiple AI provider credentials from environment
- Graceful handling when credentials are missing
- No config sections added when no environment variables set

### 4. Configuration Validation
- Repository config validation (18 different scenarios)
- Global user config validation
- Backend configuration validation
- SessionDB configuration validation
- AI configuration validation
- Error handling for invalid configurations

### 5. Component Integration
Components using `configurationService.loadConfiguration()`:
- `src/domain/tasks/taskService.ts`
- `src/domain/storage/monitoring/health-monitor.ts`
- `src/domain/session/session-db-adapter.ts`

Components using `config.get()`:
- `src/utils/logger.ts`
- `src/adapters/shared/commands/config.ts`

## Test Gaps Identified

### Missing Test Coverage
1. **Configuration file precedence**: No tests verify that repository config overrides global config
2. **Working directory handling**: No tests verify config loading from different working directories
3. **Error handling**: Limited tests for configuration loading failures
4. **Backend detection**: No comprehensive tests for backend selection logic
5. **Integration tests**: No tests verify end-to-end configuration flow

### Environment Variable Mapping Discrepancies
1. **AI provider credentials**: Custom system expects `AI_PROVIDERS_*` but node-config expects `*_API_KEY`
2. **GitHub credentials**: Custom system maps to `github.token` but node-config maps to `github.credentials.token`
3. **SessionDB configuration**: Different environment variable names and mapping

## Required Test Actions

### Phase 1: Fix Failing Tests
1. **Immediate**: Fix environment variable mapping discrepancy in config loader tests
2. **Priority**: Align custom system with node-config environment variable expectations
3. **Verify**: All config loader tests pass with current behavior

### Phase 2: Fill Test Gaps
1. **Configuration precedence tests**: Verify file hierarchy works correctly
2. **Working directory tests**: Verify config loading from different paths
3. **Error handling tests**: Verify graceful handling of missing/invalid configs
4. **Integration tests**: Verify components work with both systems

### Phase 3: Migration Validation
1. **Parallel testing**: Run tests with both systems to verify equivalent behavior
2. **Regression testing**: Ensure no functionality is lost during migration
3. **Performance testing**: Verify node-config performs as well as custom system

## Test Files to Create/Modify

### Existing Files to Fix
- `src/domain/configuration/config-loader.test.ts` - Fix failing AI provider tests
- `src/domain/configuration/configuration-service.test.ts` - Add integration scenarios

### New Test Files Needed
- `src/domain/configuration/node-config-migration.test.ts` - Parallel testing of both systems
- `src/domain/configuration/configuration-integration.test.ts` - End-to-end tests
- `src/domain/configuration/environment-mapping.test.ts` - Comprehensive env var tests

## Environment Variable Alignment Strategy

### Option 1: Change node-config mapping to match custom system
```yaml
# config/custom-environment-variables.yaml
github:
  token: "GITHUB_TOKEN"  # Instead of github.credentials.token
ai:
  providers:
    openai:
      api_key: "AI_PROVIDERS_OPENAI_API_KEY"  # Instead of credentials.api_key
```

### Option 2: Change custom system to match node-config
```typescript
// Update loadEnvironmentConfig() to use node-config variable names
const envMappings = {
  'GITHUB_TOKEN': 'github.credentials.token',
  'OPENAI_API_KEY': 'ai.providers.openai.credentials.api_key',
  // etc.
};
```

### Recommendation
Choose Option 1 (change node-config mapping) to minimize disruption to existing deployments that may already use `AI_PROVIDERS_*` environment variables.

## Success Criteria
- [ ] All existing tests pass
- [ ] All identified test gaps are filled
- [ ] Environment variable mapping is consistent
- [ ] Both systems produce identical results for all test scenarios
- [ ] No regression in functionality during migration
- [ ] Performance is maintained or improved

## Next Steps
1. Fix failing config loader tests
2. Create missing test coverage
3. Align environment variable mapping
4. Implement parallel testing for migration validation
5. Begin gradual migration of components 
