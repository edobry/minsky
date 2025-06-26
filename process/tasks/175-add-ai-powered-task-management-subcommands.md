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

2. **AI Integration**:

   - Create AI service layer for task analysis
   - Use configurable prompts with rule injection
   - Support multiple AI providers (start with OpenAI/Anthropic)

3. **Data Storage**:

   - Extend task schema to include AI-generated metadata
   - Store estimations, decompositions, and analysis results
   - Track AI usage for future analysis

4. **Prompt Engineering**:
   - Create reusable prompt templates
   - Include relevant project rules and context
   - Allow customization via config

## Implementation Steps

1. Create base AI service infrastructure
2. Implement `estimate` command as proof of concept
3. Add task schema extensions for AI metadata
4. Implement `decompose` command
5. Add configuration for AI providers and prompts
6. Implement additional commands based on initial feedback
7. Add comprehensive tests
8. Document usage and best practices

## Acceptance Criteria

- [ ] `minsky tasks estimate <task-id>` returns complexity estimation
- [ ] Estimations are stored in task metadata
- [ ] `minsky tasks decompose <task-id>` suggests task breakdown
- [ ] AI service supports configurable prompts
- [ ] Commands include appropriate error handling
- [ ] AI responses are validated before storage
- [ ] Usage is tracked for analysis
- [ ] Commands have comprehensive help text
- [ ] Feature is documented in user guide

## Future Considerations

- Integration with task hierarchies once implemented
- Batch operations for multiple tasks
- Learning from historical data to improve estimates
- Custom prompt templates per project
- Integration with external project management tools
