# ADR-001: GitHub Issues Interim Strategy with Future Backend Flexibility

## Status
Approved

## Context

Minsky's task management system faced a complex architectural decision between in-tree backends and database backends. After comprehensive analysis, we identified that:

1. **AI-first architecture** requires database capabilities for advanced features
2. **Immediate complexity** of backend decisions was blocking progress on other priorities  
3. **Real requirements unclear** until we implement AI features that need task relationships
4. **GitHub Issues** provides excellent interim solution with familiar developer workflows

Rather than solving the complex backend architecture question immediately, we're adopting a phased approach that defers complexity until it's actually needed.

## Decision

**Adopt GitHub Issues as interim task backend while preserving future architectural flexibility through backend abstraction.**

### Specific Decisions:

1. **Immediate Migration**: Migrate from in-tree backends to GitHub Issues
2. **Deprecate In-Tree**: Mark in-tree backends as deprecated (but preserve code for learning)
3. **Backend Abstraction**: Maintain backend abstraction layer for future flexibility
4. **Defer Complexity**: Make advanced backend decisions when implementing AI features
5. **Focus Shift**: Work on other Minsky priorities while gaining GitHub Issues experience

## Rationale

### 1. Pragmatic Phasing
- **Phase 1**: GitHub Issues for immediate value and simplified architecture
- **Phase 2**: Focus on other Minsky priorities and gain experience
- **Phase 3**: Implement advanced backends when AI features require them

### 2. GitHub Issues Benefits
- **Familiar workflows**: Developers already understand GitHub Issues
- **Rich specifications**: Full markdown with images, code blocks, discussions
- **Native integration**: Works naturally with code repositories and PRs
- **Proven infrastructure**: Reliable, scalable, feature-rich platform

### 3. Complexity Deferral
- **No premature optimization**: Wait for real requirements from AI features
- **Learning opportunity**: Understand GitHub Issues limitations through usage
- **Informed decisions**: Make backend choices based on experience, not theory

### 4. Future Flexibility Preserved
- **Backend abstraction**: Clean interface allows easy migration
- **Code preservation**: Keep existing implementations for reference
- **Capability detection**: Framework ready for specialized backends

## Implementation Strategy

### GitHub Issues Backend
```typescript
interface GitHubIssuesBackend extends TaskBackend {
  // Leverage GitHub's native capabilities
  createTask(spec: TaskSpec): Promise<GitHubIssue>;
  updateTask(id: number, updates: TaskUpdates): Promise<GitHubIssue>;
  
  // Use GitHub metadata features
  addLabels(id: number, labels: string[]): Promise<void>;
  setMilestone(id: number, milestone: string): Promise<void>;
  assignUsers(id: number, users: string[]): Promise<void>;
}
```

### Backend Abstraction Preservation
```typescript
interface TaskBackend {
  // Core operations all backends must support
  createTask(spec: TaskSpec): Promise<Task>;
  updateTask(id: TaskId, updates: TaskUpdates): Promise<Task>;
  
  // Capability detection for future AI features
  getCapabilities(): TaskBackendCapabilities;
}

interface TaskBackendCapabilities {
  supportsTaskRelationships: boolean;
  supportsCustomFields: boolean;
  supportsVectorSearch: boolean;
  supportsRealTimeUpdates: boolean;
}
```

## Migration Plan

### From In-Tree Backends
```bash
# Migrate existing tasks to GitHub Issues
minsky migrate from-intree to-github-issues --repo owner/repo

# Update configuration
minsky config set backend github-issues
minsky config set github.repo owner/repo
```

### Deprecation Strategy
- Mark in-tree backends as deprecated
- Add warnings when using in-tree backends
- Preserve code until migration complete and stable
- Document migration path clearly

## Future Backend Integration

### When AI Features Need Advanced Capabilities
```typescript
// Example: When implementing task decomposition
interface AdvancedTaskBackend extends TaskBackend {
  // Task relationship support
  createSubtask(parentId: TaskId, spec: TaskSpec): Promise<Task>;
  getTaskHierarchy(rootId: TaskId): Promise<TaskTree>;
  
  // AI-specific capabilities
  storeEmbeddings(taskId: TaskId, embeddings: number[]): Promise<void>;
  semanticSearch(query: string): Promise<Task[]>;
  
  // Real-time collaboration
  subscribeToUpdates(callback: (update: TaskUpdate) => void): Promise<void>;
}
```

### Potential Future Backends
- **Linear**: For project management focused teams
- **Trello**: For kanban workflow teams  
- **Specialized Database**: For complex AI features and task graphs
- **Notion**: For rich documentation and collaboration

## Consequences

### Positive
- ✅ **Immediate simplicity**: No complex backend decisions blocking progress
- ✅ **Familiar workflows**: Developers understand GitHub Issues
- ✅ **Rich specifications**: Full markdown support with discussions
- ✅ **Native integration**: Works with existing GitHub workflows
- ✅ **Future flexibility**: Backend abstraction preserves options
- ✅ **Focus shift**: Can work on other Minsky priorities

### Negative
- ❌ **Limited relationships**: GitHub Issues don't natively support complex task hierarchies
- ❌ **API rate limits**: GitHub API limitations for heavy usage
- ❌ **Vendor lock-in**: Temporary dependence on GitHub platform
- ❌ **Future migration**: Will need to migrate again when implementing AI features

### Mitigation
- Maintain backend abstraction for easy future migration
- Document GitHub Issues limitations and workarounds
- Plan for specialized backend implementation when AI features require it
- Preserve existing code for reference and learning

## Success Criteria

### Immediate (Phase 1)
- [ ] GitHub Issues backend fully functional
- [ ] Migration tools from in-tree backends
- [ ] Backend abstraction layer maintained
- [ ] In-tree backends marked deprecated

### Medium Term (Phase 2)  
- [ ] Stable GitHub Issues workflow
- [ ] Understanding of limitations and requirements
- [ ] Progress on other Minsky priorities
- [ ] Clear plan for Phase 3 backend decisions

### Long Term (Phase 3)
- [ ] Advanced backend capabilities when needed
- [ ] Smooth migration from GitHub Issues
- [ ] AI features working with appropriate backends
- [ ] Learned lessons applied to backend design

## Review Points

### Trigger Conditions for Phase 3
1. **AI Task Decomposition**: When implementing `add-ai-task-management-subcommands.md`
2. **Task Graph Features**: When complex task relationships become required
3. **Performance Issues**: If GitHub Issues prove inadequate for AI workflows
4. **User Feedback**: If GitHub Issues limitations block team productivity

### Decision Review Timeline
- **3 months**: Evaluate GitHub Issues experience and limitations
- **6 months**: Assess readiness for AI features requiring advanced backends
- **12 months**: Full architectural review based on real usage patterns

## References

- Task #325: Task Backend Architecture Analysis
- `add-ai-task-management-subcommands.md`: Future AI features requiring advanced backends
- GitHub Issues API documentation
- Backend abstraction layer design