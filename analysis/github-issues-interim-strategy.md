# GitHub Issues Interim Strategy

## Strategic Decision

**Punt the complex task metadata storage question and migrate to GitHub Issues as an interim solution while we focus on other priorities.**

## The Pragmatic Approach

Rather than solving the complex backend architecture question now, we're taking a phased approach:

### Phase 1: GitHub Issues Migration (Immediate)

- Deprecate in-tree task backends (but don't delete code yet)
- Migrate task management to GitHub Issues
- Leverage GitHub's existing metadata capabilities
- Maintain backend abstraction for future flexibility

### Phase 2: Focus on Other Work (Next few months)

- Work on other Minsky priorities
- Gain experience with GitHub Issues approach
- Learn what we actually need from task backends

### Phase 3: Advanced Task Backends (When AI Features Need Them)

- Implement task dependencies and graph support
- Add AI-powered task decomposition features
- Consider Linear, Trello, and other specialized backends
- Make informed decisions based on real requirements

## Why This Makes Sense

### 1. **Reduces Immediate Complexity**

- No need to solve distributed task storage right now
- Leverages proven GitHub Issues infrastructure
- Eliminates special workspace complexity immediately

### 2. **Provides Real User Value**

- GitHub Issues are familiar to developers
- Rich markdown support for task specifications
- Built-in collaboration and discussion features
- Native integration with code repositories

### 3. **Preserves Future Options**

- Backend abstraction layer remains
- Can add specialized backends when needed
- Real experience will inform better architectural decisions
- Code preservation allows learning from existing implementation

### 4. **Aligns with AI Requirements**

When we implement AI features like task decomposition, we'll have:

- Real requirements for task relationships and metadata
- Understanding of performance needs
- Experience with GitHub Issues limitations
- Clear justification for specialized backends

## Implementation Strategy

### GitHub Issues as Primary Backend

```typescript
// Focus on GitHub Issues backend implementation
interface GitHubIssuesBackend extends TaskBackend {
  // Leverage GitHub's native capabilities
  createTask(spec: TaskSpec): Promise<GitHubIssue>;
  updateTask(id: number, updates: TaskUpdates): Promise<GitHubIssue>;
  getTask(id: number): Promise<GitHubIssue>;
  listTasks(filters?: TaskFilters): Promise<GitHubIssue[]>;

  // Use GitHub's metadata features
  addLabels(id: number, labels: string[]): Promise<void>;
  setMilestone(id: number, milestone: string): Promise<void>;
  assignUsers(id: number, users: string[]): Promise<void>;
}
```

### Preserve Backend Abstraction

```typescript
// Keep backend abstraction for future flexibility
interface TaskBackend {
  // Core operations all backends must support
  createTask(spec: TaskSpec): Promise<Task>;
  updateTask(id: TaskId, updates: TaskUpdates): Promise<Task>;
  getTask(id: TaskId): Promise<Task>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;

  // Capability detection for future AI features
  getCapabilities(): TaskBackendCapabilities;
}

interface TaskBackendCapabilities {
  supportsTaskRelationships: boolean;
  supportsCustomFields: boolean;
  supportsRealTimeUpdates: boolean;
  supportsVectorSearch: boolean;
  // Will be crucial when implementing AI features
}
```

### Migration Path from In-Tree

```bash
# Deprecate in-tree backends
minsky init --backend github-issues

# Migrate existing tasks
minsky migrate from-intree to-github-issues

# But keep code for learning
# Don't delete special workspace implementation yet
```

## What We Gain

### 1. **Immediate Simplicity**

- No special workspace coordination
- No git commit coordination for task updates
- No performance issues with file operations
- No cross-repository synchronization problems

### 2. **Rich Task Specifications**

- Full markdown support with images, code blocks
- Discussion threads for task clarification
- Reaction and feedback systems
- Link to code changes and PRs naturally

### 3. **Native Developer Workflows**

- Issues integrate with PR workflows
- Familiar GitHub interface and notifications
- Existing permission and access control
- Built-in search and filtering

### 4. **Foundation for AI Features**

- GitHub API provides programmatic access
- Can add metadata as issue comments or labels
- Rich content for AI analysis
- Clear upgrade path to specialized backends

## What We Defer

### 1. **Complex Task Relationships**

- Parent-child relationships (use GitHub references for now)
- Task dependencies and blocking relationships
- Complex task graphs and hierarchy visualization

### 2. **Advanced Metadata**

- Custom fields beyond GitHub's native support
- Complex task scoring and analysis
- Vector embeddings for semantic search

### 3. **Specialized Backends**

- Linear integration for project management teams
- Trello integration for kanban workflows
- Specialized database backends for complex queries

## When to Revisit

**Trigger conditions for Phase 3:**

1. **AI Task Decomposition**: When implementing features from `add-ai-task-management-subcommands.md`
2. **Task Graph Requirements**: When we need complex task relationships
3. **Performance Issues**: If GitHub Issues prove too slow for AI workflows
4. **Team Scaling**: When GitHub Issues limitations block team productivity

## Interim Architecture

```typescript
// Simplified architecture for interim period
class MinskyCLI {
  constructor(
    private taskBackend: GitHubIssuesBackend,
    private aiService: AICompletionService
  ) {}

  // Focus on core task operations with GitHub Issues
  async createTask(spec: string): Promise<void> {
    const issue = await this.taskBackend.createTask({
      title: extractTitle(spec),
      body: spec,
      labels: ["minsky-task"],
    });

    console.log(`Created task: ${issue.html_url}`);
  }

  // Defer complex AI features until we have proper backend
  async decomposeTask(taskId: number): Promise<void> {
    throw new Error("Task decomposition requires advanced backend - coming in Phase 3");
  }
}
```

## Benefits of This Approach

### 1. **Faster Progress**

- Focus on other Minsky priorities
- No complex backend decision paralysis
- Real user value with GitHub Issues

### 2. **Informed Future Decisions**

- Learn from actual GitHub Issues usage
- Understand real requirements for AI features
- Make backend decisions based on experience

### 3. **Preserved Investment**

- Keep existing code for reference
- Backend abstraction allows easy migration
- Special workspace learnings inform future architecture

### 4. **User Experience**

- Familiar GitHub workflow
- Rich task specifications
- Native developer integration

## Conclusion

This interim strategy is pragmatic and focused:

1. **Short term**: GitHub Issues for immediate value
2. **Medium term**: Focus on other Minsky priorities
3. **Long term**: Informed backend decisions when AI features need them

It reduces complexity now while preserving future options and ensures we make architectural decisions based on real requirements rather than theoretical concerns.

**The key insight**: We don't need to solve the complex backend question until we actually implement features that require it.
