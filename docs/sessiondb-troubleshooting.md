# SessionDB Troubleshooting Guide

This guide provides solutions for common SessionDB issues across all backends (JSON, SQLite, PostgreSQL).

## Quick Diagnostics

### Health Check Commands

```bash
# Check current backend status
minsky sessiondb migrate status

# List all sessions and their status
minsky session list --detailed

# Test database connectivity
minsky sessiondb test-connection

# Verify database integrity
minsky sessiondb verify --repair
```

### Log Analysis

```bash
# View recent SessionDB logs
minsky logs --component sessiondb --tail 50

# Enable verbose logging
export MINSKY_LOG_LEVEL=debug
minsky session list

# Check system logs (Linux)
journalctl -u minsky --since "1 hour ago"
```

## Common Issues by Backend

### JSON File Backend Issues

#### Issue: `ENOENT: no such file or directory`

**Symptoms**:
```
Error: ENOENT: no such file or directory, open '/path/to/session-db.json'
```

**Causes**:
- Missing session database file
- Incorrect baseDir configuration
- Permission issues

**Solutions**:

1. **Initialize the database**:
   ```bash
   minsky sessiondb init --backend json
   ```

2. **Check configuration**:
   ```bash
   minsky config get sessiondb.baseDir
   minsky config set sessiondb.baseDir ~/.local/state/minsky
   ```

3. **Fix permissions**:
   ```bash
   mkdir -p ~/.local/state/minsky
   chmod 755 ~/.local/state/minsky
   ```

#### Issue: `SyntaxError: Unexpected token`

**Symptoms**:
```
SyntaxError: Unexpected token } in JSON at position 245
```

**Causes**:
- Corrupted JSON file
- Incomplete write operation
- System crash during write

**Solutions**:

1. **Restore from backup**:
   ```bash
   # Find latest backup
   ls -la ~/.local/state/minsky/backups/
   
   # Restore
   minsky sessiondb restore --backup ~/.local/state/minsky/backups/latest.json --to json
   ```

2. **Manual repair**:
   ```bash
   # Backup corrupted file
   cp ~/.local/state/minsky/session-db.json ~/.local/state/minsky/session-db.json.corrupt
   
   # Try to fix JSON syntax
   jq '.' ~/.local/state/minsky/session-db.json > fixed.json
   mv fixed.json ~/.local/state/minsky/session-db.json
   ```

3. **Reset if unfixable**:
   ```bash
   # WARNING: This will lose all session data
   rm ~/.local/state/minsky/session-db.json
   minsky sessiondb init --backend json
   ```

### SQLite Backend Issues

#### Issue: `SQLITE_BUSY: database is locked`

**Symptoms**:
```
Error: SQLITE_BUSY: database is locked
```

**Causes**:
- Another process has the database open
- Unclean shutdown left lock files
- WAL files not properly closed

**Solutions**:

1. **Find blocking processes**:
   ```bash
   lsof ~/.local/state/minsky/sessions.db
   kill -TERM <pid>
   ```

2. **Remove lock files**:
   ```bash
   rm ~/.local/state/minsky/sessions.db-shm
   rm ~/.local/state/minsky/sessions.db-wal
   ```

3. **Repair database**:
   ```bash
   sqlite3 ~/.local/state/minsky/sessions.db "PRAGMA integrity_check;"
   sqlite3 ~/.local/state/minsky/sessions.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```

#### Issue: `SQLITE_CORRUPT: database disk image is malformed`

**Symptoms**:
```
Error: SQLITE_CORRUPT: database disk image is malformed
```

**Causes**:
- Hardware failure
- Filesystem corruption
- Power loss during write

**Solutions**:

1. **Attempt automatic recovery**:
   ```bash
   minsky sessiondb repair --backend sqlite --auto-recover
   ```

2. **Manual recovery**:
   ```bash
   # Try to recover data
   sqlite3 ~/.local/state/minsky/sessions.db ".recover" > recovered.sql
   
   # Create new database from recovered data
   mv ~/.local/state/minsky/sessions.db ~/.local/state/minsky/sessions.db.corrupt
   sqlite3 ~/.local/state/minsky/sessions.db < recovered.sql
   ```

3. **Restore from backup**:
   ```bash
   minsky sessiondb restore --backup ./backups/latest.json --to sqlite
   ```

#### Issue: `SQLITE_READONLY: attempt to write a readonly database`

**Symptoms**:
```
Error: SQLITE_READONLY: attempt to write a readonly database  
```

**Causes**:
- Incorrect file permissions
- Database file on read-only filesystem
- SELinux/AppArmor restrictions

**Solutions**:

1. **Fix permissions**:
   ```bash
   chmod 644 ~/.local/state/minsky/sessions.db
   chmod 755 ~/.local/state/minsky/
   ```

2. **Check filesystem**:
   ```bash
   mount | grep "$(dirname ~/.local/state/minsky/sessions.db)"
   ```

3. **Move to writable location**:
   ```bash
   minsky config set sessiondb.dbPath ~/writable/path/sessions.db
   ```

### PostgreSQL Backend Issues

#### Issue: `Connection refused`

**Symptoms**:
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Causes**:
- PostgreSQL server not running
- Wrong host/port configuration
- Firewall blocking connection

**Solutions**:

1. **Check PostgreSQL status**:
   ```bash
   pg_isready -h hostname -p 5432
   systemctl status postgresql
   ```

2. **Test connection**:
   ```bash
   psql "postgresql://user:password@host:port/database" -c "SELECT 1;"
   ```

3. **Check configuration**:
   ```bash
   minsky config get sessiondb.connectionString
   ```

#### Issue: `password authentication failed`

**Symptoms**:
```
Error: password authentication failed for user "minsky_user"
```

**Causes**:
- Wrong username/password
- User doesn't exist
- Authentication method mismatch

**Solutions**:

1. **Verify credentials**:
   ```sql
   -- As PostgreSQL superuser
   \du minsky_user
   
   -- Reset password if needed
   ALTER USER minsky_user PASSWORD 'new_password';
   ```

2. **Check pg_hba.conf**:
   ```bash
   sudo cat /etc/postgresql/*/main/pg_hba.conf | grep minsky
   ```

3. **Update connection string**:
   ```bash
   minsky config set sessiondb.connectionString "postgresql://correct_user:correct_pass@host:port/db"
   ```

#### Issue: `relation "sessions" does not exist`

**Symptoms**:
```
Error: relation "sessions" does not exist
```

**Causes**:
- Database schema not initialized
- Connected to wrong database
- Schema was dropped

**Solutions**:

1. **Initialize schema**:
   ```bash
   minsky sessiondb init --backend postgres --force
   ```

2. **Check database**:
   ```sql
   \l                    -- List databases
   \c minsky_sessions    -- Connect to correct database
   \dt                   -- List tables
   ```

3. **Verify connection string points to correct database**:
   ```bash
   minsky config get sessiondb.connectionString
   ```

## Error Code Reference

### JSON Backend Error Codes

| Code | Description | Recovery Action |
|------|-------------|-----------------|
| `ENOENT` | File not found | Initialize database or fix path |
| `EACCES` | Permission denied | Fix file permissions |
| `SyntaxError` | Corrupted JSON | Restore from backup or repair |
| `EMFILE` | Too many open files | Close other processes or increase limits |

### SQLite Error Codes

| Code | Description | Recovery Action |
|------|-------------|-----------------|
| `SQLITE_BUSY` | Database locked | Kill blocking processes, remove lock files |
| `SQLITE_CORRUPT` | Database corrupted | Run recovery tools or restore from backup |
| `SQLITE_READONLY` | Read-only database | Fix permissions or move to writable location |
| `SQLITE_CANTOPEN` | Cannot open database | Check path and permissions |
| `SQLITE_FULL` | Disk full | Free up space or move to larger partition |

### PostgreSQL Error Codes

| Code | Description | Recovery Action |
|------|-------------|-----------------|
| `ECONNREFUSED` | Connection refused | Start PostgreSQL or check network |
| `28P01` | Invalid password | Fix credentials |
| `3D000` | Invalid database | Check database name |
| `42P01` | Relation not found | Initialize schema |
| `53300` | Too many connections | Increase connection limits |

## Performance Issues

### Slow Session Operations

**Symptoms**:
- Long delays when listing sessions
- Timeouts during session creation
- High CPU usage during operations

**Diagnostic Commands**:
```bash
# Profile operations
time minsky session list

# Check database statistics (SQLite)
sqlite3 ~/.local/state/minsky/sessions.db "ANALYZE; SELECT * FROM sqlite_stat1;"

# Check PostgreSQL performance
psql -c "SELECT * FROM pg_stat_activity WHERE datname = 'minsky_sessions';"
```

**Solutions**:

1. **SQLite optimizations**:
   ```sql
   -- Enable WAL mode
   PRAGMA journal_mode = WAL;
   
   -- Increase cache size
   PRAGMA cache_size = 10000;
   
   -- Create indexes
   CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
   ```

2. **PostgreSQL optimizations**:
   ```sql
   -- Update statistics
   ANALYZE sessions;
   
   -- Create indexes
   CREATE INDEX CONCURRENTLY idx_sessions_created_at ON sessions(created_at);
   
   -- Check query plans
   EXPLAIN ANALYZE SELECT * FROM sessions WHERE task_id = 'task123';
   ```

3. **General optimizations**:
   ```bash
   # Clean up old sessions
   minsky session clean --older-than 30d
   
   # Vacuum database (SQLite)
   sqlite3 ~/.local/state/minsky/sessions.db "VACUUM;"
   ```

### High Memory Usage

**Symptoms**:
- Minsky process using excessive RAM
- System becomes slow during operations
- Out of memory errors

**Solutions**:

1. **Limit result sets**:
   ```bash
   # Use pagination for large lists
   minsky session list --limit 50 --offset 0
   ```

2. **Configure connection pooling (PostgreSQL)**:
   ```bash
   minsky config set sessiondb.maxConnections 5
   minsky config set sessiondb.idleTimeout 30000
   ```

3. **Monitor memory usage**:
   ```bash
   # Check process memory
   ps aux | grep minsky
   
   # Use memory profiler
   valgrind --tool=massif minsky session list
   ```

## Recovery Procedures

### Emergency Data Recovery

When all else fails, these procedures can help recover session data:

#### 1. Automatic Recovery

```bash
# Run built-in recovery tool
minsky sessiondb recover --auto --backup-first

# If auto-recovery fails, try manual steps below
```

#### 2. Manual JSON Recovery

```bash
# Extract partial data from corrupted JSON
grep -o '"session":"[^"]*"' corrupted.json > session-ids.txt

# Reconstruct basic structure
echo '{"sessions":[' > recovered.json
# ... manually rebuild from fragments
echo ']}' >> recovered.json
```

#### 3. Manual SQLite Recovery

```bash
# Export to SQL
sqlite3 corrupted.db ".recover" > dump.sql

# Clean up SQL dump
sed 's/ROLLBACK/COMMIT/g' dump.sql > clean-dump.sql

# Import to new database
sqlite3 new.db < clean-dump.sql
```

#### 4. PostgreSQL Point-in-Time Recovery

```sql
-- If you have WAL archiving enabled
SELECT pg_start_backup('emergency_recovery');

-- Restore from base backup + WAL files
-- This requires PostgreSQL backup configuration
```

### Data Migration Emergency

If migration fails and leaves system in inconsistent state:

```bash
# 1. Stop all operations
minsky session end --all

# 2. Backup current state
minsky sessiondb export --all --format json > emergency-backup.json

# 3. Reset to known good state
minsky sessiondb reset --backend json --force

# 4. Import emergency backup
minsky sessiondb import --file emergency-backup.json

# 5. Retry migration with more conservative settings
minsky sessiondb migrate to sqlite --verify --dry-run
```

## Prevention Strategies

### Regular Maintenance

```bash
#!/bin/bash
# Weekly maintenance script

# 1. Create backup
BACKUP_DIR="$HOME/minsky-backups/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"
minsky sessiondb export --all > "$BACKUP_DIR/sessions.json"

# 2. Clean old sessions
minsky session clean --older-than 90d

# 3. Optimize database
case $(minsky config get sessiondb.backend) in
  "sqlite")
    sqlite3 ~/.local/state/minsky/sessions.db "ANALYZE; VACUUM;"
    ;;
  "postgres")
    psql "$MINSKY_POSTGRES_URL" -c "ANALYZE sessions;"
    ;;
esac

# 4. Verify integrity
minsky sessiondb verify
```

### Monitoring Setup

```bash
# Set up basic monitoring
echo "*/15 * * * * minsky sessiondb healthcheck" | crontab -

# Log rotation
cat > /etc/logrotate.d/minsky << EOF
/var/log/minsky/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
EOF
```

### Backup Strategy

1. **Daily automated backups**
2. **Pre-migration backups**
3. **Retention policy (keep 30 days)**
4. **Test restore procedures monthly**
5. **Off-site backup storage**

## Getting Help

### Collecting Diagnostic Information

Before reporting issues, collect this information:

```bash
#!/bin/bash
# Diagnostic script

echo "=== Minsky Version ==="
minsky --version

echo "=== Configuration ==="
minsky config list sessiondb

echo "=== Backend Status ==="
minsky sessiondb migrate status --json

echo "=== Recent Logs ==="
minsky logs --component sessiondb --tail 20

echo "=== System Information ==="
uname -a
df -h ~/.local/state/minsky

echo "=== Database Information ==="
case $(minsky config get sessiondb.backend) in
  "sqlite")
    sqlite3 ~/.local/state/minsky/sessions.db "PRAGMA integrity_check; SELECT COUNT(*) FROM sessions;"
    ;;
  "postgres")
    psql "$MINSKY_POSTGRES_URL" -c "SELECT version(); SELECT COUNT(*) FROM sessions;"
    ;;
esac
```

### Support Channels

1. **GitHub Issues**: Report bugs with diagnostic information
2. **Documentation**: Check latest troubleshooting guides
3. **Community Forums**: Ask questions and share solutions
4. **Enterprise Support**: For production environments

### Filing Bug Reports

Include this information:

- Minsky version
- Operating system
- SessionDB backend type
- Full error message
- Steps to reproduce
- Diagnostic script output
- Configuration (sanitized) 
