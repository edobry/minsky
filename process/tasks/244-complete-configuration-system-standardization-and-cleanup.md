# Task #244: Complete Configuration System Standardization and Cleanup

## Overview

Address all remaining inconsistencies identified in the comprehensive configuration system audit. This task builds on the critical fixes already implemented and ensures complete standardization across the entire Minsky codebase.

**Context**: Following the session data integrity issue resolution, a comprehensive audit revealed significant configuration inconsistencies across 20+ files. Core issues have been fixed, but systematic cleanup is needed.

**Audit Report**: See `CONFIGURATION_AUDIT_FINDINGS.md` for complete analysis.

## Requirements

### Phase 1: Critical Path and Storage Backend Fixes (High Priority)

#### 1.1 Fix Remaining Storage Backend Files

- [ ] `src/domain/storage/backends/sqlite-storage.ts` - Replace hardcoded paths with `getMinskyStateDir()`
- [ ] `src/domain/storage/backends/postgres-storage.ts` - Use centralized configuration loading
- [ ] `src/domain/storage/enhanced-storage-backend-factory.ts` - Fix multiple `.local/state` references
- [ ] `src/domain/storage/backends/error-handling.ts` - Remove hardcoded `~/.local/state/minsky` paths

#### 1.2 Fix Session-Related Components

- [ ] `src/domain/session.ts` - Replace `process.env.PWD || process.cwd()` and XDG_STATE_HOME logic
- [ ] `src/domain/session/session-adapter.ts` - Fix linting errors and use centralized paths properly
- [ ] `src/domain/session/session-db-io.ts` - Fix linting errors with `writeSessionsToFile` function

#### 1.3 Fix Repository Components

- [ ] `src/domain/repository/local.ts` - Replace hardcoded XDG_STATE_HOME logic
- [ ] `src/domain/repository/remote.ts` - Replace hardcoded XDG_STATE_HOME logic
- [ ] `src/domain/repository/github.ts` - Replace hardcoded XDG_STATE_HOME logic

### Phase 2: Environment Variable Cleanup (Medium Priority)

#### 2.1 Logger Configuration

- [ ] `src/utils/logger.ts` - Replace direct `process.env.MINSKY_LOG_MODE` access with configuration system
- [ ] Add logger configuration to config schema and node-config files

#### 2.2 Eliminate Direct Environment Access

- [ ] `src/adapters/shared/error-handling.ts` - Replace `process.env.NODE_DEBUG` with configuration
- [ ] `src/adapters/cli/utils/error-handler.ts` - Replace `process.env.NODE_DEBUG` with configuration
- [ ] All test files - Replace hardcoded `process.env.HOME` with test utilities

#### 2.3 Fix Typos and Inconsistencies

- [ ] Fix `XDGSTATE_HOME` typo in `src/domain/workspace.test.ts` (should be `XDG_STATE_HOME`)
- [ ] Standardize all XDG environment variable access patterns

### Phase 3: Configuration Schema and Validation (Future)

#### 3.1 Schema Definition

- [ ] Create comprehensive TypeScript interfaces for all configuration sections
- [ ] Add runtime validation using JSON Schema or Zod
- [ ] Generate configuration documentation from schema

#### 3.2 Configuration Migration Tools

- [ ] Create configuration file migration utilities
- [ ] Add configuration validation CLI commands
- [ ] Implement configuration upgrade/downgrade support

## Implementation Guidelines

### Configuration Loading Standards

```typescript
// ✅ CORRECT: Use ConfigurationService
const config = await configurationService.loadConfiguration(workingDir);
const value = config.resolved.section.property;

// ❌ WRONG: Direct node-config access
const value = config.get("section.property");

// ❌ WRONG: Direct environment access
const value = process.env.SOME_VAR;
```

### Path Resolution Standards

```typescript
// ✅ CORRECT: Use centralized utilities
import { getMinskyStateDir, getDefaultSqliteDbPath } from "../../utils/paths";
const dbPath = getDefaultSqliteDbPath();

// ❌ WRONG: Hardcoded paths
const dbPath = join(process.env.HOME || "", ".local/state/minsky/sessions.db");
```

### Environment Variable Standards

```typescript
// ✅ CORRECT: Via configuration system
const config = await configurationService.loadConfiguration(workingDir);
const debugMode = config.resolved.debug?.enabled || false;

// ❌ WRONG: Direct access
const debugMode = process.env.NODE_DEBUG?.includes("minsky");
```

## Files Requiring Updates

### Critical Priority

1. `src/domain/storage/backends/sqlite-storage.ts`
2. `src/domain/storage/enhanced-storage-backend-factory.ts`
3. `src/domain/session.ts`
4. `src/domain/repository/*.ts` (3 files)
5. `src/utils/logger.ts`

### Important Priority

1. `src/adapters/shared/error-handling.ts`
2. `src/adapters/cli/utils/error-handler.ts`
3. `src/domain/workspace.test.ts`
4. All test files with hardcoded paths (15+ files)

## Testing Requirements

### Configuration Integration Tests

- [ ] Test all configuration sources work together properly
- [ ] Verify precedence order: CLI > env > user > repo > defaults
- [ ] Test behavior with missing configuration files
- [ ] Test environment variable override functionality

### Path Resolution Tests

- [ ] Test XDG_STATE_HOME variations across different OS
- [ ] Test HOME directory edge cases and missing values
- [ ] Verify consistent behavior across all path utilities
- [ ] Test path expansion for `~` and environment variables

### Backend Selection Tests

- [ ] Test configuration-driven backend selection
- [ ] Verify session database backend consistency
- [ ] Test graceful fallbacks when configuration fails
- [ ] Test all environment variable overrides work correctly

## Success Criteria

### Compliance Checklist

- [ ] All components use `configurationService.loadConfiguration()`
- [ ] No direct `process.env.HOME/.local/state` access anywhere
- [ ] No hardcoded `session-db.json` or `sessions.db` paths
- [ ] Consistent XDG_STATE_HOME handling across all files
- [ ] All environment variables channeled through config system
- [ ] Database backend selection consistent across all commands
- [ ] Path resolution centralized in `src/utils/paths.ts`

### Quality Gates

- [ ] All linting errors resolved
- [ ] All existing tests pass
- [ ] New configuration tests added and passing
- [ ] Configuration loading performance not degraded
- [ ] Backward compatibility maintained for existing installations

## Implementation Phases

### Phase 1 (Immediate - This Sprint)

Focus on storage backends and session components that have direct impact on functionality.

### Phase 2 (Next Sprint)

Environment variable cleanup and test standardization.

### Phase 3 (Future Sprint)

Configuration schema, validation, and migration tools.

## Notes

- **Critical Context**: This work directly relates to the session data integrity issue resolution
- **Dependencies**: Builds on configuration fixes already implemented in storage-backend-factory.ts
- **Risk Mitigation**: Each change should be tested independently to avoid regression
- **Performance**: Configuration loading should remain fast and not add startup overhead

## Related Work

- Session data integrity issue resolution (completed)
- Storage backend factory node-config integration (completed)
- Centralized path utilities implementation (completed)
- TaskService configuration standardization (completed)
