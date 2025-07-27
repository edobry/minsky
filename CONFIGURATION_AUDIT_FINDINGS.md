# Configuration System Audit Report

## Executive Summary

This audit reveals significant inconsistencies in how configuration is loaded and used across the Minsky codebase. While the system has a well-designed configuration architecture, many components bypass the centralized system and use direct environment variable access or hardcoded paths.

## Critical Issues Identified

### 1. **Inconsistent Path Resolution**

**Problem**: Multiple implementations of the same path logic scattered throughout codebase.

**Examples**:

- `src/domain/session/session-db-io.ts`: `process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state")`
- `src/domain/session/session-adapter.ts`: `(process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state")`
- `src/domain/storage/storage-backend-factory.ts`: `(process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state")`
- `src/utils/paths.ts`: Proper centralized implementation exists but not used everywhere

**Impact**:

- Inconsistent behavior across components
- Maintenance burden when changing path logic
- Potential for typos (e.g., `XDGSTATE_HOME` vs `XDG_STATE_HOME`)

### 2. **Direct Environment Variable Access**

**Problem**: Components directly access `process.env` instead of using configuration system.

**Critical Cases**:

- Session database path resolution
- GitHub token access
- Logging configuration
- Storage backend selection (partially fixed)

**Files with Direct Access**:

- `src/adapters/shared/commands/sessiondb.ts` - Lines 107, 146, 163, 172, 198
- `src/domain/session.ts` - Lines 226, 345
- `src/utils/logger.ts` - Line 27
- Multiple storage backend files

### 3. **Hardcoded Database Filenames**

**Problem**: Database filenames scattered throughout codebase instead of centralized configuration.

**Examples**:

- `session-db.json` appears in 15+ files
- `sessions.db` appears in 10+ files
- Some files use different patterns or typos

### 4. **Mixed Configuration Systems**

**Problem**: Some components use node-config, others use the ConfigurationService, others bypass both.

**Current State**:

- `configurationService = new NodeConfigAdapter()` (singleton)
- Some components properly use `configurationService.loadConfiguration()`
- Others directly import and use `config` from node-config
- Many bypass configuration entirely

### 5. **Inconsistent Backend Detection**

**Problem**: Multiple ways backend is determined across the system.

**Examples**:

- `src/domain/tasks/taskService.ts`: Uses node-config directly
- `src/domain/storage/storage-backend-factory.ts`: Custom logic with node-config fallback
- Session commands: Different backend detection logic

## Specific Violations

### Path Resolution Issues

```typescript
// ❌ INCONSISTENT: Multiple implementations
// File: src/domain/session/session-db-io.ts
const xdgStateHome = process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state");

// File: src/domain/storage/storage-backend-factory.ts
const xdgStateHome =
  (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");

// ✅ CORRECT: Centralized implementation exists
// File: src/utils/paths.ts
export function getXdgStateHome(): string {
  return (
    (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state")
  );
}
```

### Configuration Loading Issues

```typescript
// ❌ INCONSISTENT: Direct node-config usage
// File: src/domain/tasks/taskService.ts
const resolvedBackend = ((config as any).get("backend") as string) || "json-file";

// ✅ CORRECT: Using ConfigurationService
// File: src/domain/ai/config-service.ts
const result = await (this.configService as any).loadConfiguration((process as any).cwd());
```

### Database Path Issues

```typescript
// ❌ HARDCODED: Multiple hardcoded filenames
join(homeDir, ".local/state/minsky/session-db.json");
join(homeDir, ".local/state/minsky/sessions.db");
("session-db.json");
("sessions.db");

// ✅ SHOULD BE: Configuration-driven
const config = await configurationService.loadConfiguration(workingDir);
const dbPath = config.resolved.sessiondb.dbPath;
```

## Recommendations

### Immediate Actions (High Priority)

1. **Centralize Path Resolution**

   - Extend `src/utils/paths.ts` with all path utilities
   - Replace all direct `process.env.HOME/.local/state` access
   - Fix typo: `XDGSTATE_HOME` → `XDG_STATE_HOME`

2. **Standardize Configuration Loading**

   - All components MUST use `configurationService.loadConfiguration()`
   - Remove direct `config.get()` calls outside configuration system
   - Ensure proper working directory is passed

3. **Remove Hardcoded Database Paths**

   - Move all database filenames to configuration
   - Use configuration-driven paths throughout

4. **Fix Session Database Configuration**
   - Ensure all session commands use same configuration loading
   - Verify SQLite backend properly configured everywhere

### Medium Priority

1. **Environment Variable Cleanup**

   - Audit all `process.env` access
   - Channel through configuration system
   - Add proper fallbacks and validation

2. **Configuration Validation**
   - Implement comprehensive config validation
   - Add better error messages for misconfigurations
   - Test configuration loading in different environments

### Long Term

1. **Configuration Schema**

   - Define strict TypeScript interfaces for all config
   - Add runtime validation using JSON Schema or similar
   - Generate documentation from schema

2. **Migration Path**
   - Phase out direct environment variable access
   - Standardize on single configuration approach
   - Create configuration migration utilities

## Files Requiring Updates

### Critical (Must Fix)

1. `src/adapters/shared/commands/sessiondb.ts` - Replace hardcoded paths
2. `src/domain/session/session-db-io.ts` - Use centralized path resolution
3. `src/domain/session/session-adapter.ts` - Use centralized path resolution
4. `src/domain/tasks/taskService.ts` - Use ConfigurationService not direct node-config
5. All files with `.local/state` hardcoded paths (20+ files)

### Important (Should Fix)

1. All storage backend files - Consistent configuration loading
2. `src/utils/logger.ts` - Use configuration for log mode
3. All session-related commands - Consistent backend detection
4. Test files - Use proper configuration mocking

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

## Compliance Checklist

- [ ] All components use `configurationService.loadConfiguration()`
- [ ] No direct `process.env.HOME/.local/state` access
- [ ] No hardcoded `session-db.json` or `sessions.db` paths
- [ ] Consistent XDG_STATE_HOME handling
- [ ] All environment variables channeled through config system
- [ ] Database backend selection consistent across all commands
- [ ] Path resolution centralized in `src/utils/paths.ts`

## Implementation Priority

1. **Phase 1** (Immediate): Fix critical path and configuration loading issues
2. **Phase 2** (This Sprint): Remove hardcoded database paths
3. **Phase 3** (Next Sprint): Environment variable cleanup
4. **Phase 4** (Future): Configuration schema and validation
