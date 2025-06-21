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

## Implementation Steps

1. [ ] **Set up Drizzle ORM**
   - [ ] Add Drizzle dependencies and configuration
   - [ ] Create schema definitions for SessionRecord
   - [ ] Set up migration infrastructure

2. [ ] **Implement JsonFileStorage Backend**
   - [ ] Create `JsonFileStorage` class implementing `DatabaseStorage<SessionRecord, SessionDbState>`
   - [ ] Wrap existing session-db-io.ts functionality
   - [ ] Add comprehensive tests

3. [ ] **Implement SqliteStorage Backend**
   - [ ] Create SQLite schema using Drizzle
   - [ ] Implement `SqliteStorage` class with Drizzle ORM
   - [ ] Add connection pooling and optimization
   - [ ] Add comprehensive tests

4. [ ] **Implement PostgresStorage Backend**
   - [ ] Create PostgreSQL schema using Drizzle
   - [ ] Implement `PostgresStorage` class with Drizzle ORM
   - [ ] Add connection pooling and optimization
   - [ ] Document connection string requirements
   - [ ] Add comprehensive tests

5. [ ] **Create Backend Factory**
   - [ ] Implement `StorageBackendFactory` with backend selection logic
   - [ ] Add configuration loading from environment variables
   - [ ] Update SessionAdapter to use the factory
   - [ ] Ensure backward compatibility

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
