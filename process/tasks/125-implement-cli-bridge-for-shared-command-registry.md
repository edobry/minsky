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

## Implementation Steps

1. [ ] Research and analyze current CLI adapter patterns

   - [ ] Identify common patterns across existing CLI adapters
   - [ ] Document output formatting, error handling, and parameter mapping patterns
   - [ ] Analyze Commander.js usage in existing adapters

2. [ ] Design the CLI bridge architecture

   - [ ] Define interfaces and class structure
   - [ ] Design parameter mapping strategy
   - [ ] Design command generation approach
   - [ ] Create a strategy for handling output formatting

3. [ ] Implement core CLI bridge functionality

   - [ ] Create a bridge class that connects to the shared command registry
   - [ ] Implement automatic parameter mapping from shared command parameters to CLI options
   - [ ] Add support for generating help text and documentation
   - [ ] Implement standard output formatting

4. [ ] Create a prototype using an existing command

   - [ ] Select a simple command (e.g., "session list") to generate via the bridge
   - [ ] Implement a bridge-generated version of the command
   - [ ] Compare behavior with the manually created version
   - [ ] Refine bridge implementation based on findings

5. [ ] Expand implementation to support all parameter types

   - [ ] Add support for boolean flags, strings, numbers
   - [ ] Implement handling for arrays and complex objects
   - [ ] Add support for optional vs. required parameters
   - [ ] Implement validation logic

6. [ ] Implement error handling and output formatting

   - [ ] Create consistent error handling for CLI context
   - [ ] Implement JSON output mode
   - [ ] Add support for verbose/debug output

7. [ ] Create migration tools and documentation

   - [ ] Document process for converting manual adapters to bridge-generated commands
   - [ ] Implement helper utilities for migration
   - [ ] Create examples for common command patterns

8. [ ] Migrate selected commands to use the bridge

   - [ ] Convert a set of CLI commands to use the bridge
   - [ ] Verify functionality matches original implementations
   - [ ] Document any issues or limitations encountered

9. [ ] Add tests

   - [ ] Create unit tests for the bridge functionality
   - [ ] Add integration tests for bridge-generated commands
   - [ ] Ensure test coverage for parameter mapping and output formatting

10. [ ] Update documentation
    - [ ] Add developer documentation for the CLI bridge
    - [ ] Update command creation guidelines to prefer bridge-generated commands
    - [ ] Document any customization options or limitations

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
