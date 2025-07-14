# Task #277: Implement Stacked PR Workflow for Session Dependencies

**Status:** TODO
**Type:** Enhancement
**Priority:** High
**Dependencies:** None
**Related:** Task #144, Task #174, Task #213

## Description

Implement a stacked PR workflow that allows sessions to be created from existing session branches instead of always starting from the main branch. This enables a development workflow where features can be built incrementally on top of each other before the base features are merged.

## Current State Analysis

Currently, Minsky sessions:
- Always start from the main/default branch
- Create isolated branches for each session
- Use `session update` to merge latest changes from main
- Create PRs that target main branch
- Have no concept of session dependencies

## Requirements

### 1. Base Branch Selection for Session Creation

Extend `session start` to support starting from existing session branches:

```bash
# Current behavior (always from main)
minsky session start --task 123

# New behavior - start from existing session branch
minsky session start --task 124 --base-session task#123
minsky session start --task 124 --base-branch task#123
```

**Implementation Details:**
- Add `--base-session` and `--base-branch` parameters to session start
- Validate that base session/branch exists before creating new session
- Update session record schema to include `baseBranch` and `baseSession` fields
- Ensure base branch is up to date before creating new session

### 2. Session Dependency Tracking

Track session dependencies in session records:

```typescript
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  branch?: string;
  baseBranch?: string;        // NEW: base branch this session was created from
  baseSession?: string;       // NEW: base session this session depends on
  dependentSessions?: string[]; // NEW: sessions that depend on this session
  // ... existing fields
}
```

**Features:**
- Automatically detect and store dependency relationships
- Prevent circular dependencies
- Provide dependency visualization commands
- Support querying dependency chains

### 3. Enhanced Session Update Strategy

Modify `session update` to handle stacked workflows:

```bash
# Update from base session instead of main
minsky session update --from-base

# Update entire dependency chain
minsky session update --cascade

# Update from main (current behavior, becomes explicit)
minsky session update --from-main
```

**Implementation Details:**
- Default behavior: update from base session if it exists, otherwise from main
- Add `--from-base`, `--from-main`, and `--cascade` options
- Handle conflicts when base session has been updated
- Provide clear conflict resolution guidance for stacked scenarios

### 4. Stacked PR Workflow

Extend PR creation to support stacked workflows:

```bash
# Create PR targeting base session branch
minsky session pr --target-base

# Create PR targeting main (current behavior)
minsky session pr --target-main

# Create entire PR stack
minsky session pr --create-stack
```

**Features:**
- PRs target their base session branch by default
- Support creating entire PR stacks in one command
- Maintain PR descriptions that reference dependencies
- Handle PR approval cascading (approve base PRs first)

### 5. Session Approval Enhancements

Extend session approval to handle stacked workflows:

```bash
# Approve session and cascade to dependents
minsky session approve --cascade

# Approve only if base sessions are approved
minsky session approve --check-dependencies
```

**Implementation Details:**
- Check that base sessions are approved before allowing approval
- Support cascading approvals for entire stacks
- Provide clear feedback about approval prerequisites
- Handle cleanup of dependency relationships after approval

### 6. Dependency Visualization and Management

Add commands to visualize and manage session dependencies:

```bash
# Show dependency tree
minsky session deps --tree

# Show sessions that depend on current session
minsky session deps --dependents

# Show what current session depends on
minsky session deps --dependencies

# Rebase session onto new base
minsky session rebase --new-base task#125
```

### 7. Configuration and Safety

Add configuration options for stacked workflow behavior:

```yaml
# In config files
session:
  stacked:
    enabled: true
    defaultUpdateBehavior: "from-base" # or "from-main"
    requireExplicitBase: false
    maxStackDepth: 5
    autoRebaseOnBaseUpdate: false
```

**Safety Features:**
- Validate dependency chains don't exceed max depth
- Prevent operations that would break dependent sessions
- Provide rollback mechanisms for failed stack operations
- Clear error messages for dependency conflicts

## Implementation Plan

### Phase 1: Basic Stacked Session Creation
1. Add base branch/session parameters to session start
2. Extend session record schema
3. Implement dependency tracking
4. Add basic validation

### Phase 2: Enhanced Update Strategy
1. Modify session update to use base branch
2. Add update options (--from-base, --from-main, --cascade)
3. Implement conflict resolution for stacked scenarios
4. Add tests for various update scenarios

### Phase 3: Stacked PR Workflow
1. Modify PR creation to target base branches
2. Add stack-aware PR descriptions
3. Implement PR stack creation
4. Add approval dependency checking

### Phase 4: Visualization and Management
1. Add dependency visualization commands
2. Implement session rebase functionality
3. Add dependency management tools
4. Create comprehensive documentation

### Phase 5: Advanced Features
1. Add configuration options
2. Implement cascading operations
3. Add rollback mechanisms
4. Performance optimization for large stacks

## Testing Strategy

### Unit Tests
- Session creation with base branches
- Dependency tracking and validation
- Update strategy selection
- PR targeting logic

### Integration Tests
- End-to-end stacked workflow scenarios
- Conflict resolution workflows
- Cascading operations
- Error handling and rollback

### Performance Tests
- Large dependency chains
- Concurrent operations on stacked sessions
- Memory usage with complex dependency graphs

## Migration Strategy

### Backward Compatibility
- Existing sessions continue to work without changes
- New features are opt-in via explicit parameters
- Default behavior remains unchanged for existing workflows

### Data Migration
- Add new fields to session records with default values
- Migrate existing sessions to have `baseBranch: "main"`
- Provide migration script for existing session databases

## Documentation Requirements

### User Documentation
- Tutorial on stacked PR workflows
- Best practices for managing session dependencies
- Troubleshooting guide for common stacked scenarios
- Examples of complex dependency chains

### Developer Documentation
- Architecture overview of dependency tracking
- API documentation for new session interfaces
- Testing guide for stacked workflows
- Extension points for custom dependency behaviors

## Success Criteria

1. **Functional Requirements Met:**
   - Sessions can be created from existing session branches
   - Dependencies are tracked and visualized
   - PRs target appropriate base branches
   - Approval workflows respect dependencies

2. **User Experience:**
   - Clear error messages for dependency conflicts
   - Intuitive command structure
   - Smooth migration from current workflows
   - Comprehensive documentation

3. **Technical Quality:**
   - Robust dependency validation
   - Efficient dependency graph operations
   - Comprehensive test coverage
   - Backward compatibility maintained

4. **Performance:**
   - Operations scale with dependency graph size
   - Memory usage remains reasonable
   - No significant performance regression for simple workflows

## Risks and Mitigation

### Technical Risks
- **Complexity**: Stacked workflows add significant complexity
  - *Mitigation*: Phased implementation, comprehensive testing
- **Performance**: Large dependency graphs could impact performance
  - *Mitigation*: Efficient graph algorithms, caching, limits
- **Data Integrity**: Dependency tracking could become inconsistent
  - *Mitigation*: Transactional operations, validation, repair tools

### User Experience Risks
- **Confusion**: Users might create overly complex dependency chains
  - *Mitigation*: Clear documentation, sensible defaults, warnings
- **Migration Issues**: Existing users might have trouble adapting
  - *Mitigation*: Backward compatibility, migration guides, optional features

### Operational Risks
- **Debugging**: Complex dependency chains could be hard to debug
  - *Mitigation*: Comprehensive logging, visualization tools, debugging commands
- **Recovery**: Failed operations could leave sessions in inconsistent state
  - *Mitigation*: Rollback mechanisms, repair tools, validation

## Future Enhancements

1. **GitHub Integration**: Map stacked sessions to GitHub PR stacks
2. **Parallel Development**: Support multiple parallel dependency chains
3. **Automatic Rebasing**: Auto-rebase sessions when base changes
4. **Conflict Prediction**: Predict conflicts before they occur
5. **Team Collaboration**: Share dependency graphs across team members
6. **CI/CD Integration**: Trigger builds for entire dependency chains

## Related Tasks

- **Task #144**: PR workflow improvements (foundation for stacked PRs)
- **Task #174**: Session PR workflow architecture review
- **Task #213**: Configurable default branch (needed for base branch selection)
- **Task #025**: Git approve command (approval workflow foundation)
