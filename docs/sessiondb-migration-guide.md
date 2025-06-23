# SessionDB Migration Guide

This guide covers migrating session data between different storage backends in Minsky (JSON file, SQLite, PostgreSQL).

## Overview

Minsky supports three session database backends:

- **JSON File**: Simple file-based storage (default)
- **SQLite**: Local database with ACID transactions
- **PostgreSQL**: Server-based database for team environments

## Quick Start

### 1. Check Current Status

```bash
minsky sessiondb migrate status
```

This shows your current backend configuration and provides recommendations.

### 2. Basic Migration

Migrate from JSON to SQLite:
```bash
minsky sessiondb migrate to sqlite --backup ./backups
```

Migrate to PostgreSQL:
```bash
minsky sessiondb migrate to postgres \
  --connection-string "postgresql://user:password@localhost:5432/minsky" \
  --backup ./backups
```

### 3. Update Configuration

After successful migration, update your configuration:

**Global Configuration** (`~/.config/minsky/config.toml`):
```toml
[sessiondb]
backend = "sqlite"
dbPath = "~/.local/state/minsky/sessions.db"
```

**Repository Configuration** (`.minsky/config.toml`):
```toml
[sessiondb]
backend = "postgres"
connectionString = "postgresql://team:password@db.company.com:5432/minsky_sessions"
```

## Detailed Migration Process

### Pre-Migration Checklist

1. **Backup existing data**
   ```bash
   # Create backup directory
   mkdir -p ./session-backups
   
   # Check what will be migrated (dry run)
   minsky sessiondb migrate to sqlite --dry-run
   ```

2. **Verify target database availability** (PostgreSQL only)
   ```bash
   # Test PostgreSQL connection
   psql "postgresql://user:password@host:5432/database" -c "SELECT 1;"
   ```

3. **Ensure sufficient disk space**
   ```bash
   df -h ~/.local/state/minsky/
   ```

### Step-by-Step Migration

#### JSON to SQLite

1. **Run the migration with backup**:
   ```bash
   minsky sessiondb migrate to sqlite \
     --sqlite-path ~/.local/state/minsky/sessions.db \
     --backup ./session-backups \
     --verify
   ```

2. **Update configuration**:
   ```toml
   [sessiondb]
   backend = "sqlite"
   dbPath = "~/.local/state/minsky/sessions.db"
   ```

3. **Test session operations**:
   ```bash
   minsky session list
   minsky session start --task 123
   ```

#### SQLite to PostgreSQL

1. **Set up PostgreSQL database**:
   ```sql
   CREATE DATABASE minsky_sessions;
   CREATE USER minsky_user WITH PASSWORD 'secure_password';
   GRANT ALL PRIVILEGES ON DATABASE minsky_sessions TO minsky_user;
   ```

2. **Run the migration**:
   ```bash
   minsky sessiondb migrate to postgres \
     --connection-string "postgresql://minsky_user:secure_password@localhost:5432/minsky_sessions" \
     --backup ./session-backups \
     --verify
   ```

3. **Update configuration**:
   ```toml
   [sessiondb]
   backend = "postgres"
   connectionString = "postgresql://minsky_user:secure_password@localhost:5432/minsky_sessions"
   ```

### Migration Options

| Option | Description | Example |
|--------|-------------|---------|
| `--backup <path>` | Create backup before migration | `--backup ./backups` |
| `--dry-run` | Simulate migration without changes | `--dry-run` |
| `--verify` | Verify data integrity after migration | `--verify` |
| `--from <backend>` | Specify source backend (auto-detected) | `--from json` |
| `--json` | Output results in JSON format | `--json` |

### Advanced Migration Scenarios

#### Cross-Environment Migration

**From Development (SQLite) to Production (PostgreSQL)**:

1. **Export development data**:
   ```bash
   # On development machine
   minsky sessiondb migrate to json \
     --backup ./dev-export \
     --from sqlite
   ```

2. **Transfer backup to production**:
   ```bash
   scp ./dev-export/session-backup-*.json production-server:/tmp/
   ```

3. **Import on production**:
   ```bash
   # On production server
   minsky sessiondb restore \
     --backup /tmp/session-backup-*.json \
     --to postgres \
     --connection-string "$MINSKY_POSTGRES_URL"
   ```

## Configuration Examples

### Development Setup (SQLite)

```toml
# ~/.config/minsky/config.toml
[sessiondb]
backend = "sqlite"
dbPath = "~/.local/state/minsky/sessions.db"
baseDir = "~/.local/state/minsky/sessions"
```

### Team Setup (PostgreSQL)

```toml
# .minsky/config.toml (in team repository)
[sessiondb]
backend = "postgres"
connectionString = "${MINSKY_POSTGRES_URL}"
baseDir = "/shared/minsky/sessions"
```

Environment variable:
```bash
export MINSKY_POSTGRES_URL="postgresql://team:password@db.company.com:5432/minsky"
```

### Hybrid Setup

Different backends per repository:

```toml
# Global default (SQLite)
# ~/.config/minsky/config.toml
[sessiondb]
backend = "sqlite"
dbPath = "~/.local/state/minsky/sessions.db"
```

```toml
# Team project override (PostgreSQL)
# project/.minsky/config.toml
[sessiondb]
backend = "postgres"
connectionString = "${PROJECT_POSTGRES_URL}"
```

## Troubleshooting

### Common Issues

#### Migration Fails with "Database locked"

**Symptoms**: SQLite database locked error during migration.

**Solutions**:
1. Close all Minsky sessions:
   ```bash
   minsky session list --active
   minsky session end --all
   ```

2. Check for running processes:
   ```bash
   lsof ~/.local/state/minsky/sessions.db
   ```

3. Retry migration:
   ```bash
   minsky sessiondb migrate to postgres --connection-string "..." --backup ./backups
   ```

#### PostgreSQL Connection Failures

**Symptoms**: "Connection refused" or authentication errors.

**Solutions**:
1. Verify PostgreSQL is running:
   ```bash
   pg_isready -h hostname -p 5432
   ```

2. Test connection manually:
   ```bash
   psql "postgresql://user:password@host:5432/database" -c "SELECT 1;"
   ```

3. Check firewall/network settings:
   ```bash
   telnet hostname 5432
   ```

4. Verify user permissions:
   ```sql
   GRANT ALL PRIVILEGES ON DATABASE minsky_sessions TO your_user;
   ```

#### Verification Failures

**Symptoms**: Migration completes but verification finds inconsistencies.

**Solutions**:
1. Check the verification report:
   ```bash
   minsky sessiondb migrate to sqlite --verify --json | jq '.verificationResult'
   ```

2. Run migration again with fresh target:
   ```bash
   rm target_database_file
   minsky sessiondb migrate to sqlite --verify
   ```

3. Restore from backup if needed:
   ```bash
   minsky sessiondb restore --backup ./backups/session-backup-*.json --to sqlite
   ```

#### Disk Space Issues

**Symptoms**: Migration fails with "No space left on device".

**Solutions**:
1. Check available space:
   ```bash
   df -h ~/.local/state/minsky/
   ```

2. Clean up old session data:
   ```bash
   minsky session clean --older-than 30d
   ```

3. Use different location:
   ```bash
   minsky sessiondb migrate to sqlite --sqlite-path /larger/disk/sessions.db
   ```

### Recovery Procedures

#### Restore from Backup

If migration fails and corrupts data:

```bash
# Restore from automatic backup
minsky sessiondb restore \
  --backup ./backups/session-backup-2025-01-20T10-30-00-000Z.json \
  --to json
```

#### Manual Data Recovery

For SQLite corruption:

```bash
# Try to recover using SQLite tools
sqlite3 corrupted.db ".recover" > recovered.sql
sqlite3 new.db < recovered.sql
```

For JSON corruption:

```bash
# Attempt to fix JSON syntax
jq '.' broken.json > fixed.json 2>/dev/null || echo "Cannot fix JSON"
```

### Performance Optimization

#### SQLite Optimizations

```bash
# Configure SQLite for better performance
minsky config set sessiondb.sqliteOptions.journalMode WAL
minsky config set sessiondb.sqliteOptions.synchronous NORMAL
minsky config set sessiondb.sqliteOptions.cacheSize 10000
```

#### PostgreSQL Optimizations

```sql
-- Database-level optimizations
ALTER DATABASE minsky_sessions SET random_page_cost = 1.1;
ALTER DATABASE minsky_sessions SET effective_cache_size = '256MB';

-- Create indexes for common queries
CREATE INDEX CONCURRENTLY idx_sessions_task_id ON sessions(task_id);
CREATE INDEX CONCURRENTLY idx_sessions_created_at ON sessions(created_at);
```

## Best Practices

### Development Workflow

1. **Use SQLite for local development**:
   ```toml
   [sessiondb]
   backend = "sqlite"
   dbPath = "~/.local/state/minsky/sessions.db"
   ```

2. **Use PostgreSQL for shared/production environments**:
   ```toml
   [sessiondb]
   backend = "postgres"
   connectionString = "${MINSKY_POSTGRES_URL}"
   ```

3. **Regular backups**:
   ```bash
   # Daily backup script
   #!/bin/bash
   BACKUP_DIR="$HOME/minsky-backups/$(date +%Y-%m-%d)"
   mkdir -p "$BACKUP_DIR"
   minsky sessiondb migrate to json --backup "$BACKUP_DIR" --from current
   ```

### Security Considerations

1. **Protect connection strings**:
   ```bash
   # Use environment variables
   export MINSKY_POSTGRES_URL="postgresql://user:password@host/db"
   
   # Set restrictive file permissions
   chmod 600 ~/.config/minsky/config.toml
   ```

2. **Use SSL connections for PostgreSQL**:
   ```toml
   [sessiondb]
   connectionString = "postgresql://user:password@host/db?sslmode=require"
   ```

3. **Regular security updates**:
   ```bash
   # Keep Minsky updated
   minsky --version
   minsky self-update
   ```

### Monitoring and Maintenance

1. **Monitor database size**:
   ```bash
   # SQLite
   du -h ~/.local/state/minsky/sessions.db
   
   # PostgreSQL
   psql -c "SELECT pg_size_pretty(pg_database_size('minsky_sessions'));"
   ```

2. **Clean up old sessions**:
   ```bash
   # Remove sessions older than 90 days
   minsky session clean --older-than 90d
   ```

3. **Database maintenance**:
   ```bash
   # SQLite: Vacuum database
   sqlite3 ~/.local/state/minsky/sessions.db "VACUUM;"
   
   # PostgreSQL: Analyze tables
   psql -c "ANALYZE sessions;"
   ```

## FAQ

**Q: Can I use different backends for different repositories?**
A: Yes, repository-specific configuration overrides global settings.

**Q: What happens to my data during migration?**
A: Data is copied to the new backend. Original data remains until you manually remove it.

**Q: Can I migrate back to JSON from SQLite/PostgreSQL?**
A: Yes, migrations work in all directions: JSON ↔ SQLite ↔ PostgreSQL.

**Q: How do I share sessions across team members?**
A: Use PostgreSQL backend with shared database access.

**Q: Is there a performance difference between backends?**
A: SQLite and PostgreSQL are faster for large datasets. JSON is simpler but slower.

**Q: Can I run migrations without downtime?**
A: Yes, migrations don't affect running sessions. Update configuration after migration completes.

**Q: How do I automate migrations in CI/CD?**
A: Use `--json` flag for machine-readable output and `--dry-run` for validation:
```bash
minsky sessiondb migrate to postgres --connection-string "$DB_URL" --json --verify
``` 
