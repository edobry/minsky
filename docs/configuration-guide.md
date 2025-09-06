# Minsky Configuration System Guide

## Overview

The Minsky configuration system provides a centralized, validated approach to managing all configuration aspects including storage backends, session databases, AI providers, and credentials. This guide covers configuration precedence, validation, migration, and best practices.

## Configuration Precedence Order

Minsky follows a strict configuration precedence order, where higher-priority sources override lower-priority ones:

### 1. Command Line Arguments (Highest Priority)

```bash
minsky tasks list --backend=github-issues
minsky sessions start --sessiondb-backend=sqlite
```

### 2. Environment Variables

```bash
export MINSKY_SESSIONDB_BACKEND=postgres
export MINSKY_SESSIONDB_POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/minsky"
export MINSKY_AI_DEFAULT_PROVIDER=openai
export MINSKY_WORKSPACE_MAIN_PATH="/absolute/path/to/main/workspace"  # NEW
```

### 3. User Configuration File (`~/.config/minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
sessiondb:
  backend: sqlite
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
```

### 4. Repository Configuration File (`.minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
backends:
  default: "github-issues"
```

### 5. Default Configuration (Lowest Priority)

Built-in defaults ensure Minsky works out-of-the-box without any configuration.

## Workspace Configuration (NEW)

The `workspace` section allows specifying the absolute path to the main workspace root:

```yaml
workspace:
  mainPath: "/Users/you/Projects/minsky"
```

- When set, in-tree task backends (markdown, json-file) resolve `process/tasks.*` and task specs against `workspace.mainPath`.
- If unset, backends fall back to explicit `workspacePath` or `process.cwd()`.
- Environment override: `MINSKY_WORKSPACE_MAIN_PATH`.

## PostgreSQL Vector Storage Configuration

Minsky supports advanced similarity search through PostgreSQL with the pgvector extension. This enables semantic search capabilities for tasks and rules.

### Vector Storage Capabilities

| Backend    | Vector Storage   | Similarity Search               | Configuration Required |
| ---------- | ---------------- | ------------------------------- | ---------------------- |
| PostgreSQL | ✅ Full Support  | Semantic search with embeddings | pgvector extension     |
| SQLite     | ❌ Not supported | Lexical fallback only           | N/A                    |
| JSON       | ❌ Not supported | Lexical fallback only           | N/A                    |

### PostgreSQL Persistence Configuration

To enable vector storage, configure PostgreSQL as your persistence backend:

```yaml
version: 1
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://user:password@localhost:5432/minsky"
    maxConnections: 10
    connectTimeout: 30000
    idleTimeout: 10000
    prepareStatements: true
```

### Environment Variable Configuration

```bash
# PostgreSQL persistence backend
export MINSKY_PERSISTENCE_BACKEND=postgres
export MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://user:password@localhost:5432/minsky"

# Optional connection tuning
export MINSKY_PERSISTENCE_POSTGRES_MAX_CONNECTIONS=10
export MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT=30000
export MINSKY_PERSISTENCE_POSTGRES_IDLE_TIMEOUT=10000
export MINSKY_PERSISTENCE_POSTGRES_PREPARE_STATEMENTS=true
```

### Vector Storage Commands

Once PostgreSQL with pgvector is configured, these commands become available:

```bash
# Semantic task similarity search
minsky tasks search "authentication workflow patterns"
minsky tasks similar mt#123

# Semantic rule similarity search
minsky rules search "error handling best practices"

# Generate/rebuild embeddings
minsky tasks index-embeddings --reindex
minsky rules index-embeddings --reindex
```

### Migration from SQLite to PostgreSQL

To enable vector storage capabilities, migrate from SQLite to PostgreSQL:

1. **Set up PostgreSQL with pgvector** (see [PostgreSQL Vector Storage Setup Guide](postgresql-vector-storage-setup.md))

2. **Update configuration** to use PostgreSQL backend

3. **Initialize embeddings** for existing content:
   ```bash
   minsky tasks index-embeddings --reindex
   minsky rules index-embeddings --reindex
   ```

### Fallback Behavior

When vector storage is unavailable (SQLite/JSON backends), similarity commands automatically fall back to lexical search with reduced capabilities.

**See Also:**

- [PostgreSQL Vector Storage Setup Guide](postgresql-vector-storage-setup.md) - Complete setup instructions
- [SessionDB Migration Guide](sessiondb-migration-guide.md) - Data migration between backends

## Notes

- This setting prevents accidental use of remote URLs or session workspace paths for task file operations.
