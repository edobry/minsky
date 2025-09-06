# PostgreSQL Vector Storage Setup Guide

## Overview

Minsky's similarity search commands (`tasks similar`, `rules search`) require PostgreSQL with the pgvector extension for vector storage capabilities. This guide explains how to set up PostgreSQL with pgvector and configure Minsky to use vector storage for enhanced similarity search functionality.

## Vector Storage Capabilities by Backend

| Backend    | Vector Storage   | Similarity Search    | Use Case                               |
| ---------- | ---------------- | -------------------- | -------------------------------------- |
| PostgreSQL | ✅ Supported     | Full semantic search | Production, teams, similarity features |
| SQLite     | ❌ Not supported | Lexical fallback     | Local development, simple workflows    |
| JSON       | ❌ Not supported | Lexical fallback     | Basic file-based storage               |

## Prerequisites

- PostgreSQL 12+ (recommended: 14+)
- Administrative access to PostgreSQL server
- Network connectivity to PostgreSQL server from Minsky

## Step 1: Install PostgreSQL

### macOS (Homebrew)

```bash
# Install PostgreSQL
brew install postgresql
brew services start postgresql

# Create database and user
createdb minsky
psql minsky -c "CREATE USER minsky_user WITH PASSWORD 'secure_password';"
psql minsky -c "GRANT ALL PRIVILEGES ON DATABASE minsky TO minsky_user;"
```

### Ubuntu/Debian

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Switch to postgres user and create database
sudo -u postgres psql
CREATE DATABASE minsky;
CREATE USER minsky_user WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE minsky TO minsky_user;
\q
```

### Docker

```bash
# Run PostgreSQL in Docker
docker run -d \
  --name minsky-postgres \
  -e POSTGRES_DB=minsky \
  -e POSTGRES_USER=minsky_user \
  -e POSTGRES_PASSWORD=secure_password \
  -p 5432:5432 \
  postgres:15

# Verify connection
docker exec -it minsky-postgres psql -U minsky_user -d minsky -c "SELECT 1;"
```

## Step 2: Install pgvector Extension

The pgvector extension is required for vector similarity search functionality.

### macOS (Homebrew)

```bash
# Install pgvector
brew install pgvector

# Connect to database and enable extension
psql "postgresql://minsky_user:secure_password@localhost:5432/minsky" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Ubuntu/Debian

```bash
# Install pgvector from source
sudo apt install git build-essential postgresql-server-dev-15
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install

# Enable extension in database
sudo -u postgres psql minsky -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Docker with pgvector

Use the official pgvector Docker image:

```bash
# Stop existing container if running
docker stop minsky-postgres
docker rm minsky-postgres

# Run PostgreSQL with pgvector
docker run -d \
  --name minsky-postgres \
  -e POSTGRES_DB=minsky \
  -e POSTGRES_USER=minsky_user \
  -e POSTGRES_PASSWORD=secure_password \
  -p 5432:5432 \
  pgvector/pgvector:pg15

# Enable vector extension
docker exec -it minsky-postgres \
  psql -U minsky_user -d minsky -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## Step 3: Verify pgvector Installation

```bash
# Test vector extension is available
psql "postgresql://minsky_user:secure_password@localhost:5432/minsky" \
  -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Should return:
#  extname | extowner | extnamespace | extrelocatable | extversion | extconfig | extcondition
# ---------+----------+--------------+----------------+------------+-----------+--------------
#  vector  |       10 |         2200 | f              | 0.5.1      |           |
```

## Step 4: Configure Minsky for PostgreSQL

### Option 1: Configuration File

Create or update your Minsky configuration file:

**Global Configuration** (`~/.config/minsky/config.yaml`):

```yaml
version: 1
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://minsky_user:secure_password@localhost:5432/minsky"
    maxConnections: 10
    connectTimeout: 30000
    idleTimeout: 10000
    prepareStatements: true
```

**Repository Configuration** (`.minsky/config.yaml`):

```yaml
version: 1
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://minsky_user:secure_password@localhost:5432/minsky"
```

### Option 2: Environment Variables

```bash
# Set PostgreSQL as persistence backend
export MINSKY_PERSISTENCE_BACKEND=postgres
export MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://minsky_user:secure_password@localhost:5432/minsky"

# Optional: Connection tuning
export MINSKY_PERSISTENCE_POSTGRES_MAX_CONNECTIONS=10
export MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT=30000
export MINSKY_PERSISTENCE_POSTGRES_IDLE_TIMEOUT=10000
```

## Step 5: Initialize Database Schema

Minsky will automatically create the required tables and vector indexes on first use:

```bash
# Test PostgreSQL connection and schema initialization
minsky tasks list

# Check that vector tables were created
psql "postgresql://minsky_user:secure_password@localhost:5432/minsky" \
  -c "\dt *embeddings*"

# Should show tables like:
#              List of relations
#  Schema |      Name         | Type  |    Owner
# --------+-------------------+-------+--------------
#  public | rules_embeddings  | table | minsky_user
#  public | tasks_embeddings  | table | minsky_user
```

## Step 6: Verify Vector Storage Functionality

### Test Similarity Search Commands

```bash
# Test task similarity search
minsky tasks search "authentication workflow"

# Test rule similarity search
minsky rules search "error handling patterns"

# Test specific task similarity
minsky tasks similar mt#123
```

### Expected Output

With vector storage enabled, you should see:

- **Rich semantic search results** based on meaning, not just keywords
- **No error messages** about vector storage being unavailable
- **Similarity scores** in search results

## Configuration Migration from SQLite

If you're currently using SQLite and want to enable vector storage, you'll need to migrate to PostgreSQL.

### Automated Migration

Minsky provides migration tools to transfer your existing data:

```bash
# 1. Backup current SQLite data
mkdir -p ./minsky-backup
minsky sessiondb migrate to json --backup ./minsky-backup --from sqlite

# 2. Set up PostgreSQL (follow steps above)

# 3. Update configuration to use PostgreSQL
# Edit ~/.config/minsky/config.yaml or set environment variables

# 4. Verify PostgreSQL connection
minsky tasks list

# 5. Generate embeddings for existing tasks and rules
minsky tasks index-embeddings --reindex
minsky rules index-embeddings --reindex
```

### Manual Configuration Update

Update your configuration to switch from SQLite to PostgreSQL:

**Before (SQLite)**:

```yaml
persistence:
  backend: sqlite
  sqlite:
    dbPath: "~/.local/state/minsky/minsky.db"
```

**After (PostgreSQL)**:

```yaml
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://minsky_user:secure_password@localhost:5432/minsky"
```

## Fallback Behavior

When vector storage is not available (SQLite/JSON backends), Minsky automatically falls back to lexical search:

### Vector Storage Available (PostgreSQL + pgvector)

- **Full semantic similarity search** using AI embeddings
- **Contextual understanding** of queries and content
- **Ranked results** with similarity scores
- **Advanced filtering** capabilities

### Vector Storage Not Available (SQLite/JSON)

- **Lexical text search** using string matching
- **Basic keyword filtering**
- **Limited semantic understanding**
- **Warning messages** about reduced functionality

### Example Fallback Messages

```bash
# With SQLite backend
$ minsky tasks search "user authentication"
⚠️  Vector storage not supported by current backend, falling back to lexical search

# Results will be based on text matching only
```

## Production Deployment Considerations

### Security

```bash
# Use environment variables for sensitive data
export MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://user:$(cat /secrets/password)@db.internal:5432/minsky"

# Use SSL connections
export MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://user:pass@db.internal:5432/minsky?sslmode=require"
```

### Connection Pool Tuning

```yaml
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://user:pass@db:5432/minsky"
    maxConnections: 20 # Increase for high concurrency
    connectTimeout: 60000 # 60 second timeout
    idleTimeout: 300000 # 5 minute idle timeout
    prepareStatements: true # Enable for better performance
```

### Database Maintenance

```sql
-- Regular maintenance for vector indexes
REINDEX INDEX CONCURRENTLY idx_tasks_embeddings_hnsw;
REINDEX INDEX CONCURRENTLY idx_rules_embeddings_hnsw;

-- Update statistics for query planner
ANALYZE tasks_embeddings;
ANALYZE rules_embeddings;

-- Monitor index usage
SELECT schemaname, tablename, indexname, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexname LIKE '%embeddings%';
```

## Troubleshooting

### Common Issues

#### pgvector Extension Not Found

**Error**: `extension "vector" is not available`

**Solutions**:

1. Install pgvector using package manager or from source
2. Restart PostgreSQL after installation
3. Verify installation: `SELECT * FROM pg_available_extensions WHERE name = 'vector';`

#### Connection Refused

**Error**: `connection refused`

**Solutions**:

1. Verify PostgreSQL is running: `pg_isready -h localhost -p 5432`
2. Check firewall settings
3. Verify connection string format
4. Test connection manually: `psql "postgresql://user:pass@host:port/db"`

#### Vector Storage Initialization Fails

**Error**: `pgvector extension not installed`

**Solutions**:

1. Connect to database manually and run: `CREATE EXTENSION IF NOT EXISTS vector;`
2. Verify user has SUPERUSER privileges for extension creation
3. Check PostgreSQL logs for detailed error messages

#### Poor Similarity Search Performance

**Symptoms**: Slow similarity search queries

**Solutions**:

1. Verify HNSW indexes exist: `\di *hnsw*`
2. Update table statistics: `ANALYZE tasks_embeddings;`
3. Increase `effective_cache_size` in PostgreSQL configuration
4. Monitor query execution plans: `EXPLAIN ANALYZE SELECT ...`

### Getting Help

If you encounter issues not covered here:

1. **Check logs**: Enable debug logging with `MINSKY_LOG_LEVEL=debug`
2. **Test connection**: Use `psql` to verify database connectivity
3. **Verify extensions**: Ensure pgvector is properly installed
4. **Check configuration**: Validate your persistence configuration
5. **File an issue**: Report problems with reproduction steps

## Next Steps

Once PostgreSQL with pgvector is configured:

1. **Generate embeddings** for existing content:

   ```bash
   minsky tasks index-embeddings --reindex
   minsky rules index-embeddings --reindex
   ```

2. **Test similarity search** functionality:

   ```bash
   minsky tasks search "your search query"
   minsky rules search "pattern name"
   ```

3. **Monitor performance** and tune connection pool settings as needed

4. **Set up backups** for your PostgreSQL database

For more information, see:

- [Configuration Guide](configuration-guide.md)
- [SessionDB Migration Guide](sessiondb-migration-guide.md)
- [Multi-Backend User Guide](multi-backend-user-guide.md)
