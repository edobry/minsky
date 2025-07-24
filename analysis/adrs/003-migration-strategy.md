# ADR-003: Gradual Migration from In-Tree to Database Backends

## Status
Proposed

## Context

Existing Minsky users may have task data stored in in-tree backends (markdown/JSON files in repositories). The move to database-first architecture requires a migration strategy that:

- Preserves existing task data
- Minimizes user disruption
- Provides clear upgrade path
- Handles edge cases gracefully

### Current State
- Some users have tasks in `process/tasks.md` files
- Others use JSON backends in special workspaces
- Task IDs may conflict across repositories
- Relationships between tasks may be implicit

## Decision

**Implement a gradual migration strategy with automated tooling, clear communication, and a 6-month deprecation period.**

### Migration Phases:

1. **Detection Phase** (v1.5)
   - Detect in-tree backends on startup
   - Show performance comparisons
   - Offer one-command migration

2. **Encouragement Phase** (v1.6)
   - Deprecation warnings increase
   - Feature limitations documented
   - Success stories shared

3. **Requirement Phase** (v1.7)
   - In-tree requires `--legacy` flag
   - Final migration deadline announced
   - Extended support for holdouts

4. **Removal Phase** (v2.0)
   - In-tree code removed
   - Final migration tool provided
   - Clean architecture

## Rationale

### 1. Gradual Approach
- Gives users time to adapt
- Allows feedback incorporation
- Reduces support burden
- Enables course correction

### 2. Automated Migration
- Reduces friction
- Prevents data loss
- Handles complexity
- Ensures consistency

### 3. Clear Communication
- Sets expectations
- Explains benefits
- Provides timeline
- Offers support

## Migration Algorithm

### 1. Task Discovery
```typescript
async function discoverInTreeTasks() {
  const tasks = [];
  
  // Find all process/tasks.md files
  for (const repo of getRepos()) {
    const mdTasks = parseMarkdownTasks(repo);
    const jsonTasks = parseJsonTasks(repo);
    tasks.push(...mdTasks, ...jsonTasks);
  }
  
  return tasks;
}
```

### 2. ID Conflict Resolution
```typescript
function resolveIdConflicts(tasks) {
  const idMap = new Map();
  
  for (const task of tasks) {
    const originalId = task.id;
    const newId = generateUniqueId(originalId, task.repo);
    
    idMap.set(`${task.repo}:${originalId}`, newId);
    task.id = newId;
  }
  
  return { tasks, idMap };
}
```

### 3. Relationship Reconstruction
```typescript
function reconstructRelationships(tasks, idMap) {
  for (const task of tasks) {
    // Update parent references
    if (task.parentId) {
      task.parentId = idMap.get(`${task.repo}:${task.parentId}`);
    }
    
    // Update dependency references
    task.dependencies = task.dependencies?.map(
      depId => idMap.get(`${task.repo}:${depId}`)
    );
  }
}
```

### 4. Database Import
```typescript
async function importToDatabase(tasks) {
  const db = await openDatabase();
  
  await db.transaction(async (trx) => {
    // Import in dependency order
    const sorted = topologicalSort(tasks);
    
    for (const task of sorted) {
      await trx.insert('tasks', task);
    }
  });
}
```

## Consequences

### Positive
- ✅ Preserves user data
- ✅ Smooth transition
- ✅ Clear timeline
- ✅ Automated process
- ✅ Feedback opportunity

### Negative
- ❌ Extended transition period
- ❌ Dual system maintenance
- ❌ Support complexity
- ❌ Potential confusion

### Mitigation
- Clear documentation
- Automated testing
- Support channels
- Migration assistance

## Communication Plan

### 1. Announcement Blog Post
```markdown
# Minsky 2.0: 1000x Faster with Database Backends

We're excited to announce a major architecture improvement...
- 1000x performance improvement
- New AI-powered features
- Better team collaboration

Migration is simple:
$ minsky migrate

Timeline:
- v1.5 (Jan): Migration available
- v1.6 (Mar): Deprecation warnings
- v1.7 (May): Legacy flag required  
- v2.0 (Jul): In-tree removed
```

### 2. In-Product Messaging
```
$ minsky tasks list
⚠️  Performance Warning: In-tree backend detected

Your tasks could be 1000x faster with database backend!
Current: 3.42s to list 86 tasks
With DB: 0.003s (estimated)

Run 'minsky migrate' to upgrade (takes ~30 seconds)
Learn more: https://minsky.dev/migrate
```

### 3. Success Metrics
- Migration adoption rate
- Performance improvement reports
- User satisfaction scores
- Support ticket volume

## References

- ADR-001: Database-First Architecture
- Task #325: Task Backend Architecture Analysis
- User feedback on migration tools