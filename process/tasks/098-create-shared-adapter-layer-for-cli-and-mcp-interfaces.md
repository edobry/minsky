# Task #098: Create Shared Adapter Layer for CLI and MCP Interfaces

## Context

During the implementation of Git commands for the MCP server (task #51), several opportunities for abstractions between CLI and MCP adapters were identified. Two follow-up tasks (#96 and #97) already address parts of this abstraction need (shared CLI options and standardized option descriptions), but a more comprehensive abstraction layer is needed to reduce duplication and ensure consistency across all adapter interfaces.

## Requirements

1. **Shared Command Registry Pattern**

   - Implement a common command registry that can be used by both CLI and MCP adapters
   - Allow commands to be registered once and exposed through multiple interfaces
   - Maintain adapter-specific implementation details while sharing core logic

2. **Common Error Handling Strategy**

   - Create a unified error handling approach for both CLI and MCP adapters
   - Ensure errors are consistently formatted and reported across interfaces
   - Extend the existing `handleCliError` helper to be interface-agnostic

3. **Shared Schema Definitions**

   - Implement shared schema definitions that both CLI and MCP adapters reference
   - Create a bridge layer between Commander option definitions and Zod schemas
   - Ensure type safety and validation consistency across interfaces

4. **Response Formatting Utilities**

   - Develop common helpers for formatting responses (similar to CLI's `outputResult`)
   - Support multiple output formats (text, JSON) across different interfaces
   - Ensure consistent response structures between CLI and MCP

5. **Abstraction Evolution Strategy**
   - Design an incremental approach to migrate existing commands to the shared layer
   - Document best practices for adding new commands using the abstraction layer
   - Ensure backward compatibility during the transition

## Implementation Steps

1. [ ] Design the shared adapter abstraction layer

   - [ ] Define interfaces for command registration
   - [ ] Create type definitions for shared parameters and responses
   - [ ] Establish patterns for interface-specific extensions

2. [ ] Implement shared command registry

   - [ ] Create a central registry for all commands
   - [ ] Implement adapter bridges for CLI and MCP
   - [ ] Add registration mechanisms for both interfaces

3. [ ] Create unified error handling

   - [ ] Refactor `handleCliError` into an interface-agnostic utility
   - [ ] Implement formatters for CLI and MCP error responses
   - [ ] Ensure consistent error codes and messages

4. [ ] Develop schema definition bridge

   - [ ] Create utilities to derive Commander options from Zod schemas
   - [ ] Implement consistent validation across interfaces
   - [ ] Ensure proper type inference and safety

5. [ ] Build response formatting utilities

   - [ ] Implement shared response formatting helpers
   - [ ] Create adapter-specific output formatters
   - [ ] Support various output modes (JSON, text, etc.)

6. [ ] Document the new abstraction layer

   - [ ] Create developer guidelines for using the abstraction
   - [ ] Update existing documentation to reference the new approach
   - [ ] Provide examples of converting existing commands

7. [ ] Migrate one command group as a proof of concept

   - [ ] Select one command group (e.g., Git commands) for initial migration
   - [ ] Refactor to use the shared abstraction layer
   - [ ] Verify functionality across both interfaces

## Verification

- [ ] Commands work consistently across CLI and MCP interfaces
- [ ] Error handling is uniform across all adapters
- [ ] Response formatting follows consistent patterns
- [ ] Duplication between adapter implementations is significantly reduced
- [ ] Documentation clearly explains the abstraction layer
- [ ] The migrated command group passes all tests

## Dependencies

- Task #51: Add Git Commands to MCP Server (provides analysis of adapter patterns)
- Task #96: Improve CLI Adapter Structure for Shared Options (prerequisite)
- Task #97: Standardize Option Descriptions Across CLI and MCP Adapters (prerequisite)

## Notes

This task builds on the observations made during task #51 implementation, where we identified several opportunities for abstraction between CLI and MCP adapters. It leverages the groundwork laid by tasks #96 and #97 to create a more comprehensive abstraction layer.

The abstraction should maintain the interface-agnostic command architecture pattern already established in the codebase, while further reducing duplication and ensuring consistency across interfaces. The goal is to have command logic defined once but exposed through multiple interfaces seamlessly.

## Detailed Implementation Plan

### Current Architecture Analysis

The current implementation has:

1. **CLI Adapter**:
   - Uses Commander.js for command-line parsing
   - Has specialized utils for error handling, output formatting, and option normalization
   - Directly calls domain functions with normalized parameters

2. **MCP Adapter**:
   - Uses CommandMapper with Zod schemas
   - Has some utility duplication with CLI adapter
   - Directly calls domain functions with parameters from the MCP layer

3. **Domain Layer**:
   - Interface-agnostic functions
   - Uses Zod schemas for parameter validation
   - Returns structured data that adapters must format

### Shared Adapter Layer Design

The implementation will create a comprehensive shared abstraction layer with these key components:

#### 1. Command Registry

A generic command registry that will:
- Define an interface for registering commands that can be exposed through multiple interfaces
- Support command categorization (e.g., git commands, task commands)
- Maintain metadata about command parameters, descriptions, and behavior
- Provide access to registered commands through interface-specific bridges

#### 2. Error Handling Strategy

A unified error handling approach that will:
- Create a common base error handler for adapter-agnostic processing
- Implement interface-specific error formatters for CLI and MCP
- Ensure consistent error codes and messages across interfaces
- Extend the existing `handleCliError` functionality to be interface-agnostic

#### 3. Schema Bridge

A bridge between Zod schemas and Commander options that will:
- Create utilities to derive Commander options from Zod schemas
- Support bi-directional conversion between CLI options and structured objects
- Ensure type safety and consistent validation
- Maintain proper type inference

#### 4. Response Formatting

Common response formatting utilities that will:
- Implement shared helpers for formatting command responses
- Support multiple output formats (text, JSON) across interfaces
- Create interface-specific formatters for CLI and MCP
- Ensure consistent response structures

### Folder Structure

The implementation will use this folder structure:

```
src/adapters/
├── shared/
│   ├── command-registry.ts       # Common command registry interface
│   ├── error-handling.ts         # Shared error handling logic
│   ├── schema-bridge.ts          # Schema utilities
│   ├── response-formatters.ts    # Output formatting utilities
│   ├── options.ts                # Shared option definitions
│   ├── bridges/                  # Interface bridges
│   │   ├── cli-bridge.ts         # Bridge to CLI
│   │   └── mcp-bridge.ts         # Bridge to MCP
│   └── commands/                 # Shared command implementations
│       ├── git.ts                # Git command implementations
│       ├── tasks.ts              # Task command implementations
│       ├── session.ts            # Session command implementations
│       └── init.ts               # Init command implementations
├── cli/                          # CLI-specific adapter (existing)
└── mcp/                          # MCP-specific adapter (existing)
```

### Migration Strategy

The implementation will use an incremental approach:

1. Start with migrating git commands as a proof of concept
2. Create a pattern for migrating other command groups
3. Ensure backward compatibility during the transition
4. Provide documentation for migrating existing commands

## Remaining Work

1. **Initial Setup**
   - [ ] Create the shared adapter directory structure
   - [ ] Define the core interfaces for the command registry
   - [ ] Set up the basic bridge architecture

2. **Core Functionality**
   - [ ] Implement the base command registry
   - [ ] Create the error handling utilities
   - [ ] Develop the schema bridge utilities
   - [ ] Build the response formatting helpers

3. **Git Command Migration**
   - [ ] Migrate git commit command
   - [ ] Migrate git push command
   - [ ] Migrate git PR command
   - [ ] Ensure compatibility with existing code

4. **Testing**
   - [ ] Create tests for the shared adapter layer
   - [ ] Verify command functionality across interfaces
   - [ ] Test error handling and edge cases
   - [ ] Ensure backward compatibility

5. **Documentation**
   - [ ] Document the abstraction layer architecture
   - [ ] Create usage guidelines
   - [ ] Provide examples for future command migrations
   - [ ] Update existing documentation

6. **Next Command Groups**
   - [ ] Identify the next command group to migrate
   - [ ] Apply lessons learned from git command migration
   - [ ] Refine the abstraction layer as needed
