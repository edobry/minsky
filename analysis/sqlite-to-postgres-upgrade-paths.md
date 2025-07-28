# SQLite to PostgreSQL: Upgrade Paths and Sync Options

## The Progressive Enhancement Vision

**Start Simple**: SQLite for immediate onboarding and basic AI features
**Upgrade When Ready**: PostgreSQL for team collaboration and advanced features

This approach:
- ✅ Removes onboarding friction (no accounts, no setup)
- ✅ Enables immediate AI experimentation
- ✅ Provides clear growth path when team features needed
- ✅ Preserves data during upgrade

## SQLite AI Capabilities Analysis

### What Works Great with SQLite + AI
```typescript
// Core AI features work perfectly with SQLite
const tasks = await sqlite.query('SELECT * FROM tasks WHERE status = "TODO"');
const aiDecomposition = await openai.generateSubtasks(parentTask);
await sqlite.transaction(async (tx) => {
  for (const subtask of aiDecomposition) {
    await tx.insert('tasks', { ...subtask, parent_id: parentTask.id });
  }
});
```

**Supported AI Features:**
- ✅ AI task decomposition
- ✅ AI complexity scoring
- ✅ AI-powered insights
- ✅ Semantic embeddings storage (via JSON or vector extensions)
- ✅ Local AI model inference (if desired)

### What Requires PostgreSQL
- ❌ Real-time collaboration (multiple users)
- ❌ Advanced vector search (pgvector)
- ❌ Complex concurrent access
- ❌ Professional backup/recovery
- ❌ Team permission systems

## Upgrade Path Options

### Option 1: Manual Migration Command

```bash
# When user is ready for team features
minsky upgrade to-postgres --db-url postgresql://...

# Automated data migration
✓ Exporting SQLite data...
✓ Creating PostgreSQL schema...
✓ Migrating 127 tasks...
✓ Migrating 23 task relationships...
✓ Migrating AI embeddings...
✓ Validating data integrity...
✓ Switching backend configuration...
✓ Migration complete!

Old SQLite database backed up to: .minsky/pre-migration-backup.db
```

### Option 2: Bidirectional Sync Engine

Keep SQLite as local cache, sync with PostgreSQL:

```typescript
// Hybrid architecture
const localDB = new SQLiteClient('.minsky/tasks.db');
const remoteDB = new PostgreSQLClient(config.postgres.url);
const syncEngine = new BidirectionalSync(localDB, remoteDB);

// All operations go to SQLite first (fast)
await localDB.insert('tasks', newTask);

// Sync happens in background
await syncEngine.pushChanges(); // Local → Remote
await syncEngine.pullChanges(); // Remote → Local
```

**Benefits:**
- ✅ Fast local operations
- ✅ Offline capability
- ✅ Team collaboration when online
- ✅ Conflict resolution

**Complexity:**
- 🔴 Significant sync logic required
- 🔴 Conflict resolution strategies
- 🔴 Schema compatibility maintenance

### Option 3: PostgreSQL-Compatible SQLite

Use libraries that provide PostgreSQL compatibility:

```bash
# Use pg-lite or similar
npm install pg-lite

# SQLite that speaks PostgreSQL wire protocol
const db = new PGLite('.minsky/tasks.db');
```

**Migration becomes simpler:**
- Same SQL dialect (PostgreSQL)
- Same client libraries  
- Same schema
- Just change connection string

### Option 4: Cloud SQLite Services

Use hosted SQLite that can upgrade to PostgreSQL:

```typescript
// Start with hosted SQLite
const db = new TursoClient(config.turso.url); // LibSQL/Turso

// Later upgrade to PostgreSQL on same platform
const db = new TursoClient(config.turso.postgresUrl);
```

**Services to consider:**
- **Turso**: SQLite with edge replication
- **Cloudflare D1**: SQLite at the edge
- **LiteFS**: SQLite with automatic replication

## Recommended Architecture: Smart Defaults

### Phase 1: SQLite First
```bash
# Zero-config startup
minsky init
# → Creates .minsky/tasks.db
# → Ready for AI features immediately
```

### Phase 2: AI Enhancement  
```bash
# Configure AI when ready
minsky config set ai.provider openai
minsky config set ai.apiKey sk-...

# AI features work with SQLite
minsky tasks decompose "Build user authentication"
```

### Phase 3: Team Upgrade
```bash
# When team collaboration needed
minsky upgrade team --provider supabase
# → Migrates to PostgreSQL
# → Enables real-time features
```

## Sync Engine Architecture

For the bidirectional sync approach:

### Conflict Resolution Strategies
```typescript
enum ConflictResolution {
  LAST_WRITE_WINS = 'last_write_wins',
  MERGE_FIELDS = 'merge_fields', 
  MANUAL_RESOLUTION = 'manual',
  LOCAL_WINS = 'local_wins',
  REMOTE_WINS = 'remote_wins'
}

// Example conflict resolution
async function resolveConflict(localTask: Task, remoteTask: Task): Promise<Task> {
  switch (config.conflictResolution) {
    case ConflictResolution.MERGE_FIELDS:
      return {
        ...localTask,
        title: remoteTask.updated_at > localTask.updated_at ? remoteTask.title : localTask.title,
        status: remoteTask.status_updated_at > localTask.status_updated_at ? remoteTask.status : localTask.status,
        // Smart field-level merging
      };
    case ConflictResolution.LAST_WRITE_WINS:
      return localTask.updated_at > remoteTask.updated_at ? localTask : remoteTask;
  }
}
```

### Change Tracking
```sql
-- Add sync metadata to SQLite schema
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  -- Sync tracking
  local_version INTEGER DEFAULT 1,
  remote_version INTEGER DEFAULT 0,
  last_synced_at TIMESTAMP,
  sync_status TEXT DEFAULT 'pending' -- pending, synced, conflict
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  operation TEXT NOT NULL, -- insert, update, delete
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced BOOLEAN DEFAULT FALSE
);
```

## Migration Complexity Analysis

### Simple Export/Import
```typescript
// Straightforward but requires downtime
const sqliteData = await exportSQLiteData();
await importToPostgreSQL(sqliteData);
await updateConfig({ backend: 'postgresql' });
```

**Pros**: Simple, reliable
**Cons**: Downtime during migration, no rollback

### Live Migration
```typescript
// Zero-downtime migration
const migrator = new LiveMigrator(sqliteDB, postgresDB);
await migrator.startReplication(); // Begin sync
await migrator.waitForCatchUp();   // Ensure sync complete
await migrator.cutover();          // Switch reads/writes to postgres
```

**Pros**: No downtime, can rollback
**Cons**: Complex implementation

## Recommended Implementation Strategy

### Start with Simple Migration
```bash
# Version 1.0: Manual migration command
minsky upgrade to-postgres --db-url $DATABASE_URL

# Version 1.5: Add backup/restore capabilities  
minsky backup create  # Before migration
minsky migrate rollback  # If issues

# Version 2.0: Add sync capabilities (if demand exists)
minsky sync enable --remote-db $DATABASE_URL
```

### Schema Compatibility
```sql
-- Design schema to work with both SQLite and PostgreSQL
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,                    -- Works in both
  title TEXT NOT NULL,                      -- Works in both  
  metadata JSONB,                          -- PostgreSQL native, SQLite stores as TEXT
  embeddings VECTOR(1536),                 -- PostgreSQL pgvector, SQLite stores as BLOB
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Cost-Benefit Analysis

| Approach | Implementation Cost | User Experience | Migration Risk |
|----------|---------------------|-----------------|----------------|
| **Manual Migration** | Low | Good | Low |
| **Sync Engine** | Very High | Excellent | Medium |
| **PostgreSQL-Compatible** | Medium | Good | Low |
| **Cloud SQLite** | Low | Good | Low |

## Recommendation

**Start with manual migration, add sync if there's demand:**

1. **Default**: SQLite for immediate onboarding
2. **AI Features**: Work perfectly with SQLite
3. **Migration**: Simple command when team features needed
4. **Future**: Add sync engine if users request it

This gives the best balance of simplicity and user experience without over-engineering the initial solution.

The key insight: **SQLite + AI is perfectly viable for solo developers**, and the upgrade path can be smooth without building complex sync infrastructure upfront.