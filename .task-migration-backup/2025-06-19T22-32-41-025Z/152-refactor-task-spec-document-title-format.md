# Task #152: Refactor Task Spec Document Title Format

## Context

Currently, task specification documents include the task number in both the filename AND within the document title (e.g., `# Task #151: Fix Task Create Command`). This creates unnecessary duplication and couples the document content to the task numbering system. We want to simplify this by:

1. **Removing task numbers from document titles** - The title within the document should be clean and descriptive without task numbers
2. **Keeping task numbers in filenames and tasks.md** - External references will still use task numbers for organization
3. **Updating all existing task documents** - Migrate all existing local task specifications to the new format

This change will make task specifications more portable, cleaner to read, and reduce coupling between content and numbering systems.

## Current State Analysis

Based on codebase analysis, the current system:

- **Document titles**: `# Task #151: Fix Task Create Command Content Truncation Issue`
- **Filenames**: `151-fix-task-create-command-content-truncation-issue.md`
- **tasks.md entries**: `- [x] Fix Task Create Command Content Truncation Issue [#151](process/tasks/151-fix-task-create-command-content-truncation-issue.md)`

The desired new format:

- **Document titles**: `# Fix Task Create Command Content Truncation Issue`
- **Filenames**: `151-fix-task-create-command-content-truncation-issue.md`
- **tasks.md entries**: `- [x] Fix Task Create Command Content Truncation Issue [#151](process/tasks/151-fix-task-create-command-content-truncation-issue.md)`

## Requirements

### 1. Update Task Creation Logic

- **Modify `src/domain/tasks/taskService.ts`**: Update `createTask` method to generate titles without task numbers
- **Modify `src/domain/tasks/taskFunctions.ts`**: Update `formatTaskSpecToMarkdown` to use clean titles
- **Modify `src/domain/tasks.ts`**: Update `MarkdownTaskBackend.createTask` to handle new title format
- **Update parsing logic**: Modify `parseTaskSpecFromMarkdown` to handle both old and new formats during transition

### 2. Update Task Reading/Parsing Logic

- **Support both formats**: During transition, support reading both `# Task #XXX: Title` and `# Title` formats
- **Update `parseTaskSpecFromMarkdown`**: Modify to extract clean titles regardless of format
- **Update GitHub Issues backend**: Modify `src/domain/tasks/githubIssuesTaskBackend.ts` to handle new format
- **Update JSON File backend**: Modify `src/domain/tasks/jsonFileTaskBackend.ts` accordingly

### 3. Create Migration Script

- **Bulk update utility**: Create a script to update all existing task specification documents
- **Preserve content**: Only modify the title line, preserve all other content exactly
- **Handle edge cases**: Deal with various title formats that may exist
- **Backup and rollback**: Provide safety mechanisms in case of issues

### 4. Update Related Systems

- **Update tests**: Modify all tests that expect the old title format
- **Update documentation**: Update `.cursor/rules/creating-tasks.mdc` and other relevant docs
- **Update CLI output**: Ensure commands that display task titles work correctly
- **Update MCP tools**: Ensure MCP server tools handle the new format

### 5. Validation and Testing

- **Comprehensive testing**: Test task creation, reading, listing, and all related operations
- **Backward compatibility**: Ensure system can still read old format during transition
- **Integration testing**: Test CLI commands, MCP server, and all adapters
- **Manual verification**: Verify a sample of migrated tasks manually

## Implementation Steps

### Phase 1: Code Updates

1. [ ] **Update Core Parsing Functions**:

   - [ ] Modify `parseTaskSpecFromMarkdown` to support both formats
   - [ ] Update `formatTaskSpecToMarkdown` to generate clean titles
   - [ ] Add backward compatibility handling

2. [ ] **Update Task Creation Logic**:

   - [ ] Modify `MarkdownTaskBackend.createTask` to generate clean titles
   - [ ] Update content preservation logic to handle new format
   - [ ] Ensure file naming remains unchanged

3. [ ] **Update All Task Backends**:

   - [ ] Update `GitHubIssuesTaskBackend` parsing and formatting
   - [ ] Update `JsonFileTaskBackend` if needed
   - [ ] Ensure consistent behavior across all backends

4. [ ] **Update Related Utilities**:
   - [ ] Update `src/domain/tasks/migration-utils.ts` if needed
   - [ ] Update any other parsing or formatting utilities

### Phase 2: Migration Script

5. [ ] **Create Migration Script**:

   - [ ] Build script to identify all task specification files
   - [ ] Parse each file and extract current title format
   - [ ] Generate new clean title (remove task number prefix)
   - [ ] Update file content preserving everything except title line
   - [ ] Add dry-run mode for testing

6. [ ] **Add Safety Mechanisms**:
   - [ ] Create backup of all files before migration
   - [ ] Add validation to ensure migration was successful
   - [ ] Provide rollback capability if issues are found

### Phase 3: Testing and Validation

7. [ ] **Update Test Suite**:

   - [ ] Update all tests expecting old title format
   - [ ] Add tests for backward compatibility
   - [ ] Add tests for new clean title format
   - [ ] Test migration script thoroughly

8. [ ] **Integration Testing**:
   - [ ] Test all CLI commands with new format
   - [ ] Test MCP server tools
   - [ ] Test task creation, reading, listing, status updates
   - [ ] Test with different task backends

### Phase 4: Migration Execution

9. [ ] **Run Migration**:

   - [ ] Execute migration script on all local task files
   - [ ] Verify migration results
   - [ ] Update any remaining references if found

10. [ ] **Documentation Updates**:
    - [ ] Update `.cursor/rules/creating-tasks.mdc`
    - [ ] Update any other documentation referencing title format
    - [ ] Update README or other guides if applicable

## Technical Details

### Files to Modify

**Core Task Logic:**

- `src/domain/tasks/taskFunctions.ts` - `parseTaskSpecFromMarkdown`, `formatTaskSpecToMarkdown`
- `src/domain/tasks.ts` - `MarkdownTaskBackend.createTask`
- `src/domain/tasks/taskService.ts` - `createTask` method
- `src/domain/tasks/githubIssuesTaskBackend.ts` - `parseTaskSpec`, `formatTaskSpec`
- `src/domain/tasks/jsonFileTaskBackend.ts` - Update if needed

**Testing:**

- `src/domain/tasks.test.ts` - Update title format expectations
- All other test files that create or expect task titles
- Add new tests for backward compatibility

**Documentation:**

- `.cursor/rules/creating-tasks.mdc` - Update examples and workflow
- Any other documentation files

### Migration Script Requirements

```typescript
interface MigrationOptions {
  dryRun: boolean;
  backup: boolean;
  verbose: boolean;
  rollback?: boolean;
}

class TaskTitleMigration {
  async migrateAllTasks(options: MigrationOptions): Promise<MigrationResult>;
  async migrateTask(filePath: string): Promise<TaskMigrationResult>;
  async createBackup(): Promise<string>;
  async rollback(backupId: string): Promise<void>;
  async validateMigration(): Promise<ValidationResult>;
}
```

### Backward Compatibility Strategy

During transition period, support both formats:

```typescript
// OLD: # Task #151: Fix Task Create Command
// NEW: # Fix Task Create Command

const titlePatterns = [
  /^# Task #\d+: (.+)$/, // Old format
  /^# Task: (.+)$/, // Old format without number
  /^# (.+)$/, // New clean format
];
```

## Acceptance Criteria

### Code Changes

- [ ] All task creation generates clean titles without task numbers
- [ ] All task parsing handles both old and new formats correctly
- [ ] All tests updated and passing
- [ ] Backward compatibility maintained during transition

### Migration

- [ ] Migration script successfully updates all existing task files
- [ ] All existing task content preserved except title line
- [ ] Migration can be safely rolled back if needed
- [ ] Comprehensive validation confirms migration success

### System Function

- [ ] All CLI commands work correctly with new format
- [ ] MCP server tools work correctly with new format
- [ ] Task creation, reading, listing, status updates all functional
- [ ] No regression in existing functionality

### Documentation

- [ ] All documentation updated to reflect new format
- [ ] Examples and workflows use new clean title format
- [ ] Migration process documented for future reference

## Testing Strategy

### Unit Testing

- Test `parseTaskSpecFromMarkdown` with both old and new formats
- Test `formatTaskSpecToMarkdown` generates clean titles
- Test task creation with various input formats
- Test all task backends handle new format correctly

### Integration Testing

- Test complete task workflow (create → read → update → list)
- Test CLI commands end-to-end
- Test MCP server integration
- Test with different task backends

### Migration Testing

- Test migration script with various task file formats
- Test backup and rollback functionality
- Test validation mechanisms
- Test edge cases and error handling

### Manual Testing

- Create new tasks and verify clean titles
- Read existing tasks and verify parsing works
- Test CLI commands with migrated tasks
- Verify tasks.md and filename references still work

## Risks and Mitigation

### Data Loss Risk

- **Risk**: Migration could corrupt or lose task content
- **Mitigation**: Comprehensive backup system, dry-run mode, validation

### Breaking Changes Risk

- **Risk**: External systems expecting old format could break
- **Mitigation**: Maintain backward compatibility, gradual rollout

### Performance Risk

- **Risk**: Supporting both formats could slow down parsing
- **Mitigation**: Optimize parsing logic, consider phased removal of old format support

## Success Metrics

- [ ] All ~150+ existing task files successfully migrated
- [ ] Zero content loss during migration
- [ ] All tests passing with new format
- [ ] All CLI commands functional with new format
- [ ] Documentation accurately reflects new format
- [ ] System performance maintained or improved

## Future Considerations

After successful migration and stabilization:

- Consider removing backward compatibility code for old format
- Evaluate if similar cleanup needed for other document formats
- Consider standardizing title formats across other document types
