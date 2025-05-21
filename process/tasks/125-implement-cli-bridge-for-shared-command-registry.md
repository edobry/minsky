# Task #125: Implement CLI Bridge for Shared Command Registry

## Context

Currently, Minsky has two parallel implementations for commands:

1. **Shared Command Registry**: Defines commands, parameters, and execution logic in an interface-agnostic way, making them available to the MCP interface.

2. **CLI Adapters**: Manually creates Commander.js commands that map to the shared command implementations.

This creates duplication of effort when adding new commands like the recent "session review" command. While we have a bridge that automatically maps shared commands to MCP endpoints, we lack a similar bridge for CLI commands. This results in redundant code, potential inconsistencies, and increased maintenance burden.

## Problem Statement

The current architecture requires developers to:

1. Define a command in the shared command registry
2. Separately create a CLI adapter implementation
3. Maintain both implementations when changes are needed

This duplicates effort and creates opportunity for inconsistencies between interfaces.

## Requirements

1. **CLI Bridge Implementation**

   - Create a CLI bridge that automatically generates Commander.js commands from shared command registry entries
   - Map shared command parameters to CLI options and arguments
   - Support all parameter types (string, number, boolean, arrays, etc.)
   - Handle required vs. optional parameters appropriately
   - Generate consistent help text from command descriptions
   - Support standard output formatting and error handling

2. **Command Generation**

   - Automatically generate Commander.js command objects for all shared commands
   - Provide option to customize generated commands when needed
   - Support command aliases and hierarchical command structure
   - Support argument types and validation

3. **Output Handling**

   - Generate consistent terminal-friendly output formatting
   - Support JSON output mode
   - Handle errors appropriately with proper CLI exit codes
   - Support verbose/debug output modes

4. **Integration Strategy**
   - Create a progressive migration path from manual CLI adapters to bridge-generated commands
   - Allow coexistence of both approaches during migration
   - Provide documentation for converting existing manual adapters

## Technical Design

After analyzing the existing codebase, I've identified the following components needed for the CLI bridge:

### 1. CLI Bridge Core Components

1. **CliCommandBridge**: The main class responsible for translating shared commands to Commander.js commands
   - Will connect to the shared command registry
   - Generate CLI commands from shared command definitions
   - Handle argument normalization and validation
   - Support hierarchical command structures

2. **ParameterMapper**: Utility for mapping shared command parameters to CLI options
   - Convert Zod schemas to Commander.js options
   - Handle parameter validation
   - Support complex types like arrays and objects
   - Generate appropriate help text

3. **CliExecutionContext**: Custom execution context for CLI interface
   - Track CLI-specific state
   - Provide access to CLI environment
   - Handle output formatting based on context

### 2. Architecture Integration

1. **CLI Command Generator Factory**:
   - Create CLI commands from shared command definitions
   - Support customization hooks for special cases
   - Handle command hierarchies and nesting

2. **CliCommandRegistry**: Extension of the shared command registry for CLI-specific customizations
   - Register CLI-specific command metadata
   - Store customization information
   - Maintain CLI command hierarchies

3. **SharedCliExecutor**: Execute shared commands from CLI context
   - Handle parameter validation and normalization
   - Convert CLI arguments to shared command parameters
   - Handle errors and format output

### 3. Integration Approach

The bridge will support three modes of operation:

1. **Auto-generated Mode**: Completely auto-generate CLI commands from shared command registry
2. **Customized Mode**: Auto-generate but with specific customizations for CLI experience
3. **Legacy Mode**: Continue supporting manually created CLI commands

## Implementation Steps

1. [ ] Research and analyze current CLI adapter patterns

   - [ ] Identify common patterns across existing CLI adapters
      - [ ] Examine parameter handling (required vs optional)
      - [ ] Document how arguments vs options are used
      - [ ] Analyze output formatting approaches
   - [ ] Document output formatting, error handling, and parameter mapping patterns
   - [ ] Analyze Commander.js usage in existing adapters
      - [ ] Study how command hierarchies are created
      - [ ] Document help text generation
      - [ ] Analyze error handling patterns

2. [ ] Design the CLI bridge architecture

   - [ ] Define interfaces for CliCommandBridge and related components
   - [ ] Design parameter mapping strategy from Zod to Commander.js options
   - [ ] Create class diagrams for the bridge components
   - [ ] Design the extension points for customization

3. [ ] Implement core CLI bridge components

   - [ ] Create CliCommandBridge class in src/adapters/shared/bridges/cli-bridge.ts
   - [ ] Implement ParameterMapper for converting Zod schemas to CLI options
   - [ ] Create CliExecutionContext for CLI-specific execution
   - [ ] Implement command generation utilities

4. [ ] Develop the shared-to-CLI parameter mapping system

   - [ ] Create mapper for string parameters
   - [ ] Create mapper for boolean parameters
   - [ ] Create mapper for number parameters
   - [ ] Create mapper for enum/options parameters
   - [ ] Implement support for array parameters
   - [ ] Add support for optional vs required parameters

5. [ ] Implement CLI context management

   - [ ] Create CLI execution context
   - [ ] Implement CLI-specific output formatting
   - [ ] Add support for CLI error handling with proper exit codes
   - [ ] Implement debug/verbose mode support

6. [ ] Create a prototype using an existing command

   - [ ] Select "session list" command to generate via the bridge
   - [ ] Implement bridge-generated version of the command
   - [ ] Create integration with CLI entry point
   - [ ] Test and verify functionality matches existing implementation

7. [ ] Develop the command customization system

   - [ ] Create customization API for CLI commands
   - [ ] Implement hooks for description, argument, and option customization
   - [ ] Add support for CLI-specific help text
   - [ ] Create mechanism to extend auto-generated commands

8. [ ] Implement hierarchical command structure support

   - [ ] Support generating category-based command hierarchies
   - [ ] Implement proper command nesting
   - [ ] Add support for command aliases
   - [ ] Handle subcommand help text generation

9. [ ] Create migration tools and documentation

   - [ ] Create utility for converting manual CLI adapters to bridge configuration
   - [ ] Document the migration process with examples
   - [ ] Create templates for common command patterns
   - [ ] Add developer documentation for the CLI bridge

10. [ ] Migrate selected commands to use the bridge

    - [ ] Convert "session list" command completely to the bridge
    - [ ] Convert "session get" command with customizations
    - [ ] Try converting a complex command with subcommands
    - [ ] Document any issues or limitations encountered

11. [ ] Add comprehensive test coverage

    - [ ] Unit tests for CliCommandBridge
    - [ ] Unit tests for parameter mapping
    - [ ] Integration tests for bridge-generated commands
    - [ ] E2E tests for command execution

12. [ ] Update documentation and user guides
    - [ ] Add developer documentation for the CLI bridge
    - [ ] Create migration guide for existing commands
    - [ ] Update command creation guidelines to prefer bridge-generated commands
    - [ ] Document customization options and extension points

## Implementation Details

### CliCommandBridge API (Draft)

```typescript
interface CliCommandOptions {
  // Whether to automatically generate arguments from required parameters
  useArgumentsForRequiredParams?: boolean;
  // Custom argument definition
  argumentDefinition?: {
    name: string;
    description: string;
    required: boolean;
    valueFromParam?: string; // Which parameter to use for value
  }[];
  // Custom option definitions
  optionCustomizations?: Record<string, {
    alias?: string;
    description?: string;
    hidden?: boolean;
    defaultValue?: any;
  }>;
  // Custom help text
  helpText?: string;
  // Custom examples to show in help
  examples?: string[];
}

class CliCommandBridge {
  /**
   * Generate a Commander.js command from a shared command
   */
  generateCommand(commandId: string, options?: CliCommandOptions): Command;

  /**
   * Generate a Commander.js command for all commands in a category
   */
  generateCategoryCommand(category: CommandCategory, options?: {
    name?: string;
    description?: string;
    subcommandOptions?: Record<string, CliCommandOptions>;
  }): Command;

  /**
   * Register all commands from the shared registry as CLI commands
   */
  registerAllCommands(program: Command): void;
}
```

### File Structure

```
src/
  adapters/
    shared/
      bridges/
        cli-bridge.ts         # Main CLI bridge implementation
        parameter-mapper.ts   # Shared parameter to CLI option mapper
      cli/
        cli-command-factory.ts    # Factory for generating CLI commands
        cli-execution-context.ts  # CLI-specific execution context
        cli-customization.ts      # CLI command customization utilities
```

## Verification

- [ ] Bridge successfully generates CLI commands from shared registry entries
- [ ] Bridge-generated commands have the same functionality as manually created ones
- [ ] All parameter types are correctly mapped to CLI options
- [ ] Help text is properly generated with accurate descriptions
- [ ] Output formatting is consistent with existing CLI commands
- [ ] Error handling works correctly with appropriate exit codes
- [ ] JSON output mode functions correctly
- [ ] Test coverage is comprehensive for bridge functionality
- [ ] Documentation is complete and provides clear migration guidance
- [ ] A set of commands has been successfully migrated to use the bridge

This task reduces code duplication, improves maintainability, and ensures consistency between CLI and MCP interfaces by providing a single source of truth for command definitions.
