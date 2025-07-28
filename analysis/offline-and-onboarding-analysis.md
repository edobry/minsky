# Offline Work and Onboarding: Core UX Requirements

## The User Experience Tension

Our analysis identified problems with in-tree backends, but suggested solutions (GitHub Issues + hosted DB) that create new UX problems:

### Critical Requirements We Can't Ignore:

1. **Offline Work**: Developers work on planes, have poor internet, need reliability
2. **Zero-Friction Onboarding**: "Just clone and it works" is genuinely valuable
3. **No Account Dependencies**: Requiring external service signup is friction

### How Our Suggestions Fail These Requirements:

**GitHub Issues Approach:**

- ❌ **Offline**: Can't create/update issues without internet
- ❌ **Onboarding**: Requires GitHub account, issue permissions setup
- ❌ **Self-contained**: External dependency on GitHub

**Hosted Database Approach:**

- ❌ **Offline**: Can't sync without internet (though local operations work)
- ❌ **Onboarding**: Requires database setup, credentials, account creation
- ❌ **Self-contained**: External dependency on service

## Backend Options Analysis

### Option 1: SQLite Default ⭐

```bash
# Zero-config startup
git clone repo
minsky tasks list  # Works immediately, creates .minsky/tasks.db
```

**Offline Support**: ✅ Perfect - everything local
**Onboarding**: ✅ Perfect - zero configuration  
**Backup Strategy**: 🤔 Manual or automated options

#### Backup/Sync Options for SQLite:

```bash
# Manual backup
minsky backup create  # Creates timestamped backup file

# Auto-sync to git (controversial but works)
minsky config set backup.git true  # Commits .minsky/tasks.db.backup

# Cloud sync when ready
minsky sync setup --provider github-gist  # Or Dropbox, etc.
```

### Option 2: Auto-Provisioned Database

Minsky automatically provisions a database for each user:

```bash
# First run
minsky tasks list
# → "Creating your task database..."
# → "Visit https://minsky.dev/db/user123 to see web interface"
```

**Implementation Ideas:**

- **Free tier**: Auto-provision SQLite on our hosted service
- **Sync mechanism**: Users get unique sync URL
- **Local cache**: Still works offline, syncs when online

**Pros**:

- Zero setup for users
- Automatic backup included
- Team sharing possible

**Cons**:

- We become a service provider
- Privacy concerns (data on our servers)
- Dependency on our infrastructure

### Option 3: Local Container Database

Auto-provision local database via Docker/Podman:

```bash
# First run
minsky init
# → "Starting local database container..."
# → "Database ready at localhost:5432"
```

**Technology Options:**

- **Docker Compose**: PostgreSQL + Redis locally
- **Supabase Local**: Full local Supabase stack
- **PocketBase**: Single binary with database + auth + realtime

**Pros**:

- Professional database features
- Offline work
- No external dependencies
- Team can share same container config

**Cons**:

- Requires Docker/container runtime
- More complex than SQLite
- Resource usage

### Option 4: Progressive Enhancement

Start simple, upgrade gracefully:

```typescript
// Phase 1: SQLite (default)
minsky init  // Creates local SQLite

// Phase 2: Cloud sync (optional)
minsky sync enable --provider supabase

// Phase 3: Team database (when needed)
minsky upgrade team --db-url postgres://...
```

**Benefits**:

- Users choose their complexity level
- Clear upgrade path
- Preserves offline + onboarding
- No forced migrations

## Offline Work Requirements Deep Dive

### What "Offline" Means:

1. **Create tasks** without internet
2. **Update task status** without internet
3. **Query/search tasks** without internet
4. **Sync when internet returns**

### How Each Approach Handles Offline:

| Approach            | Create | Update | Query | Sync        |
| ------------------- | ------ | ------ | ----- | ----------- |
| **SQLite**          | ✅     | ✅     | ✅    | Manual/Auto |
| **GitHub Issues**   | ❌     | ❌     | ❌    | N/A         |
| **Hosted DB**       | 🟡\*   | 🟡\*   | ✅    | Auto        |
| **Local Container** | ✅     | ✅     | ✅    | Manual/Auto |

\*With local cache/queue

## Recommended Architecture: Tiered Approach

### Tier 1: SQLite Default (Solo Developers)

```bash
# Zero-config experience
git clone project
minsky tasks create "My first task"  # Just works
```

- **Storage**: Local SQLite file
- **Backup**: Multiple options (git, cloud sync, manual)
- **Offline**: Perfect
- **Onboarding**: Zero friction

### Tier 2: Cloud Sync (Growing Teams)

```bash
# When backup/sharing needed
minsky sync setup --provider github-gist  # Or supabase, etc.
```

- **Storage**: SQLite + cloud backup
- **Backup**: Automatic
- **Offline**: Perfect (local SQLite)
- **Sharing**: Via sync service

### Tier 3: Team Database (Collaboration)

```bash
# When real-time features needed
minsky upgrade team --db-url postgres://team-db
```

- **Storage**: Hosted PostgreSQL
- **Backup**: Professional
- **Offline**: With local cache
- **Features**: Real-time, advanced queries

## The Backup Problem Solved

For SQLite default, multiple backup strategies:

### 1. Git Integration (Revisited)

```bash
# Export for git backup
minsky export --format sql > .minsky/backup.sql
git add .minsky/backup.sql
git commit -m "Backup task database"
```

**Key insight**: Export to human-readable format, not binary SQLite

### 2. Cloud Sync Services

```bash
# Setup one-time
minsky sync setup --provider github-gist

# Auto-backup every change
minsky config set sync.auto true
```

### 3. Manual Backup

```bash
# Create timestamped backup
minsky backup create  # → tasks-2024-01-15.db

# Restore from backup
minsky backup restore tasks-2024-01-15.db
```

## Decision Framework

**Choose based on user context:**

```
Are you working solo?
├─ YES → SQLite default
└─ NO → Continue

Do you need real-time collaboration?
├─ YES → Team database
└─ NO → SQLite + cloud sync

Do you travel/work offline frequently?
├─ YES → Local storage (SQLite/Container)
└─ NO → Hosted database acceptable
```

## Conclusion

**Recommended approach: SQLite-first with clear upgrade paths**

1. **Default**: SQLite for perfect offline + onboarding experience
2. **Backup**: Multiple strategies (git export, cloud sync, manual)
3. **Team features**: Clear upgrade to hosted database when needed
4. **Progressive**: Users choose their complexity level

This preserves the core benefits that make in-tree backends attractive (offline, onboarding) while providing the performance and features that make databases better for advanced use cases.

**Key insight**: Don't force all users to accept the complexity of hosted databases when many just want simple, fast, offline task management.
