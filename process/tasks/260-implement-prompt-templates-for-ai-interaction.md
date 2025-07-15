# Implement prompt templates for AI interaction

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Overview

Explore and implement a system for "prompt templates" or "AI tools" that serve a similar role to Cursor Notepads but with variable substitution and structured intervention patterns. This would allow users to template common prompts and AI interaction patterns.

## Problem Statement

Users frequently type similar prompts with slight variations, such as:

- "continue working on task 244 in the existing task session, read the task spec carefully and plan out next steps, make sure to use absolute paths session-first-workflow.mdc"
- "update the task spec accordingly then commit/push"

Currently, these require manual typing each time, and while Cursor Notepads can store templates, they don't support variable substitution (like task numbers).

## Requirements

### Core Features

1. **Template System**: Create a system to store and manage prompt templates
2. **Variable Substitution**: Support for placeholders like `{task_id}`, `{session_id}`, etc.
3. **Template Categories**: Organize templates by purpose (task continuation, spec updates, etc.)
4. **Easy Invocation**: Simple command or interface to use templates

### Template Examples to Support

- Task continuation: "continue working on task {task_id} in the existing task session, read the task spec carefully and plan out next steps, make sure to use absolute paths session-first-workflow.mdc"
- Spec updates: "update the task spec accordingly then commit/push"
- Task review: "review task {task_id} progress and suggest next steps"
- Testing guidance: "run tests for the changes and fix any issues"

### Technical Considerations

1. **MCP Integration**: Evaluate MCP prompts feature capabilities and integration requirements
2. **Storage**: Where to store templates (config, dedicated file, etc.)
3. **Variable Sources**: How to populate variables (current session, user input, etc.)
4. **Integration**: How this fits into the existing Minsky CLI architecture
5. **User Interface**: Command-line interface for managing templates

## Implementation Approach

### Phase 1: Research and Design

1. Analyze common prompt patterns in existing usage
2. **Investigate MCP (Model Context Protocol) prompts feature** for potential integration or as foundation
3. Design template format and variable substitution system
4. Plan CLI command structure
5. Consider integration with existing Minsky commands

### Phase 2: Core Implementation

1. Create template storage system
2. Implement variable substitution engine
3. Add CLI commands for template management
4. Integrate with existing workflow

### Phase 3: Enhanced Features

1. Add template categories and organization
2. Implement template sharing/export
3. Add context-aware variable population
4. Create template validation and testing

## Technical Specifications

### Template Format (Initial Proposal)

```yaml
templates:
  task-continue:
    name: "Continue Task Work"
    description: "Continue working on a specific task"
    template: "continue working on task {task_id} in the existing task session, read the task spec carefully and plan out next steps, make sure to use absolute paths session-first-workflow.mdc"
    variables:
      task_id:
        type: string
        required: true
        description: "Task ID to continue working on"

  spec-update:
    name: "Update Task Spec"
    description: "Update task specification and commit"
    template: "update the task spec accordingly then commit/push"
    variables: []
```

### CLI Commands (Proposed)

```bash
# List available templates
minsky templates list

# Use a template
minsky templates use task-continue --task-id 244

# Create new template
minsky templates create --name "my-template" --template "..."

# Edit existing template
minsky templates edit task-continue

# Delete template
minsky templates delete task-continue
```

## Success Criteria

1. **Usability**: Users can easily create, manage, and use prompt templates
2. **Flexibility**: Variable substitution works reliably with different data sources
3. **Integration**: Seamless integration with existing Minsky workflow
4. **Performance**: Template processing is fast and doesn't impact workflow
5. **Maintainability**: Template system is easy to extend and modify

## Potential Challenges

1. **Variable Context**: Determining appropriate variable values automatically
2. **Template Versioning**: Managing template changes over time
3. **User Interface**: Creating intuitive CLI interface for template management
4. **Integration Complexity**: Fitting into existing architecture without disruption

## Future Enhancements

1. **AI-Assisted Templates**: AI suggests templates based on usage patterns
2. **Template Marketplace**: Share templates with other users
3. **Context-Aware Variables**: Automatically populate variables from current context
4. **Template Composition**: Combine multiple templates for complex workflows

## Research Questions

1. **How can MCP (Model Context Protocol) prompts feature be leveraged** for this template system?
2. How do other CLI tools handle template systems?
3. What variable types and sources would be most useful?
4. Should templates be user-specific or project-specific?
5. How should template validation and error handling work?
6. What's the best way to integrate with existing AI interaction patterns?

## Dependencies

- Existing Minsky CLI architecture
- Configuration system
- Session management system
- Task management system

## Estimated Complexity

**Medium-High** - Requires thoughtful design of template system, variable substitution, and CLI integration while maintaining compatibility with existing workflows.


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
