# ADR-005: Context Management Architecture

## Status
Accepted

## Context

Minsky requires the ability to generate comprehensive AI context that matches what systems like Cursor provide. This enables environment-agnostic AI collaboration by recreating the full context structure that AI assistants rely on for effective code assistance.

### Initial Problem
- Need consistent AI context across different environments
- Cursor provides specific context structure that AI models expect
- Minsky sessions operate in isolated environments that need context generation

### Key Requirements
1. Replicate Cursor's context structure exactly
2. Integrate with existing Minsky infrastructure (template system, sessions, rules)
3. Support both default and custom component selection
4. Maintain modular, testable architecture
5. Handle live data (git status, session state, rules)

## Decision

We will implement a **modular context component system** with the following architecture:

### 1. **Replication-First Design**
- **Goal**: REPLICATE Cursor's context, not avoid duplication
- **Rationale**: Consistency in AI context is more important than avoiding redundancy
- **Implementation**: Include all sections that Cursor provides (environment, rules, instructions, tools)

### 2. **Split-Phase Component Architecture**
```typescript
interface ContextComponent {
  gatherInputs: (context: ComponentInput) => Promise<ComponentInputs>; // Async data collection
  render: (inputs: ComponentInputs, context: ComponentInput) => ComponentOutput; // Pure rendering
}
```
- **Rationale**: Separates async I/O from pure rendering for better testability
- **Benefit**: Mock inputs for testing, shared input optimization potential

### 3. **Template System Integration**
- **Decision**: Use existing `CommandGeneratorService` for tool schemas
- **Rationale**: Leverages proven infrastructure instead of custom implementations
- **Implementation**: `getParameterDocumentation()` and `getCommandRepresentation()`

### 4. **Session-Aware Context**
- **Decision**: Include current session and task metadata when in session
- **Rationale**: Minsky's session isolation requires context about current session state
- **Implementation**: Detect current session (e.g., `task-md#082`) and include task metadata

### 5. **Format Flexibility with Cursor Default**
- **Decision**: JSON format by default (matches Cursor), XML as alternative
- **Rationale**: Exact format matching is critical for AI model consistency
- **Implementation**: User prompt parsing for format selection

## Components Architecture

### Core Replication Components
Match Cursor's structure exactly:
- **Environment**: OS, Shell, Workspace Path
- **Workspace Rules**: Project-specific behavioral rules
- **System Instructions**: Core AI behavior guidelines  
- **Tool Schemas**: Available tools and parameters

### Instruction Components
Static guidance sections:
- **Communication**: Markdown formatting
- **Tool Calling Rules**: Tool usage best practices
- **Maximize Parallel Tool Calls**: Parallel execution
- **Maximize Context Understanding**: Context exploration
- **Making Code Changes**: Code implementation
- **Code Citation Format**: Citation requirements
- **Task Management**: Todo system

### Minsky Enhancements
Value-add beyond Cursor:
- **Project Context**: Live git status
- **Session Context**: Current session + task metadata

## Consequences

### Positive
- **Consistency**: AI models receive expected context structure
- **Modularity**: Each component independently testable
- **Integration**: Reuses existing Minsky infrastructure
- **Flexibility**: Configurable components and formats
- **Live Data**: Real-time session, git, and rule information

### Negative
- **Duplication**: Some content duplicates what Cursor provides
- **Complexity**: More complex than simple template approach
- **Dependencies**: Relies on multiple Minsky subsystems

### Mitigations
- **Documentation**: Clear rationale for replication approach
- **Testing**: Comprehensive component and integration tests
- **Performance**: Future optimization for shared input gathering

## Implementation Notes

### Critical Design Corrections Made
1. **Environment Component**: Initially removed as "duplicate", corrected to replicate Cursor
2. **Template System**: Initially used custom schema generation, corrected to use `CommandGeneratorService`
3. **Session/Task**: Initially separate components, simplified to include task metadata in session context
4. **Tool Format**: Initially XML with numeric names, corrected to JSON with proper command IDs

### Key Learning
**Replication vs. Avoidance**: The goal is to replicate Cursor's context structure for AI consistency, not to avoid duplication. This fundamental insight shaped all subsequent design decisions.

## References
- Task #082: Add Context Management Commands for Environment-Agnostic AI Collaboration
- Cursor Context Analysis: `full-ai-prompt-complete-verbatim-2025-01-27.md`
- Template System: `src/domain/rules/template-system.ts`
- Command Generator: `src/domain/rules/command-generator.ts`

## Future Evolution
- Performance optimization for shared input gathering
- Caching layer for expensive operations
- Plugin system for custom components
- Token counting and context size optimization