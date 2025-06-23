Implement comprehensive multi-backend storage system for SessionDB with JSON, SQLite, and PostgreSQL support.

## Summary

This PR implements Task #091 to enhance SessionDB with multiple backend support, enabling users to choose between JSON file storage, SQLite database, or PostgreSQL database for session management.

## Changes

### Added

- **Multi-Backend Storage System**: JSON, SQLite, and PostgreSQL backends
- **Drizzle ORM Integration**: Modern TypeScript ORM for database operations
- **Storage Backend Factory**: Configuration-driven backend selection
- **Session Migration Tools**: Migrate data between storage backends
- **Configuration Integration**: Extended Minsky config system for storage settings
- **Database Schema**: Proper schema definitions for SQLite/PostgreSQL
- **Connection Management**: Connection pooling for PostgreSQL backend
- **Migration Verification**: Data integrity verification after migration
- **Backup/Restore**: Safety mechanisms for data migration

### Storage Backends

- **JsonFileStorage**: Wraps existing JSON file functionality
- **SqliteStorage**: Local SQLite database with Drizzle ORM
- **PostgresStorage**: Remote PostgreSQL with connection pooling

### Migration System

- **SessionMigrator**: Core migration functionality with progress tracking
- **Migration Interface**: Type definitions for migration operations
- **Migration Service**: Orchestration and batch processing
- **Data Verification**: Ensures migration integrity
- **Backup Creation**: Safety mechanism before migration

## Configuration

Users can now configure storage backend via:

```typescript
// Global config
{
  storage: {
    backend: 'sqlite' | 'postgres' | 'json',
    sqlite: { dbPath: './sessions.db' },
    postgres: { host: 'localhost', port: 5432, database: 'minsky' }
  }
}
```

## Testing

- Created comprehensive test suite demonstrating all backends
- Verified migration functionality between storage types
- Tested configuration integration
- Validated data integrity and backup mechanisms

## Migration Path

Existing JSON file users can migrate to SQLite/PostgreSQL:
- Automatic backup creation
- Progress tracking during migration
- Data verification after migration
- Rollback capability if needed

This implementation provides the foundation for local SQLite and remote PostgreSQL session storage as requested.
