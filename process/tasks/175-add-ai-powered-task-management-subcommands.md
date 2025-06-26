# Add AI-powered task management subcommands

## Problem Statement

To improve task management workflow and enable AI-assisted backlog management, we need to add several new subcommands to the `minsky tasks` command that leverage AI capabilities for estimation, decomposition, and other task management operations.

## Context

Currently, task management in Minsky is primarily manual. Adding AI-powered capabilities will help:

1. Estimate task complexity and effort more consistently
2. Break down complex tasks into manageable subtasks
3. Improve backlog grooming and planning processes
4. Gather data about task patterns and workflow efficiency

This is an experimental approach to test the workflow and gather information before determining the long-term architecture.

## Dependencies

This task depends on **Task #160: Add AI completion backend with multi-provider support**, which provides the foundational AI backend infrastructure including:

- Multi-provider AI abstraction layer (OpenAI, Anthropic, etc.)
- Tool calling and function execution capabilities
- Prompt caching and reasoning model support
- Configuration system for API keys and provider selection
- Error handling and logging patterns

## Proposed Solution

Add the following subcommands to `minsky tasks`:

### Core Commands

1. **`minsky tasks estimate <task-id>`**

   - Send task spec to AI with estimation prompt and relevant rules
   - Return size/complexity estimation (e.g., XS, S, M, L, XL or story points)
   - Store estimation in task metadata

2. **`minsky tasks decompose <task-id>`**
   - Analyze complex tasks and suggest breakdown
   - Return subtasks (for future hierarchical support) or serial task sequence
   - Option to auto-create the suggested tasks

### Additional Commands to Consider

3. **`minsky tasks analyze <task-id>`**

   - Provide AI analysis of task clarity, completeness, and potential issues
   - Suggest improvements to task specification

4. **`minsky tasks suggest-deps <task-id>`**

   - Analyze task and suggest potential dependencies on other tasks
   - Help identify blocking relationships

5. **`minsky tasks prioritize [--all | --status <status>]`**

   - AI-assisted prioritization based on impact, effort, and dependencies
   - Return suggested priority order

6. **`minsky tasks similar <task-id>`**
   - Find similar completed tasks for reference
   - Help with estimation and approach planning

## Technical Approach

1. **Command Structure**:

   - Add new subcommands under `src/commands/tasks/`
   - Follow existing command patterns for consistency

2. **AI Integration** (building on Task #160):

   - **Leverage existing AI backend** for provider abstraction and core functionality
   - Build task-specific AI service layer using the established AI backend
   - Use existing configuration system for API keys and provider selection
   - Focus on task analysis domain logic rather than low-level AI integration

3. **Data Storage**:

   - Extend task schema to include AI-generated metadata
   - Store estimations, decompositions, and analysis results
   - Track AI usage for future analysis

4. **Prompt Engineering**:
   - Create reusable prompt templates optimized for task analysis use cases
   - Include relevant project rules and context in prompts
   - Leverage prompt caching capabilities from the AI backend (Task #160)
   - Design prompts optimized for reasoning models (o1, Claude 3.5 Sonnet)

## Implementation Steps

**Prerequisites**: Task #160 (AI completion backend) must be completed first.

1. **Build task-specific AI service** using the established AI backend
2. **Implement `estimate` command** as proof of concept
3. **Add task schema extensions** for AI metadata
4. **Design and test prompt templates** for task analysis use cases
5. **Implement `decompose` command** with task breakdown logic
6. **Add remaining commands** based on initial feedback
7. **Add comprehensive tests** including AI interaction testing
8. **Document usage and best practices** for AI-powered task management

## Acceptance Criteria

- [ ] **Task #160 (AI completion backend) is completed** and available
- [ ] **`minsky tasks estimate <task-id>`** returns complexity estimation using AI backend
- [ ] **Estimations are stored** in task metadata with proper schema validation
- [ ] **`minsky tasks decompose <task-id>`** suggests task breakdown using reasoning models
- [ ] **Task-specific AI service** integrates cleanly with the general AI backend
- [ ] **Prompt templates** are optimized for task analysis and support rule injection
- [ ] **Commands include appropriate error handling** leveraging AI backend patterns
- [ ] **AI responses are validated** before storage with proper type checking
- [ ] **Usage is tracked** for analysis and optimization
- [ ] **Commands have comprehensive help text** with examples
- [ ] **Feature is documented** in user guide with AI backend integration details

## Future Considerations

- Integration with task hierarchies once implemented
- Batch operations for multiple tasks
- Learning from historical data to improve estimates
- Custom prompt templates per project
- Integration with external project management tools
