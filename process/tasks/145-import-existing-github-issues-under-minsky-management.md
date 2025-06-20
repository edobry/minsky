# Import Existing GitHub Issues Under Minsky Management

## Context

When teams switch to using Minsky with the GitHub Issues backend, they often have existing GitHub issues that they want to bring under Minsky management. Currently, the GitHub Issues backend only manages issues that it creates with Minsky-specific labels.

This task focuses on providing functionality to import and manage existing GitHub issues that were created outside of Minsky.

## Requirements

1. **Issue Discovery**: Scan existing GitHub issues in a repository
2. **Selective Import**: Allow users to choose which issues to import
3. **Label Management**: Apply Minsky status labels to imported issues
4. **Status Mapping**: Map existing issue states to Minsky status conventions
5. **Task Spec Generation**: Create local task specification files for imported issues
6. **Conflict Resolution**: Handle issues that might conflict with existing Minsky tasks

## Implementation Details

### Core Import Function
```typescript
async function importExistingGitHubIssues(options: {
  repository: string;
  filterCriteria?: {
    state?: 'open' | 'closed' | 'all';
    labels?: string[];
    assignee?: string;
    since?: Date;
  };
  importStrategy: 'all' | 'selective';
  statusMapping?: Record<string, string>;
}): Promise<ImportResult>
```

### CLI Integration
```bash
# Import all open issues
minsky tasks import --backend github-issues --filter state=open

# Selective import with preview
minsky tasks import --backend github-issues --interactive

# Import with custom status mapping
minsky tasks import --backend github-issues --map-status closed=DONE
```

### Status Mapping Strategy
- Open issues → TODO (default)
- Closed issues → DONE (default)
- Issues with specific labels → Custom mapping
- Issues in specific milestones → Custom mapping

## Acceptance Criteria

- [ ] Issue discovery functionality scans repository for existing issues
- [ ] Interactive mode allows selective import of issues
- [ ] Automatic label application for Minsky status tracking
- [ ] Task specification files generated for imported issues
- [ ] Status mapping between GitHub states and Minsky conventions
- [ ] Conflict resolution for duplicate or overlapping issues
- [ ] CLI integration with `minsky tasks import` command
- [ ] Comprehensive logging of import process
- [ ] Rollback capability for failed imports
- [ ] Documentation with usage examples

## Priority

Medium - Important for teams migrating to Minsky GitHub backend integration. 
