# SessionDB Configuration Deprecation Timeline

This document outlines the planned timeline for deprecating and removing the legacy `sessiondb:` configuration in favor of the modern `persistence:` configuration.

## Overview

The `sessiondb:` configuration block is being deprecated in favor of the new unified `persistence:` configuration. This change provides better consistency, clearer naming, and expanded functionality for future persistence backends.

## Migration Path

Users can migrate their configuration using the built-in migration utility:

```bash
# Preview migration changes
minsky config migrate --dry-run

# Perform migration with backup
minsky config migrate

# Validate the migrated configuration
minsky config migrate --validate
```

## Deprecation Timeline

### Phase 1: Soft Deprecation (Current)

**Status**: ✅ **COMPLETED**
**Duration**: Current release

**Changes**:

- ✅ Modern `persistence:` configuration is fully implemented and functional
- ✅ Legacy `sessiondb:` configuration remains fully supported with backward compatibility
- ✅ Deprecation warnings are displayed when `sessiondb:` configuration is detected
- ✅ Migration utility (`minsky config migrate`) is available
- ✅ Documentation is updated to use `persistence:` configuration examples
- ✅ New installations default to `persistence:` configuration

**User Impact**:

- Existing configurations continue to work unchanged
- Users see deprecation warnings with migration instructions
- All new documentation uses `persistence:` configuration

**Recommended Actions**:

- Migrate existing configurations using `minsky config migrate`
- Update any infrastructure-as-code or deployment scripts to use `persistence:` configuration
- Review team documentation and update configuration examples

### Phase 2: Hard Deprecation (Next Major Release)

**Status**: 📅 **PLANNED**
**Target**: Next major version (2.0.0 or similar)

**Changes**:

- `sessiondb:` configuration will generate error messages instead of warnings
- Applications using `sessiondb:` configuration will fail to start
- Migration utility remains available for final migrations
- Legacy configuration schema remains in codebase for migration purposes only

**User Impact**:

- Applications with `sessiondb:` configuration will not start
- Clear error messages will direct users to migration instructions
- Migration utility will still work to convert existing configurations

**Required Actions**:

- **ALL configurations must be migrated before this release**
- Update CI/CD pipelines to use `persistence:` configuration
- Ensure all team members are using updated configurations

### Phase 3: Complete Removal (Future Release)

**Status**: 🔮 **PLANNED FOR FUTURE**
**Target**: 6 months after Phase 2 release

**Changes**:

- Complete removal of `sessiondb:` configuration support
- Removal of legacy configuration schemas
- Removal of migration utility
- Code cleanup and simplification

**User Impact**:

- `sessiondb:` configuration will be completely unrecognized
- Migration utility will no longer be available
- Applications will fail with clear error messages

**Required Actions**:

- Ensure migration is completed before Phase 2
- No action required if already migrated

## Configuration Mapping

### Legacy sessiondb Configuration

```yaml
sessiondb:
  backend: postgres
  connectionString: "postgresql://user:pass@host/db"
  postgres:
    connectionString: "postgresql://user:pass@host/db"
  sqlite:
    path: "/path/to/sessions.db"
    baseDir: "/base/directory"
```

### Modern persistence Configuration

```yaml
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://user:pass@host/db"
    maxConnections: 10
    connectTimeout: 30000
    idleTimeout: 10000
    prepareStatements: true
  sqlite:
    dbPath: "/path/to/sessions.db"
```

### Key Differences

- **Clearer naming**: `persistence` vs `sessiondb`
- **Better structure**: Backend-specific configurations are properly nested
- **Enhanced configuration**: Additional tuning parameters for PostgreSQL
- **Consistent schema**: Aligns with other configuration sections
- **Future-proof**: Designed to support additional backends (Redis, etc.)

## Environment Variables

### Legacy Environment Variables (Deprecated)

```bash
MINSKY_SESSIONDB_BACKEND=postgres
MINSKY_SESSIONDB_POSTGRES_URL="postgresql://..."
MINSKY_SESSIONDB_SQLITE_PATH="/path/to/db"
```

### Modern Environment Variables

```bash
MINSKY_PERSISTENCE_BACKEND=postgres
MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://..."
MINSKY_PERSISTENCE_SQLITE_DBPATH="/path/to/db"
```

**Note**: Legacy environment variables will continue to work during Phase 1 but will be removed in Phase 3.

## Testing and Validation

During the deprecation period, both configuration formats are supported and tested:

1. **Backward Compatibility Testing**: Ensures existing `sessiondb:` configurations continue to work
2. **Migration Testing**: Validates that the migration utility produces correct `persistence:` configurations
3. **Forward Compatibility Testing**: Ensures new `persistence:` configurations work correctly
4. **Mixed Configuration Testing**: Tests scenarios where both configurations exist

## Communication Plan

### For Development Teams

- Include deprecation notices in release notes
- Provide migration guides and examples
- Offer migration assistance for complex configurations
- Monitor support channels for migration issues

### For End Users

- Display clear deprecation warnings with actionable instructions
- Provide comprehensive migration documentation
- Ensure migration utility is easily accessible and well-documented

## Rollback Plan

If critical issues are discovered during the deprecation process:

1. **Phase 1**: No rollback needed - both configurations work
2. **Phase 2**: Can temporarily re-enable `sessiondb:` support with warning
3. **Phase 3**: Rollback would require code restoration (not recommended)

## Success Metrics

- **Migration Adoption**: % of configurations migrated from `sessiondb:` to `persistence:`
- **Support Issues**: Number of migration-related support requests
- **Breaking Changes**: Number of applications broken by deprecation phases
- **Documentation Coverage**: % of documentation updated to use `persistence:` configuration

## FAQ

### Q: When should I migrate my configuration?

**A**: As soon as possible during Phase 1. The migration is safe and provides better functionality.

### Q: What happens if I don't migrate before Phase 2?

**A**: Your application will fail to start with clear error messages directing you to migrate.

### Q: Can I use both configurations simultaneously?

**A**: During Phase 1, if both exist, `persistence:` takes precedence. However, this is not recommended.

### Q: Are there any breaking changes in the migration?

**A**: No functional breaking changes. The migration maintains all existing functionality while improving configuration structure.

### Q: What if the migration utility doesn't work for my configuration?

**A**: Contact support or file an issue. The migration utility is designed to handle all valid `sessiondb:` configurations.

---

## Implementation Status

- [x] **Migration Utility**: Complete and tested
- [x] **Deprecation Warnings**: Implemented in persistence service and CLI utilities
- [x] **Documentation Updates**: Core documentation migrated to `persistence:` examples
- [x] **Backward Compatibility**: Full support for `sessiondb:` configuration during transition
- [ ] **Phase 2 Planning**: Define exact version and communication strategy
- [ ] **Phase 3 Planning**: Define cleanup scope and timeline
