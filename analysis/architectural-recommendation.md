# Architectural Recommendation: Embrace Database-First Design

## Executive Decision

**Abandon in-tree backends completely. Adopt a database-first architecture with SQLite as the default backend and PostgreSQL for team scenarios.**

## Rationale Summary

### 1. In-Tree Backends Are a Failed Experiment

The analysis reveals that in-tree backends:

- **Don't deliver on their promise**: Special workspace breaks "in-tree" concept
- **Create massive complexity**: 445+ lines of synchronization code
- **Perform terribly**: 100-1000x slower than databases
- **Break with multiple repos**: Fundamental architecture limitation
- **Prevent key features**: AI decomposition and task graphs impossible

### 2. We're Building a Database Poorly

The special workspace mechanism is essentially a naive distributed database implementation using git as a consistency protocol. This is:

- **Solving the wrong problem**: Task management doesn't need distribution
- **Reinventing wheels**: Databases solved these problems decades ago
- **Creating operational burden**: Every user becomes a DBA
- **Architecturally incoherent**: Distributed system requiring centralization

### 3. Database Backends Enable Minsky's Vision

The core Minsky value propositions require database capabilities:

- **AI Task Decomposition**: Needs atomic multi-task transactions
- **Visual Task Graphs**: Requires efficient graph queries
- **Real-time Collaboration**: Demands push notifications
- **Cross-repo Features**: Must span repository boundaries
- **User Intervention**: Needs immediate, consistent updates

## Recommended Architecture

### Phase 1: SQLite as Default (Immediate)

**Implementation**:

```typescript
// Default initialization
minsky init  // Creates .minsky/tasks.db SQLite database

// Configuration
{
  "taskBackend": {
    "type": "sqlite",
    "path": ".minsky/tasks.db"  // Committed to repo for small teams
  }
}
```

**Benefits**:

- Zero external dependencies
- Blazing fast performance
- Single file simplicity
- Natural upgrade path
- Supports all Minsky features

### Phase 2: PostgreSQL for Teams (3 months)

**Implementation**:

```typescript
// Team initialization
minsky init --team --db-url postgresql://...

// Or upgrade existing
minsky migrate sqlite-to-postgres
```

**Features**:

- Real-time subscriptions
- Multi-user concurrency
- Advanced querying
- Audit trails
- Role-based access

### Phase 3: Deprecate In-Tree (6 months)

**Steps**:

1. Mark in-tree backends as deprecated
2. Add migration tooling for existing users
3. Remove special workspace code
4. Delete in-tree backend implementations

**Communication**:

```
DEPRECATION NOTICE: In-tree task backends will be removed in v2.0
- Performance and feature limitations make them unsuitable
- Run 'minsky migrate' to convert to SQLite
- See migration guide: docs/migrate-from-intree.md
```

## Implementation Roadmap

### Immediate Actions (Week 1-2)

1. **Document Decision**

   - [ ] Publish ADR for database-first architecture
   - [ ] Create migration guide for existing users
   - [ ] Update README with new approach

2. **SQLite Implementation**

   - [ ] Create SQLite backend with full feature support
   - [ ] Add database migration framework
   - [ ] Implement task CRUD operations
   - [ ] Add relationship support

3. **CLI Updates**
   - [ ] Update `minsky init` to create SQLite by default
   - [ ] Add `--backend` flag for backend selection
   - [ ] Remove special workspace initialization

### Short Term (Month 1)

1. **Feature Parity**

   - [ ] Port all task operations to SQLite
   - [ ] Add indexing for performance
   - [ ] Implement full-text search
   - [ ] Add transaction support

2. **Migration Tools**

   - [ ] In-tree to SQLite converter
   - [ ] Backup/restore utilities
   - [ ] Data validation tools

3. **Testing**
   - [ ] Performance benchmarks
   - [ ] Migration test suite
   - [ ] Multi-platform testing

### Medium Term (Month 2-3)

1. **PostgreSQL Backend**

   - [ ] Implement PostgreSQL adapter
   - [ ] Add connection pooling
   - [ ] Real-time subscriptions
   - [ ] Team features

2. **Advanced Features**

   - [ ] AI task decomposition
   - [ ] Visual task graphs
   - [ ] Cross-repo relationships
   - [ ] Webhook support

3. **Deprecation Process**
   - [ ] Mark in-tree as deprecated
   - [ ] Add deprecation warnings
   - [ ] Update documentation

### Long Term (Month 4-6)

1. **Remove Legacy Code**

   - [ ] Delete special workspace manager
   - [ ] Remove in-tree backends
   - [ ] Clean up git sync code
   - [ ] Simplify architecture

2. **Advanced Features**
   - [ ] GraphQL API
   - [ ] Plugin system
   - [ ] External integrations
   - [ ] Analytics dashboard

## Migration Strategy

### For Existing In-Tree Users

1. **Automated Detection**

   ```bash
   $ minsky tasks list
   WARNING: In-tree backend detected
   Run 'minsky migrate' to upgrade to SQLite for:
   - 100x faster performance
   - AI-powered features
   - Cross-repo support
   ```

2. **One-Command Migration**

   ```bash
   $ minsky migrate
   Analyzing in-tree tasks...
   Found 127 tasks across 3 repositories
   Creating SQLite database...
   Migrating tasks... ████████████████ 100%
   Migration complete!

   Old: 3.2s to list tasks
   New: 0.003s to list tasks (1000x faster!)
   ```

3. **Gradual Rollout**
   - v1.5: SQLite default, in-tree deprecated
   - v1.6: Migration warnings increase
   - v1.7: In-tree requires --legacy flag
   - v2.0: In-tree backends removed

## Success Metrics

### Performance Targets

- Task list: <10ms (from 3-5 seconds)
- Task creation: <20ms (from 5-10 seconds)
- Status update: <5ms (from 3-4 seconds)
- Complex queries: <100ms (from impossible)

### User Experience Goals

- Zero setup friction for SQLite
- Clear upgrade path to PostgreSQL
- No more "special workspace" confusion
- Instant operations for better flow

### Feature Enablement

- ✅ AI task decomposition
- ✅ Visual task graphs
- ✅ Cross-repo features
- ✅ Real-time collaboration
- ✅ Third-party integrations

## Risk Mitigation

### Potential Concerns

1. **"But we promised no dependencies!"**

   - SQLite is not a dependency, it's embedded
   - Git is already a dependency
   - Special workspace was a hidden dependency

2. **"What about version control for tasks?"**

   - Tasks aren't code, different versioning needs
   - Database audit trails are superior
   - Git history still available for database file

3. **"This is a breaking change!"**
   - Automated migration provided
   - Massive performance improvement
   - Enables promised features

## Conclusion

The analysis overwhelmingly supports abandoning in-tree backends:

1. **Technical**: Databases are the right tool for the job
2. **Performance**: 100-1000x improvement
3. **Features**: Enables Minsky's vision
4. **Simplicity**: Removes special workspace complexity
5. **Scalability**: Proven to billions of records

By choosing database-first architecture, Minsky can deliver on its promise of AI-powered task management without the burden of a half-baked distributed database implementation.

**The path forward is clear: Embrace SQLite, enable features, delight users.**
