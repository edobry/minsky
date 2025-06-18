# Task: Implement Backend Migration Utility

## Context

Users need the ability to migrate existing tasks from one backend to another (e.g., from markdown tasks to GitHub Issues). Currently, when switching from using the markdown tasks backend to github issues, there's no automated way to migrate existing tasks over.

The TaskService already has the infrastructure needed:
- Backend switching capabilities (`switchBackend()`)
- Task listing and creation across backends
- Task spec content reading
- Status management

## Requirements

1. **Create BackendMigrationUtils class** that can migrate tasks between any two supported backends
2. **Support full task migration** including:
   - Task content (title, description from spec files)
   - Task status preservation  
   - Task metadata where supported
   - Proper ID mapping/handling
3. **Provide dry-run capability** to preview migration before executing
4. **Handle edge cases**:
   - ID conflicts between backends
   - Status mapping between different backend conventions
   - Rollback capability if migration fails
5. **Integration with CLI** - add `minsky tasks migrate` command
6. **Comprehensive testing** of migration scenarios

## Implementation Details

### Core Migration Function
```typescript
async function migrateTasksBetweenBackends(
  sourceBackend: string,
  targetBackend: string,
  options: {
    preserveIds?: boolean;
    dryRun?: boolean;
    statusMapping?: Record<string, string>;
    rollbackOnFailure?: boolean;
  }
): Promise<MigrationResult>
```

### CLI Integration
```bash
# Migrate all tasks from markdown to GitHub Issues
minsky tasks migrate --from markdown --to github-issues

# Dry run first
minsky tasks migrate --from markdown --to github-issues --dry-run

# Custom status mapping
minsky tasks migrate --from markdown --to github-issues --map-status TODO=minsky:todo
```

### Error Handling
- Partial migration recovery
- Detailed logging of migration progress
- Rollback capability for failed migrations

## Acceptance Criteria

- [ ] BackendMigrationUtils class created with full migration capability
- [ ] CLI command `minsky tasks migrate` implemented
- [ ] Dry-run functionality works correctly
- [ ] Status mapping between backends works properly
- [ ] ID conflict resolution implemented
- [ ] Rollback capability on migration failure
- [ ] Comprehensive test suite covering:
  - Markdown → GitHub Issues migration
  - JSON File → GitHub Issues migration
  - Bidirectional migrations
  - Error scenarios and rollback
- [ ] Documentation with usage examples
- [ ] Integration test demonstrating full workflow

## Priority

High - This is a critical UX feature for users wanting to switch between task backends without losing their existing work. 
