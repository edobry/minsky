# SessionDB Multi-Backend Architecture

This document describes the architecture and design of Minsky's multi-backend SessionDB system, which supports JSON file, SQLite, and PostgreSQL storage backends.

## Overview

The SessionDB multi-backend system provides a unified interface for session data storage while allowing different underlying storage technologies. This architecture enables:

- **Flexible deployment**: From single-user development to team collaboration
- **Performance optimization**: Choose the right storage backend for your use case
- **Seamless migration**: Switch between backends without losing data
- **Configuration-driven**: Backend selection through configuration files

## Architecture Components

### 1. Storage Backend Factory (`StorageBackendFactory`)

The factory pattern centralizes backend creation and configuration:

```typescript
// Create backend from configuration
const storage = createStorageBackend({
  backend: "sqlite",
  sqlite: {
    dbPath: "~/.local/state/minsky/sessions.db",
    enableWAL: true,
  },
});

// Singleton factory for advanced usage
const factory = StorageBackendFactory.getInstance();
const backend = factory.getBackend(config);
```

**Key Responsibilities:**

- Parse configuration and environment variables
- Create appropriate storage backend instances
- Manage backend lifecycle and caching
- Provide default configurations for each backend type

### 2. Database Storage Interface (`DatabaseStorage`)

Unified interface that all storage backends implement:

```typescript
interface DatabaseStorage<TEntity, TState> {
  initialize(): Promise<boolean>;
  readState(): Promise<DatabaseReadResult<TState>>;
  writeState(state: TState): Promise<DatabaseWriteResult>;
  readEntity(id: string): Promise<DatabaseReadResult<TEntity>>;
  writeEntity(entity: TEntity): Promise<DatabaseWriteResult>;
  deleteEntity(id: string): Promise<DatabaseWriteResult>;
  listEntities(options?: DatabaseQueryOptions): Promise<DatabaseReadResult<TEntity[]>>;
  getStorageLocation(): string;
}
```

**Benefits:**

- Consistent API across all backends
- Type-safe operations
- Standardized error handling
- Pluggable storage implementations

### 3. Session Record Structure

The `SessionRecord` interface defines the core data structure for session persistence:

```typescript
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string;
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string;   // When PR branch was created
    mergedAt?: string;    // When merged (for cleanup)
  };
}
```

#### PR State Optimization (Task #275)

The `prState` field provides intelligent caching for PR workflow operations:

- **Performance**: Eliminates 2-3 git operations per approval (60-70% reduction in race conditions)
- **Cache Management**: 5-minute staleness threshold balances performance with data freshness
- **Graceful Fallback**: Automatically falls back to git operations when cache is missing or stale
- **Lifecycle Management**: Automatically updated on PR creation, merge, and cleanup operations
- **Backward Compatibility**: Optional field that doesn't affect existing session records

### 4. Backend Implementations

#### JSON File Backend (`JsonFileStorage`)

- **Use Case**: Single-user development, simple deployments
- **Features**: File-based storage, atomic writes, backup friendly
- **Performance**: Good for small to medium session counts
- **Configuration**: File path only

#### SQLite Backend (`SqliteStorage`)

- **Use Case**: Local development, better performance
- **Features**: ACID transactions, WAL mode, built-in indexes
- **Performance**: Excellent for local use, concurrent reads
- **Configuration**: Database path, WAL mode, timeouts

#### PostgreSQL Backend (`PostgresStorage`)

- **Use Case**: Team environments, production deployments
- **Features**: Full ACID compliance, concurrent access, network-based
- **Performance**: Excellent for teams, horizontal scaling
- **Configuration**: Connection URL, connection pooling, SSL

### 4. Session Adapter (`SessionDbAdapter`)

Bridges the session provider interface with the storage backend system:

```typescript
export class SessionDbAdapter implements SessionProviderInterface {
  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    // Load configuration to determine backend
    const configResult = await configurationService.loadConfiguration(this.workingDir);
    const sessionDbConfig = configResult.resolved.sessiondb;

    // Create storage backend
    this.storage = createStorageBackend(storageConfig);
    await this.storage.initialize();

    return this.storage;
  }
}
```

**Responsibilities:**

- Load configuration from multiple sources
- Create and manage storage backend instances
- Convert between domain models and storage formats
- Handle backend-specific error conditions

## Configuration System

### Configuration Hierarchy

The system resolves configuration from multiple sources (highest precedence first):

1. **Environment Variables**

   - `MINSKY_SESSION_BACKEND`
   - `MINSKY_SQLITE_PATH`
   - `MINSKY_POSTGRES_URL`

2. **Repository Configuration** (`.minsky/config.yaml`)

   ```yaml
   sessiondb:
     backend: "postgres"
     connectionString: "${MINSKY_POSTGRES_URL}"
   ```

3. **Global User Configuration** (`~/.config/minsky/config.yaml`)

   ```yaml
   sessiondb:
     backend: "sqlite"
     sqlite:
       path: "~/.local/state/minsky/sessions.db"
   ```

4. **Built-in Defaults**
   - Backend: `json`
   - Path: `~/.local/state/minsky/session-db.json`

### Configuration Merging

The configuration system intelligently merges settings:

- **Backend Selection**: Repository config can override user defaults
- **Credentials**: User-level credentials for database connections
- **Paths**: Support for environment variable expansion (`${HOME}`, `~`)

## Data Flow

### Session Creation Flow

1. **Request**: User runs `minsky session start`
2. **Configuration**: Load backend configuration from hierarchy
3. **Backend Creation**: Factory creates appropriate storage backend
4. **Initialization**: Backend ensures database/file structure exists
5. **Session Storage**: Write session record to chosen backend
6. **Workspace Setup**: Create working directory structure

### Session Retrieval Flow

1. **Request**: User runs `minsky session list`
2. **Backend Access**: Retrieve configured storage backend
3. **Query Execution**: Execute backend-specific query
4. **Data Transformation**: Convert storage format to domain models
5. **Response**: Return session list to user

## Migration System

### Migration Architecture

The migration system enables seamless transitions between backends:

```typescript
interface MigrationOptions {
  sourceConfig: SessionDbConfig;
  targetConfig: SessionDbConfig;
  backupPath?: string;
  dryRun?: boolean;
  verify?: boolean;
}
```

### Migration Process

1. **Source Validation**: Verify source backend is accessible
2. **Target Preparation**: Initialize target backend
3. **Backup Creation**: Optional backup of source data
4. **Data Transfer**: Copy all session records
5. **Verification**: Validate data integrity
6. **Configuration Update**: Update configuration files

### Migration Commands

```bash
# Check current status
minsky sessiondb migrate status

# Migrate with backup
minsky sessiondb migrate to sqlite --backup ./backups

# Dry run migration
minsky sessiondb migrate to postgres --dry-run
```

## Error Handling

### Error Categories

1. **Configuration Errors**: Invalid backend type, missing connection strings
2. **Storage Errors**: Database connection failures, permission issues
3. **Data Errors**: Corrupted data, schema mismatches
4. **Migration Errors**: Source/target access issues, data consistency problems

### Error Recovery

- **Automatic Retry**: Transient network errors
- **Graceful Degradation**: Fall back to JSON backend on database failures
- **Data Recovery**: Restore from backups, repair corrupted data
- **User Guidance**: Clear error messages with resolution steps

## Performance Considerations

### Backend Performance Characteristics

| Backend    | Concurrent Reads | Concurrent Writes | Network Latency | Disk I/O |
| ---------- | ---------------- | ----------------- | --------------- | -------- |
| JSON       | Limited          | Serialized        | None            | High     |
| SQLite     | Excellent        | Good              | None            | Medium   |
| PostgreSQL | Excellent        | Excellent         | Variable        | Low      |

### Optimization Strategies

1. **Connection Pooling**: PostgreSQL backend uses connection pooling
2. **WAL Mode**: SQLite uses Write-Ahead Logging for better concurrency
3. **Lazy Loading**: Backends are created only when needed
4. **Caching**: Factory caches backend instances per configuration

## Testing Strategy

### Unit Tests

- Individual backend implementations
- Configuration loading and merging
- Error handling scenarios

### Integration Tests

- Cross-backend data consistency
- Migration workflows
- Real database connections (optional)

### End-to-End Tests

- Complete session workflows
- Configuration scenarios
- Migration success/failure paths

## Security Considerations

### Credential Management

- Environment variables for sensitive data
- File permissions for configuration files
- SSL/TLS for PostgreSQL connections

### Data Protection

- Atomic operations to prevent corruption
- Backup creation during migrations
- Input validation and sanitization

## Future Extensibility

### Adding New Backends

To add a new storage backend:

1. Implement `DatabaseStorage<SessionRecord, SessionDbState>` interface
2. Add backend type to `StorageBackendType` union
3. Update factory creation logic
4. Add configuration types and validation
5. Implement migration support
6. Add tests and documentation

### Potential Future Backends

- **Redis**: For high-performance caching
- **MongoDB**: For document-based storage
- **S3**: For cloud-based storage
- **MySQL**: For additional SQL database support

## Benefits

1. **Flexibility**: Choose the right backend for your deployment
2. **Performance**: Optimize for your specific use case
3. **Scalability**: From single-user to team environments
4. **Reliability**: ACID transactions where needed
5. **Portability**: Migrate between backends without data loss
6. **Maintainability**: Clean abstractions and interfaces

This architecture provides a solid foundation for session management while maintaining flexibility for future requirements and deployment scenarios.
