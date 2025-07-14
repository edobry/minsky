# Task: Implement Cross-Database Migration System

## Overview

Build a comprehensive database migration system that enables seamless migration between different storage backends (SQLite, PostgreSQL, JSON) with validation, rollback capabilities, and performance optimization.

## Context

Current migration functionality is limited to basic JSON-to-SQLite migration via `sessiondb migrate`. We need a robust system that:

- Supports all backend combinations (SQLite ↔ PostgreSQL ↔ JSON)
- Handles incremental and resumable migrations
- Provides data transformation for type compatibility
- Includes rollback and validation capabilities

## Requirements

### Core Migration Engine

1. **Universal Migration Interface**

   - Support migration between any two backend types
   - Handle schema differences and data type conversions
   - Provide migration preview and validation

2. **Migration Types**

   - Full migration: Complete data transfer
   - Incremental migration: Only migrate changes since last migration
   - Resumable migration: Continue from interruption point
   - Differential migration: Sync differences between databases

3. **Data Transformation**
   - Handle SQLite to PostgreSQL type mapping
   - JSON structure normalization
   - Foreign key constraint handling
   - Index recreation and optimization

### Migration Features

4. **Pre-Migration Validation**

   - Source database integrity check
   - Target database compatibility verification
   - Estimated migration time and resource requirements
   - Conflict detection and resolution strategies

5. **Migration Execution**

   - Batch processing for large datasets
   - Progress reporting and logging
   - Error handling and partial failure recovery
   - Transaction-based consistency guarantees

6. **Post-Migration Verification**
   - Data integrity validation
   - Performance comparison
   - Schema consistency verification
   - Rollback preparation

### Safety and Recovery

7. **Rollback Capabilities**

   - Safe rollback to pre-migration state
   - Partial rollback for failed migrations
   - Backup creation before migration
   - State restoration verification

8. **Performance Optimization**
   - Connection pooling for PostgreSQL
   - Parallel processing where safe
   - Memory-efficient streaming for large datasets
   - Index optimization strategies

## Implementation Plan

### Phase 1: Core Migration Framework

```typescript
interface CrossDatabaseMigrator {
  validateCompatibility(from: StorageBackend, to: StorageBackend): Promise<CompatibilityReport>;
  planMigration(source: MigrationSource, target: MigrationTarget): Promise<MigrationPlan>;
  executeMigration(plan: MigrationPlan, options: MigrationOptions): Promise<MigrationResult>;
  rollbackMigration(migrationId: string): Promise<RollbackResult>;
}

interface MigrationPlan {
  migrationId: string;
  sourceBackend: BackendType;
  targetBackend: BackendType;
  estimatedDuration: Duration;
  requiredTransformations: DataTransformation[];
  risks: MigrationRisk[];
  rollbackStrategy: RollbackStrategy;
}
```

### Phase 2: Backend-Specific Adapters

```typescript
interface MigrationAdapter {
  exportData(options: ExportOptions): Promise<MigrationData>
  importData(data: MigrationData, options: ImportOptions): Promise<ImportResult>
  validateIntegrity(): Promise<IntegrityResult>
  createBackup(): Promise<BackupResult>
}

class SQLiteMigrationAdapter implements MigrationAdapter
class PostgreSQLMigrationAdapter implements MigrationAdapter
class JSONMigrationAdapter implements MigrationAdapter
```

### Phase 3: CLI Integration

```typescript
// Extended sessiondb commands
minsky sessiondb migrate --from sqlite --to postgresql --connection-url "postgresql://..."
minsky sessiondb migrate --from postgresql --to sqlite --sqlite-path ./sessions.db
minsky sessiondb migrate --incremental --since "2024-01-01"
minsky sessiondb migrate --preview --dry-run
minsky sessiondb rollback --migration-id "migration-123"
```

## Data Transformations

### SQLite ↔ PostgreSQL

- **Type Mapping**: SQLite TEXT/INTEGER/REAL → PostgreSQL VARCHAR/BIGINT/DOUBLE PRECISION
- **Primary Keys**: Handle AUTOINCREMENT vs SERIAL differences
- **Constraints**: Foreign key constraint recreation
- **Indexes**: Index type compatibility and optimization

### JSON ↔ Relational

- **Schema Extraction**: Auto-detect schema from JSON structure
- **Normalization**: Handle nested objects and arrays
- **Validation**: Ensure JSON data meets relational constraints
- **Denormalization**: Flatten relational data for JSON export

## Error Handling and Recovery

### Migration Failures

- **Transaction Rollback**: Ensure atomicity of migration operations
- **Partial Recovery**: Resume from checkpoint for large migrations
- **Conflict Resolution**: Handle duplicate keys, constraint violations
- **State Reconciliation**: Verify consistency between source and target

### Safety Mechanisms

- **Pre-flight Checks**: Validate preconditions before starting
- **Backup Creation**: Automatic backup before destructive operations
- **Verification Steps**: Post-migration data integrity checks
- **Rollback Testing**: Verify rollback procedures during planning

## Testing Requirements

### Unit Tests

- Migration adapter functionality
- Data transformation accuracy
- Error handling and recovery
- Performance optimization logic

### Integration Tests

- Full migration scenarios for each backend combination
- Large dataset migration testing
- Failure and recovery testing
- Concurrent migration handling

### End-to-End Tests

- CLI command integration
- Real database migration scenarios
- Performance benchmarking
- User workflow validation

## Success Criteria

1. **Functionality**: Support migration between all backend combinations
2. **Reliability**: Zero data loss during migrations with proper validation
3. **Performance**: Handle large datasets (1000+ sessions) efficiently
4. **Safety**: Comprehensive rollback and recovery capabilities
5. **Usability**: Clear CLI interface with progress reporting and error messages
6. **Maintainability**: Well-documented, testable, and extensible architecture

## Dependencies

- Enhanced storage backend factory (from current work)
- Database integrity checker (from current work)
- PostgreSQL client configuration
- Migration state tracking storage

## Acceptance Criteria

- [ ] Successfully migrate session data between SQLite, PostgreSQL, and JSON
- [ ] Handle incremental migrations without data duplication
- [ ] Provide rollback capability for failed migrations
- [ ] Include comprehensive pre-migration validation
- [ ] Support large dataset migration with progress reporting
- [ ] Pass all integration tests for cross-backend scenarios
- [ ] Documentation for CLI usage and migration strategies
