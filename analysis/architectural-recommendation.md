# Architectural Recommendation: AI-First SQLite-to-PostgreSQL Strategy

## Executive Decision

**Adopt SQLite-first architecture with seamless upgrade to PostgreSQL for team features, optimized for AI-powered workflows.**

## The AI-First Game Changer

**Key Insight**: Minsky is fundamentally an AI-powered task management tool, which changes everything:

- 🤖 **Core value requires AI APIs** (OpenAI, Anthropic, etc.)
- 🌐 **Users need internet** for primary features
- ⚡ **Performance matters** for AI workflows
- 👥 **Team collaboration** on AI-generated content is critical
- 📱 **Offline optimization is secondary** (AI requires connectivity)

This realization eliminates many concerns about external dependencies while highlighting the need for database capabilities.

## Recommended Architecture Strategy

### Phase 1: SQLite Default (Immediate Experience)

```bash
# Zero-friction onboarding
git clone project
minsky init
# → Creates .minsky/tasks.db
# → Ready for AI features immediately

minsky config set ai.provider openai  
minsky config set ai.apiKey sk-...
minsky tasks decompose "Build authentication system"
# → AI decomposition works perfectly with SQLite
```

**Benefits**:
- ✅ Zero setup friction
- ✅ No account dependencies  
- ✅ AI features work immediately
- ✅ Fast local operations
- ✅ Perfect for solo developers and experimentation

### Phase 2: Team Upgrade (When Collaboration Needed)

```bash
# When team features needed
minsky upgrade to-postgres --provider supabase

# Automated migration
✓ Exporting SQLite data...
✓ Creating PostgreSQL schema...  
✓ Migrating 127 tasks...
✓ Migrating AI embeddings...
✓ Enabling real-time features...
✓ Migration complete!
```

**Unlocks**:
- ✅ Real-time collaboration
- ✅ Advanced vector search (pgvector)
- ✅ Team AI workflows
- ✅ Professional backup/scaling
- ✅ Concurrent access patterns

## AI Feature Compatibility Matrix

| Feature | SQLite | PostgreSQL | Notes |
|---------|--------|------------|-------|
| **AI Task Decomposition** | ✅ | ✅ | Works great locally |
| **Semantic Search** | 🟡 | ✅ | Limited vectors vs pgvector |
| **AI Complexity Scoring** | ✅ | ✅ | Pure AI API feature |
| **Real-time AI Collab** | ❌ | ✅ | Requires websockets/pub-sub |
| **Vector Embeddings** | 🟡 | ✅ | JSON storage vs native vectors |
| **Team AI Insights** | ❌ | ✅ | Requires shared database |
| **Cross-repo AI Analysis** | ✅ | ✅ | Both support complex queries |

## Migration Strategy: Simple and Reliable

### Approach: Manual Migration (Not Sync)

**Why not bidirectional sync?**
- 🔴 **Massive complexity** - conflict resolution, schema sync, operational overhead
- 🔴 **Over-engineering** - most users upgrade once and stay on PostgreSQL
- 🔴 **Maintenance burden** - ongoing sync logic and edge cases

**Why simple migration works better:**
- ✅ **One-time operation** - clean transition to better backend
- ✅ **Clear semantics** - no ambiguity about data location
- ✅ **Reliable** - well-understood export/import pattern
- ✅ **Fast to implement** - focus on user value

### Migration Implementation

```typescript
// Clean, straightforward migration
async function migrateToPostgreSQL(pgConfig: PostgreSQLConfig) {
  // 1. Export SQLite data
  const tasks = await sqlite.query('SELECT * FROM tasks');
  const relationships = await sqlite.query('SELECT * FROM task_relationships');
  const embeddings = await sqlite.query('SELECT * FROM embeddings');
  
  // 2. Create PostgreSQL schema
  await pg.query(SCHEMA_SQL);
  
  // 3. Import data with referential integrity
  await pg.transaction(async (tx) => {
    await tx.insert('tasks', tasks);
    await tx.insert('task_relationships', relationships);
    await tx.insert('embeddings', embeddings);
  });
  
  // 4. Validate migration
  const counts = await validateMigration(sqlite, pg);
  
  // 5. Update config
  await updateConfig({ backend: 'postgresql', ...pgConfig });
  
  // 6. Backup old SQLite
  await backupSQLite('.minsky/pre-migration-backup.db');
}
```

## Progressive Enhancement Framework

### Decision Tree for Users

```
Are you working solo and experimenting?
├─ YES → SQLite (perfect for you)
└─ NO → Continue

Do you need real-time team collaboration?
├─ YES → PostgreSQL (upgrade recommended)
└─ NO → SQLite fine for now

Do you have >1000 tasks or complex AI workflows?
├─ YES → PostgreSQL (performance benefits)
└─ NO → SQLite sufficient

Are you ready to manage a hosted database?
├─ YES → PostgreSQL (full features)
└─ NO → SQLite until ready
```

### Upgrade Triggers and Prompts

```bash
# Smart upgrade suggestions
minsky tasks list
# → "You have 500+ tasks. Consider upgrading to PostgreSQL for better performance."

minsky ai decompose
# → "Upgrade to PostgreSQL to enable real-time team collaboration on AI features."

minsky team invite
# → "Team features require PostgreSQL. Run 'minsky upgrade to-postgres' to enable."
```

## Hosting Recommendations

### For SQLite Phase
- **Storage**: Local `.minsky/tasks.db` file
- **Backup**: Export commands (`minsky export --format sql`)
- **Sync**: Optional git export for version control
- **AI APIs**: Direct integration (OpenAI, Anthropic)

### For PostgreSQL Phase
- **Recommended**: Supabase (best PostgreSQL + real-time + vector support)
- **Alternatives**: Neon, PlanetScale, Railway
- **Enterprise**: Self-hosted PostgreSQL + Redis
- **Performance**: Connection pooling and read replicas

## Implementation Roadmap

### Phase 1: SQLite Foundation (Month 1)
- [ ] SQLite backend with full AI feature support
- [ ] Vector embedding storage (JSON format)
- [ ] AI task decomposition workflows
- [ ] Export/backup functionality

### Phase 2: PostgreSQL Integration (Month 2)
- [ ] PostgreSQL backend implementation
- [ ] Migration command and validation
- [ ] Real-time collaboration features
- [ ] Advanced vector search (pgvector)

### Phase 3: User Experience Polish (Month 3)
- [ ] Smart upgrade prompts and guidance
- [ ] Performance optimization
- [ ] Error recovery and rollback
- [ ] Documentation and tutorials

### Phase 4: Advanced Features (Month 4+)
- [ ] Advanced AI workflows
- [ ] Team permission systems
- [ ] Analytics and insights
- [ ] Enterprise features

## Why This Strategy Wins

### 1. **Removes Onboarding Friction**
- New users get instant value
- No account setup required
- AI features work immediately
- Familiar file-based storage

### 2. **Enables AI Innovation**
- Fast iteration on AI features
- Local experimentation encouraged
- Performance adequate for AI workflows
- Vector storage capabilities

### 3. **Grows With Users**
- Clear upgrade path when ready
- Team features when needed
- Professional scaling available
- No forced migrations

### 4. **Balances Complexity**
- Simple default (SQLite)
- Advanced option (PostgreSQL)
- Clean migration (not sync)
- Focus on user value

## Success Metrics

### Onboarding Success
- Time from `git clone` to first AI task decomposition: <5 minutes
- Setup steps required: 2 (clone + AI API key)
- User confusion points: Minimize to AI configuration only

### Migration Success  
- Migration time for 1000 tasks: <30 seconds
- Data integrity: 100% preservation
- Upgrade completion rate: >80% when prompted
- Rollback capability: Full data recovery

### Performance Standards
- SQLite AI operations: <200ms
- PostgreSQL AI operations: <100ms  
- Real-time collaboration latency: <500ms
- Vector search queries: <50ms

## Conclusion

The SQLite-first strategy perfectly balances the competing needs of:

- **Simplicity**: Zero-config onboarding removes friction
- **Power**: Full AI features work with SQLite  
- **Growth**: Clear upgrade to PostgreSQL for teams
- **Performance**: Database-optimized for AI workflows

By starting with SQLite and providing smooth PostgreSQL migration, we give users the best of both worlds: immediate value and professional scaling when ready.

**This approach respects user agency while optimizing for AI-first workflows.**