# Enhance SessionDB with Multiple Backend Support

## Context

The current SessionDB implementation uses a JSON file for storage, which is sufficient for individual development but limiting for team environments or container-based workflows. We need to support multiple storage backends, particularly SQLite for local development and PostgreSQL for team/server environments.

The SessionDB has already been refactored into a functional architecture with:

- Pure functions (`session-db.ts`)
- Separated I/O operations (`session-db-io.ts`)
- An adapter pattern (`session-adapter.ts`)
- A generic `DatabaseStorage<T, S>` interface already exists in `src/domain/storage/database-storage.ts`

## Requirements

1. **Storage Backend Implementations**

   - Wrap current JSON implementation as `JsonFileStorage` backend (default)
   - Implement `SqliteStorage` backend for local development
   - Implement `PostgresStorage` backend for team/server environments
   - Use **Drizzle ORM** for all RDBMS interactions (SQLite and PostgreSQL)

2. **Backend Factory & Configuration**

   - Create a backend factory for runtime selection
   - Support environment-based configuration (e.g., `MINSKY_SESSION_BACKEND=sqlite`)
   - Maintain backward compatibility with existing JSON storage

3. **Data Migration**

   - Implement migration utilities between backends
   - Support one-way migrations: JSON → SQLite → PostgreSQL
   - Provide CLI commands for migration operations

4. **Database Schema Design**
   - Design consistent schema for SessionRecord across all backends
   - Ensure efficient querying by session name, task ID, and repository

## Implementation Plan

### Phase 1: Drizzle ORM Setup ✅ COMPLETED

1. **Add dependencies**: `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `pg`
2. **Create schema module**: `src/domain/storage/schemas/session-schema.ts`
3. **Set up Drizzle config**: `drizzle.config.ts` for migrations
4. **Create base migration infrastructure**: `src/domain/storage/migrations/`

### Phase 2: JsonFileStorage Backend ✅ COMPLETED

1. **Create backend**: `src/domain/storage/backends/json-file-storage.ts`
2. **Wrap existing functionality**: Use current `session-db-io.ts` operations
3. **Implement DatabaseStorage interface**: Full CRUD operations
4. **Add tests**: Comprehensive test suite for JSON backend

### Phase 3: SqliteStorage Backend ✅ COMPLETED

1. **Create SQLite backend**: `src/domain/storage/backends/sqlite-storage.ts`
2. **Implement schema**: Sessions table with proper indexing
3. **Add connection management**: Connection pooling and optimization
4. **Implement full CRUD**: Using Drizzle ORM queries
5. **Add tests**: Complete test coverage

### Phase 4: PostgresStorage Backend ✅ COMPLETED

1. **Create PostgreSQL backend**: `src/domain/storage/backends/postgres-storage.ts`
2. **Implement schema**: Same structure as SQLite
3. **Add connection management**: Connection pooling with proper cleanup
4. **Implement full CRUD**: Using Drizzle ORM queries
5. **Add tests**: Complete test coverage

### Phase 5: Backend Factory & Configuration ✅ COMPLETED

1. **Create factory**: `src/domain/storage/storage-backend-factory.ts`
2. **Add configuration loading**: Environment variable support
3. **Update SessionAdapter**: Use factory for backend selection
4. **Ensure backward compatibility**: Default to JSON storage

### Phase 6: Migration Tools 🔄 IN PROGRESS

1. **Create migration interfaces**: `src/domain/storage/migration/`
2. **Implement JSON → SQLite migration**: Data transfer utilities
3. **Implement SQLite → PostgreSQL migration**: Schema and data transfer
4. **Add CLI commands**: `minsky session migrate` command
5. **Add verification tools**: Data integrity checks

## Implementation Steps

1. [x] **Set up Drizzle ORM**

   - [x] Add Drizzle dependencies and configuration
   - [x] Create schema definitions for SessionRecord
   - [x] Set up migration infrastructure

2. [x] **Implement JsonFileStorage Backend**

   - [x] Create `JsonFileStorage` class implementing `DatabaseStorage<SessionRecord, SessionDbState>`
   - [x] Wrap existing session-db-io.ts functionality
   - [x] Add comprehensive tests

3. [x] **Implement SqliteStorage Backend**

   - [x] Create SQLite schema using Drizzle
   - [x] Implement `SqliteStorage` class with Drizzle ORM
   - [x] Add connection pooling and optimization
   - [x] Add comprehensive tests

4. [x] **Implement PostgresStorage Backend**

   - [x] Create PostgreSQL schema using Drizzle
   - [x] Implement `PostgresStorage` class with Drizzle ORM
   - [x] Add connection pooling and optimization
   - [x] Document connection string requirements
   - [x] Add comprehensive tests

5. [x] **Create Backend Factory**

   - [x] Implement `StorageBackendFactory` with backend selection logic
   - [x] Add configuration loading from environment variables
   - [ ] Update SessionAdapter to use the factory
   - [x] Ensure backward compatibility

6. [ ] **Implement Migration Tools**
   - [ ] Create migration interfaces and utilities
   - [ ] Implement JSON → SQLite migration
   - [ ] Implement SQLite → PostgreSQL migration
   - [ ] Add CLI commands for migration operations
   - [ ] Add migration verification and rollback capabilities

## Verification

- [ ] All backends pass the same test suite
- [ ] Session CRUD operations work identically across backends
- [ ] Migration tools successfully transfer all data without loss
- [ ] Performance meets or exceeds current JSON implementation
- [ ] Backward compatibility is maintained
- [ ] Drizzle migrations work correctly for schema updates
- [ ] Connection pooling works efficiently under load

## Configuration Examples

```bash
# Local development with SQLite
export MINSKY_SESSION_BACKEND=sqlite
export MINSKY_SQLITE_PATH=~/.local/state/minsky/sessions.db

# Team environment with PostgreSQL
export MINSKY_SESSION_BACKEND=postgres
export MINSKY_POSTGRES_URL=postgresql://user:pass@host:5432/minsky

# Default JSON file storage (backward compatible)
# No configuration needed
```
