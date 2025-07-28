# Updated AI Task Management Spec (GitHub Issues Interim Approach)

## Context Changes Based on Backend Strategy

Following the architectural decision to use GitHub Issues as interim backend (ADR-001), this spec needs updates to reflect the new approach:

### Original Dependencies (Now Changed)

- ~~Task #235: Metadata support research~~ → **Deferred to Phase 3**
- ~~Task #246/247: Hierarchy system~~ → **Use GitHub Issues references interim**
- Task #160: AI backend infrastructure → **Still required**

### New Approach

- Use GitHub Issues for task storage and basic relationships
- Implement AI features within GitHub Issues capabilities
- Plan for advanced backend when complex features needed

## Updated Implementation Strategy

### Phase 1: GitHub Issues + Basic AI (Immediate)

#### Core AI Commands (Updated for GitHub Issues)

1. **`minsky tasks decompose <issue-number>`**

   ```bash
   # Analyze GitHub Issue and suggest breakdown
   minsky tasks decompose 123

   # Create subtasks as new GitHub Issues with references
   minsky tasks decompose 123 --create
   ```

2. **`minsky tasks estimate <issue-number>`**

   ```bash
   # AI-powered estimation using GitHub Issue content
   minsky tasks estimate 456
   ```

3. **`minsky tasks analyze <issue-number>`**
   ```bash
   # Comprehensive analysis of GitHub Issue
   minsky tasks analyze 789 --suggest-improvements
   ```

#### GitHub Issues Integration

```typescript
interface GitHubAITaskManager {
  // Decompose GitHub Issue into subtasks
  async decomposeTask(issueNumber: number): Promise<DecompositionSuggestion> {
    const issue = await github.issues.get({ issue_number: issueNumber });
    const decomposition = await ai.decomposeTask(issue.body);

    return {
      subtasks: decomposition.subtasks,
      relationships: decomposition.relationships,
      githubCreationPlan: decomposition.githubCreationPlan
    };
  }

  // Create subtasks as GitHub Issues with proper references
  async createSubtasks(parentIssue: number, subtasks: SubtaskSpec[]): Promise<void> {
    for (const subtask of subtasks) {
      const createdIssue = await github.issues.create({
        title: subtask.title,
        body: `${subtask.description}\n\n**Parent Task**: #${parentIssue}`,
        labels: ['minsky-subtask', `parent-${parentIssue}`]
      });

      // Add reference to parent issue
      await github.issues.createComment({
        issue_number: parentIssue,
        body: `**Subtask Created**: #${createdIssue.number} - ${subtask.title}`
      });
    }
  }
}
```

#### Task Relationships with GitHub Issues

```typescript
// Use GitHub's native capabilities for relationships
interface GitHubTaskRelationships {
  // Parent-child via issue references and labels
  parentTask?: number; // Referenced in issue body
  childTasks: number[]; // Found via label queries

  // Dependencies via issue references
  blockedBy: number[]; // "Blocked by #123"
  blocks: number[]; // "Blocks #456"

  // Related tasks via labels and references
  relatedTasks: number[]; // Cross-referenced issues
}

// Query relationships using GitHub API
async function getTaskHierarchy(rootIssue: number): Promise<TaskTree> {
  // Find subtasks via labels
  const subtasks = await github.search.issuesAndPullRequests({
    q: `repo:${repo} label:parent-${rootIssue} is:issue`,
  });

  // Build hierarchy recursively
  return buildTaskTree(rootIssue, subtasks.data.items);
}
```

### Phase 2: Enhanced AI Features (3-6 months)

#### Test Decomposition for GitHub Issues

```bash
# Specialized test decomposition
minsky tasks decompose-tests 123 --create

# Creates structured test hierarchy:
# - Unit Tests (Issue #124)
#   - Test user authentication (Issue #125)
#   - Test password validation (Issue #126)
# - Integration Tests (Issue #127)
#   - Test login flow (Issue #128)
# - E2E Tests (Issue #129)
#   - Test complete registration (Issue #130)
```

#### Chain-of-Thought Monitoring

```typescript
// Monitor AI reasoning during GitHub Issues decomposition
interface ChainOfThoughtMonitor {
  async monitorDecomposition(issue: GitHubIssue): Promise<void> {
    const reasoningTrace = await ai.decomposeWithMonitoring(issue.body);

    // Real-time monitoring of AI reasoning
    reasoningTrace.on('reasoning-step', (step) => {
      console.log(`AI Reasoning: ${step.description}`);
      console.log(`Confidence: ${step.confidence}`);

      // Allow human intervention
      if (step.confidence < 0.7) {
        const intervention = await promptForIntervention(step);
        if (intervention) {
          reasoningTrace.redirect(intervention);
        }
      }
    });

    // Create issues with reasoning metadata
    const decomposition = await reasoningTrace.complete();
    await createSubtasksWithReasoningTrace(issue.number, decomposition);
  }
}
```

### Phase 3: Advanced Backend Migration (When Needed)

#### Trigger Conditions

- Complex task graph visualization needed
- Performance issues with GitHub API rate limits
- Advanced vector search for semantic task discovery
- Real-time collaboration on task decomposition

#### Migration Strategy

```typescript
// When GitHub Issues limitations hit, migrate to specialized backend
interface AdvancedTaskBackend {
  // Import from GitHub Issues
  async importFromGitHub(issues: GitHubIssue[]): Promise<void>;

  // Advanced AI capabilities
  async storeTaskEmbeddings(taskId: string, embeddings: number[]): Promise<void>;
  async semanticTaskSearch(query: string): Promise<Task[]>;
  async analyzeTaskGraph(rootTaskId: string): Promise<TaskGraphAnalysis>;

  // Real-time collaboration
  async subscribeToTaskChanges(callback: (change: TaskChange) => void): Promise<void>;
}
```

## Updated Implementation Steps

### Phase 1: GitHub Issues Foundation (Month 1-2)

1. **GitHub Issues Backend**: Implement full GitHub Issues integration
2. **Basic AI Commands**: `decompose`, `estimate`, `analyze` working with GitHub Issues
3. **Relationship Mapping**: Use GitHub references and labels for task hierarchies
4. **Migration from In-Tree**: Tools to migrate existing tasks to GitHub Issues

### Phase 2: Enhanced AI Features (Month 3-6)

1. **Test Decomposition**: Specialized test hierarchy creation
2. **Chain-of-Thought**: Real-time AI reasoning monitoring
3. **Batch Operations**: Analyze and decompose multiple issues
4. **Learning Integration**: AI learns from GitHub Issue patterns

### Phase 3: Advanced Backend (Month 6+, when needed)

1. **Trigger Assessment**: Evaluate GitHub Issues limitations
2. **Backend Selection**: Choose specialized backend (Linear, database, etc.)
3. **Migration Tools**: Smooth transition from GitHub Issues
4. **Advanced Features**: Full task graph visualization, vector search

## Benefits of GitHub Issues Interim Approach

### Immediate Benefits

- **Familiar Interface**: Developers already know GitHub Issues
- **Rich Content**: Full markdown with images, code examples
- **Native Integration**: Works with PR workflows and code review
- **Zero Setup**: No complex backend configuration

### AI Feature Enablement

- **Content Analysis**: Rich GitHub Issue content for AI processing
- **Relationship Tracking**: Via references and labels
- **Collaboration**: Built-in discussion and comment system
- **API Integration**: Robust GitHub API for programmatic access

### Future Flexibility

- **Backend Abstraction**: Easy migration when advanced features needed
- **Learning Period**: Understand real requirements before complex backend decisions
- **Gradual Enhancement**: Add capabilities as user needs become clear

## Limitations and Workarounds

### GitHub Issues Limitations

- **Complex Relationships**: No native parent-child hierarchy
- **Custom Fields**: Limited metadata beyond labels/milestones
- **Rate Limits**: API restrictions for heavy usage
- **Offline Access**: Requires internet connectivity

### Interim Workarounds

- **Relationships**: Use issue references and labels
- **Metadata**: Store in issue body or comments
- **Rate Limits**: Implement caching and batch operations
- **Offline**: Focus on online AI workflows initially

### Migration Triggers

- Performance issues with GitHub API
- Need for complex task graph visualization
- Advanced vector search requirements
- Real-time collaboration limitations

## Conclusion

This updated approach provides:

1. **Immediate Value**: AI features working with familiar GitHub Issues
2. **Gradual Enhancement**: Add complexity only when needed
3. **Future Flexibility**: Clear migration path to advanced backends
4. **User Experience**: Familiar workflow with enhanced AI capabilities

The GitHub Issues interim strategy allows us to:

- Implement AI task management features immediately
- Learn real requirements before complex architectural decisions
- Provide excellent user experience with familiar tools
- Preserve future options for specialized backends

**Key insight**: We can deliver significant AI-powered value using GitHub Issues while deferring complex backend architecture decisions until we have real requirements from actual usage.
