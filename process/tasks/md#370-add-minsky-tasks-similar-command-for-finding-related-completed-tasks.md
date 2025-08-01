# Add minsky tasks similar command for finding related completed tasks

## Context

# Add `minsky tasks similar` command for finding related completed tasks

## Problem Statement

When working on new tasks, developers often need to reference similar tasks that have been completed previously to understand patterns, approaches, and implementation strategies. Currently, finding related tasks requires manual searching through task history, which is time-consuming and may miss relevant examples.

## Context

This task is extracted from **Task #175: Add AI-powered task management subcommands** to focus specifically on implementing the `tasks similar` command. This functionality will:

1. Help developers find similar completed tasks for reference
2. Assist with estimation by showing comparable work
3. Support approach planning by revealing patterns from past implementations
4. Improve knowledge sharing and consistency across the team

## Dependencies

This task depends on **Task #160: Add AI completion backend with multi-provider support**, which provides:

- Multi-provider AI abstraction layer (OpenAI, Anthropic, etc.)
- Tool calling and function execution capabilities
- Prompt caching and reasoning model support
- Configuration system for API keys and provider selection
- Error handling and logging patterns

## Proposed Solution

Implement `minsky tasks similar <task-id>` command that:

### Core Functionality

1. **Analyzes the target task** to understand its key characteristics:

   - Task description and requirements
   - Technical domain (e.g., CLI, backend, testing)
   - Implementation patterns mentioned
   - Complexity indicators

2. **Searches completed tasks** using AI-powered similarity matching:

   - Semantic similarity of task descriptions
   - Technical domain overlap
   - Implementation approach patterns
   - Historical complexity comparisons

3. **Returns ranked results** with:
   - Similarity score/confidence
   - Brief explanation of why tasks are similar
   - Links to task specifications and implementations
   - Estimated effort comparison if available

### Command Interface

```bash
# Find similar tasks to a specific task
minsky tasks similar <task-id>

# Options to consider
minsky tasks similar <task-id> --limit 5        # Limit number of results
minsky tasks similar <task-id> --min-score 0.7  # Minimum similarity threshold
minsky tasks similar <task-id> --domain cli     # Filter by technical domain
```

### Output Format

```
Similar tasks to #175 (Add AI-powered task management subcommands):

1. Task #160: Add AI completion backend (Score: 0.85)
   Domain: Backend/AI
   Similarity: Both involve AI integration and backend service architecture
   Status: DONE | Effort: Large

2. Task #125: Implement session management commands (Score: 0.72)
   Domain: CLI/Commands
   Similarity: Both add new CLI subcommands with complex workflows
   Status: DONE | Effort: Medium

3. Task #98: Add task status management (Score: 0.68)
   Domain: Tasks/CLI
   Similarity: Both extend task management functionality
   Status: DONE | Effort: Small
```

## Technical Approach

1. **AI Service Integration**:

   - Build on existing AI backend from Task #160
   - Create task similarity analysis service
   - Use embeddings or semantic comparison for similarity scoring

2. **Task Analysis**:

   - Extract key features from task specifications
   - Normalize task descriptions for comparison
   - Weight different aspects (domain, complexity, patterns)

3. **Search Implementation**:

   - Query task storage for completed tasks
   - Apply AI-powered similarity analysis
   - Rank and filter results based on relevance

4. **Command Structure**:
   - Add under `src/commands/tasks/` following existing patterns
   - Integrate with existing task management infrastructure
   - Provide clear, actionable output format

## Implementation Steps

**Prerequisites**: Task #160 (AI completion backend) must be completed first.

1. **Design similarity analysis prompts** optimized for task comparison
2. **Implement core similarity service** using the AI backend
3. **Add `similar` command** under tasks command group
4. **Integrate with task storage** to query completed tasks
5. **Add ranking and filtering logic** for search results
6. **Design output formatting** for clear, useful results
7. **Add comprehensive tests** including AI interaction testing
8. **Document usage patterns** and best practices

## Acceptance Criteria

- [ ] **Task #160 (AI completion backend) is completed** and available
- [ ] **`minsky tasks similar <task-id>` command** is implemented and functional
- [ ] **AI-powered similarity analysis** provides meaningful, ranked results
- [ ] **Command integrates** with existing task storage and retrieval systems
- [ ] **Output format** is clear, informative, and actionable
- [ ] **Results include** similarity scores and explanations
- [ ] **Command supports** basic filtering and limiting options
- [ ] **Error handling** covers invalid task IDs and AI service failures
- [ ] **Performance** is acceptable for typical task database sizes
- [ ] **Tests cover** various similarity scenarios and edge cases
- [ ] **Documentation** includes examples and usage guidelines

## Future Considerations

- Support for similarity search across multiple tasks simultaneously
- Integration with task estimation based on similar task efforts
- Learning from user feedback to improve similarity algorithms
- Cross-repository task similarity (when multi-repo support exists)
- Integration with task decomposition to find similar subtasks
- Historical analysis of which similar tasks were actually helpful

## Relationship to Task #175

This task is extracted from the larger Task #175 to enable focused implementation. Once completed, it can be integrated back into the broader AI-powered task management suite or remain as a standalone feature based on user feedback and usage patterns.

## Requirements

## Solution

## Notes
