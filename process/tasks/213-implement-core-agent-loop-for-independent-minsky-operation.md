# Implement Core Agent Loop for Independent Minsky Operation

## Status

BACKLOG

## Priority

MEDIUM

## Description

# Implement Core Agent Loop for Independent Minsky Operation

## Background

Currently, Minsky operates within the context of Cursor's agent loop. The Cursor agent loop provides:

- Tool calling capabilities
- File system access
- Command execution
- State management between interactions
- Context awareness (file contents, git status, etc.)
- Conversation history management

To operate independently, Minsky needs its own agent loop implementation that can provide similar capabilities while being framework-agnostic.

## Problem Statement

Minsky is currently dependent on being run within an AI coding assistant environment (like Cursor) that provides an agent loop. This creates several limitations:

1. Minsky cannot be used as a standalone tool
2. The workflow is tightly coupled to specific AI assistant implementations
3. Users cannot integrate Minsky into their own automation pipelines
4. The system cannot leverage different AI providers or models directly

## Analysis

### What is an Agent Loop?

An agent loop is a control flow mechanism that:

1. **Receives Input**: Accepts user commands or queries
2. **Processes Context**: Maintains state and context across interactions
3. **Plans Actions**: Determines what tools or operations to execute
4. **Executes Tools**: Calls functions/tools to perform operations
5. **Observes Results**: Captures outputs and side effects
6. **Updates State**: Maintains conversation and system state
7. **Generates Response**: Provides feedback to the user
8. **Iterates**: Continues the cycle for multi-step operations

### Current In-Cursor Workflow

The current workflow relies on Cursor's agent loop for:

- **Tool Discovery**: Cursor provides built-in tools (read_file, edit_file, run_terminal_cmd, etc.)
- **Execution Environment**: Cursor manages the execution context
- **State Persistence**: Cursor maintains conversation state
- **Error Handling**: Cursor handles tool failures and retries
- **User Interaction**: Cursor manages the chat interface

### Core Components Needed

To implement an independent agent loop, we need:

1. **Tool Registry System**

   - Define available tools/actions
   - Tool metadata (parameters, descriptions)
   - Tool execution interface

2. **Context Management**

   - File system state tracking
   - Git repository state
   - Session/task context
   - Conversation history

3. **Execution Engine**

   - Tool invocation
   - Result capture
   - Error handling
   - Retry mechanisms

4. **Planning/Reasoning Layer**

   - Parse user intent
   - Select appropriate tools
   - Sequence operations
   - Handle multi-step workflows

5. **State Persistence**

   - Save/restore conversation state
   - Track operation history
   - Maintain context between invocations

6. **Interface Adapters**
   - CLI interface
   - API interface
   - Web interface (future)

### Workflow Differences

#### Current (In-Cursor) Workflow:

```
User -> Cursor Chat -> AI Model -> Tool Calls -> Results -> Cursor UI
                          ^                         |
                          |_________________________|
                                 (Cursor manages)
```

#### Proposed (Independent) Workflow:

```
User -> Minsky CLI -> Agent Loop -> AI Provider -> Tool Registry -> Execution
           |              ^                              |              |
           |              |______________________________|              |
           |                     (Minsky manages)                       |
           |____________________________________________________________|
```

## Requirements

### Functional Requirements

1. **Tool System**

   - Implement a tool registry that can register and execute tools
   - Support all current Cursor-provided tools as native Minsky tools
   - Allow plugins/extensions for custom tools

2. **AI Provider Integration**

   - Support multiple AI providers (OpenAI, Anthropic, etc.)
   - Configurable model selection
   - Handle API authentication and rate limiting

3. **Context Awareness**

   - Track file system changes
   - Monitor git state
   - Maintain session/task context
   - Store conversation history

4. **Execution Control**

   - Sequential and parallel tool execution
   - Error handling and recovery
   - Progress reporting
   - Cancellation support

5. **State Management**
   - Persist agent state between invocations
   - Resume interrupted operations
   - Provide state inspection capabilities

### Non-Functional Requirements

1. **Performance**

   - Minimal overhead compared to direct tool execution
   - Efficient context serialization

2. **Reliability**

   - Graceful handling of tool failures
   - Automatic retry with backoff
   - State recovery after crashes

3. **Extensibility**

   - Plugin architecture for tools
   - Configurable planning strategies
   - Custom context providers

4. **Security**
   - Sandboxed tool execution (optional)
   - API key management
   - Audit logging

## Implementation Plan

### Phase 1: Core Infrastructure

1. Design tool interface and registry
2. Implement basic execution engine
3. Create context management system
4. Add state persistence layer

### Phase 2: AI Integration

1. Abstract AI provider interface
2. Implement OpenAI provider
3. Add Anthropic provider
4. Create provider configuration system

### Phase 3: Tool Implementation

1. Port file system tools (read, write, edit)
2. Implement command execution tools
3. Add git operation tools
4. Create Minsky-specific tools

### Phase 4: Agent Loop

1. Implement planning/reasoning layer
2. Add conversation management
3. Create execution orchestration
4. Build error handling and retry logic

### Phase 5: Interface Integration

1. Add CLI commands for agent operations
2. Create configuration for agent behavior
3. Implement progress reporting
4. Add debugging/inspection tools

## Technical Considerations

### Architecture

- Use dependency injection for pluggability
- Event-driven architecture for extensibility
- Separate concerns between planning and execution

### Technology Choices

- Consider using LangChain/LlamaIndex for agent primitives
- Evaluate function calling vs. prompt engineering approaches
- Determine streaming vs. batch execution model

### Integration Points

- Maintain compatibility with existing Minsky commands
- Allow gradual migration from Cursor-dependent to independent
- Support hybrid mode (enhanced when in Cursor, standalone otherwise)

## Success Criteria

1. Minsky can execute multi-step workflows without Cursor
2. All current Cursor-dependent features work independently
3. Performance is comparable to Cursor-based execution
4. Users can configure their preferred AI provider
5. The system is extensible for custom tools and workflows

## Future Enhancements

1. **Web UI**: Provide a web interface similar to Cursor
2. **Distributed Execution**: Run tools on remote machines
3. **Workflow Automation**: Define and run complex workflows
4. **Multi-Agent**: Support multiple agents working together
5. **Fine-tuned Models**: Use Minsky-specific fine-tuned models


## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
