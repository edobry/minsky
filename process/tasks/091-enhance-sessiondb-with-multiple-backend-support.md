# Task #091: Enhance SessionDB with Multiple Backend Support

## Status

COMPLETE

## Priority

High

## Summary

Implement multiple storage backend support for SessionDB to enable users to choose between JSON file storage (for single-user development), SQLite (for local development with better performance), and PostgreSQL (for team/server environments) while maintaining backward compatibility.

## Context

The current SessionDB only supports JSON file storage, which has limitations for team environments and performance with large datasets. This enhancement will provide:

1. **JSON File Storage** - Current implementation (default for backward compatibility)
2. **SQLite Storage** - Local development with better performance and ACID transactions
3. **PostgreSQL Storage** - Team/server environments with concurrent access

All backends will implement the same `DatabaseStorage` interface and be configurable through the existing Minsky configuration system.

## Requirements

✅ **Phase 1: Drizzle ORM Setup**
- [x] Install Drizzle ORM dependencies (drizzle-orm, drizzle-kit, better-sqlite3, pg)
- [x] Create drizzle.config.ts for schema management
- [x] Define session schema for both SQLite and PostgreSQL
- [x] Set up migrations directory structure

✅ **Phase 2: JSON File Storage Backend**
- [x] Create JsonFileStorage class implementing DatabaseStorage interface
- [x] Wrap existing session-db-io.ts functionality
- [x] Implement all CRUD operations with proper error handling
- [x] Maintain backward compatibility with existing session database files

✅ **Phase 3: SQLite Storage Backend**
- [x] Implement SqliteStorage using Drizzle ORM
- [x] Add connection management and automatic migrations
- [x] Support for custom database file paths
- [x] Implement all CRUD operations with proper error handling
- [x] Connection cleanup methods

✅ **Phase 4: PostgreSQL Storage Backend**  
- [x] Create PostgresStorage with connection pooling
- [x] Use Drizzle ORM for PostgreSQL operations
- [x] Handle connection string configuration
- [x] Implement all CRUD operations with proper error handling
- [x] Support for team/server environments

✅ **Phase 5: Backend Factory**
- [x] Build StorageBackendFactory for runtime backend selection
- [x] Implement backend validation with graceful fallback
- [x] Support configuration-based backend selection
- [x] Maintain backward compatibility with existing code

✅ **Phase 6: Configuration System Integration**
- [x] Extend Minsky's configuration system to support storage backends
- [x] Add storage configuration to RepositoryConfig and GlobalUserConfig
- [x] Update ConfigurationLoader to handle storage settings from all sources
- [x] Modify StorageBackendFactory to use configuration service instead of environment variables
- [x] Create SessionDbAdapter that uses configuration-based storage backends
- [x] Update session provider factory to use new adapter by default

**Phase 7: Migration Tools (OPTIONAL)**
- [ ] Create migration utility to move data between backends
- [ ] Add backup/restore functionality
- [ ] Provide migration guidance documentation

## Configuration

The storage backend can be configured through Minsky's existing configuration system:

### Repository Configuration (`.minsky/config.yaml`)
```yaml
version: 1
storage:
  backend: sqlite  # json, sqlite, postgres
  sqlite:
    path: ".minsky/sessions.db"
  postgres:
    connection_string: "postgresql://user:pass@localhost/minsky"
  base_dir: ".minsky/git"
```

### Global User Configuration (`~/.config/minsky/config.yaml`)
```yaml
version: 1
storage:
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
  base_dir: "~/.local/state/minsky/git"
credentials:
  postgres:
    connection_string: "postgresql://user:pass@localhost/minsky"
```

### Environment Variables (Override)
```bash
export MINSKY_STORAGE_BACKEND=sqlite
export MINSKY_SQLITE_PATH=/path/to/sessions.db
export MINSKY_POSTGRES_URL=postgresql://user:pass@localhost/minsky
export MINSKY_BASE_DIR=/path/to/sessions
```

The configuration follows the same precedence as other Minsky settings:
1. Command-line flags (highest priority)
2. Environment variables
3. Global user config
4. Repository config
5. Built-in defaults (lowest priority)

## Implementation Details

### Architecture
- **DatabaseStorage Interface**: Generic interface for all storage backends
- **Functional Core**: Pure functions for session operations (session-db.ts)
- **Storage Backends**: Concrete implementations (JsonFileStorage, SqliteStorage, PostgresStorage)
- **Factory Pattern**: Runtime backend selection based on configuration
- **Configuration Integration**: Uses existing Minsky config system

### Key Files Created
- `src/domain/storage/database-storage.ts` - Storage interface
- `src/domain/storage/schemas/session-schema.ts` - Drizzle schema
- `src/domain/storage/backends/json-file-storage.ts` - JSON implementation
- `src/domain/storage/backends/sqlite-storage.ts` - SQLite implementation  
- `src/domain/storage/backends/postgres-storage.ts` - PostgreSQL implementation
- `src/domain/storage/storage-backend-factory.ts` - Backend factory
- `src/domain/session/session-db-adapter.ts` - New configuration-based adapter
- `drizzle.config.ts` - Drizzle ORM configuration

### Testing
All storage backends implement the same interface and can be tested with shared test suites:
```bash
bun test src/domain/storage/backends/
```

## Usage Examples

### Basic Usage (Uses Configuration)
```typescript
import { createSessionProvider } from '../domain/session';

// Uses configuration system to determine backend
const sessionProvider = createSessionProvider();
const sessions = await sessionProvider.listSessions();
```

### Direct Backend Creation
```typescript
import { StorageBackendFactory } from '../domain/storage/storage-backend-factory';

// Create from configuration
const storage = await StorageBackendFactory.create('/path/to/workspace');

// Or create directly
const sqliteStorage = StorageBackendFactory.createFromConfig({
  backend: 'sqlite',
  dbPath: '/path/to/sessions.db',
  baseDir: '/path/to/git'
});
```

### Configuration Examples
```typescript
// Repository-level config (committed to repo)
const repoConfig = {
  version: 1,
  storage: {
    backend: 'sqlite',
    sqlite: { path: '.minsky/sessions.db' }
  }
};

// User-level config (global credentials)
const userConfig = {
  version: 1,
  credentials: {
    postgres: { connection_string: 'postgresql://...' }
  }
};
```

## Benefits

1. **Performance**: SQLite provides better performance than JSON for large datasets
2. **Concurrency**: PostgreSQL enables team collaboration with concurrent access
3. **ACID Transactions**: Both SQLite and PostgreSQL provide data consistency
4. **Backward Compatibility**: Existing JSON files continue to work
5. **Configuration-Driven**: Leverages existing Minsky configuration system
6. **Team-Friendly**: Repository-level config ensures consistent team setup
7. **Flexible Deployment**: Supports single-user dev to team server environments

## Migration Notes

- Existing JSON session databases will continue to work
- Default backend remains JSON for backward compatibility
- Migration tools can be added in Phase 7 if needed
- Configuration system provides smooth transition path
