# Task #097: Standardize Option Descriptions Across CLI and MCP Adapters

## Context

Currently, option and parameter descriptions are duplicated between the CLI and MCP (Model-Code-Platform) adapters in the Minsky project. This leads to inconsistent descriptions, maintenance challenges when updating text, and increased chances of documentation drift between interfaces. Building on the improvements from task #096 (shared CLI options), a similar approach should be applied to standardize and centralize option descriptions.

## Requirements

1. **Centralized Option Descriptions**

   - Create a shared module for option and parameter descriptions
   - Ensure descriptions are consistent across CLI commands and MCP methods
   - Descriptions should be reusable across different adapter interfaces

2. **Description Registry**

   - Implement a registry of standard descriptions for common parameters
   - Group descriptions logically by functionality (repo resolution, task operations, etc.)
   - Include clear, concise text that works well in both CLI help text and MCP documentation

3. **Interface Consistency**

   - Ensure descriptions are appropriate for both command-line and programmatic interfaces
   - Account for different context needs (CLI help text vs. MCP API documentation)
   - Maintain consistent terminology across all interfaces

4. **Migration Strategy**
   - Update existing CLI commands to use the centralized descriptions
   - Update MCP adapter interfaces to use the same descriptions
   - Document the approach for future command/method implementations

## Implementation Steps

1. [ ] Create a new utility module at `src/utils/option-descriptions.ts`

   - [ ] Define constants for common option descriptions
   - [ ] Group descriptions by functional area
   - [ ] Add proper JSDoc comments for all exports

2. [ ] Extend shared options from task #096 to include standardized descriptions

   - [ ] Update `src/adapters/cli/utils/shared-options.ts` to use centralized descriptions
   - [ ] Ensure descriptions are appropriately formatted for CLI help text

3. [ ] Update MCP adapter to use centralized descriptions

   - [ ] Identify all description strings in MCP interfaces
   - [ ] Replace with references to the centralized descriptions
   - [ ] Ensure MCP documentation is generated consistently

4. [ ] Apply consistent descriptions to all existing commands

   - [ ] Update Git commands
   - [ ] Update Task commands
   - [ ] Update Session commands
   - [ ] Update Rule commands

5. [ ] Add tests to verify description consistency
   - [ ] Test that CLI and MCP use the same descriptions for equivalent parameters
   - [ ] Check for any remaining duplicated description strings

## Verification

- [ ] CLI help text is consistent and uses the centralized descriptions
- [ ] MCP documentation uses consistent descriptions matching the CLI
- [ ] No duplicate description strings remain in the codebase
- [ ] New descriptions are clear and appropriate for both interfaces
- [ ] String duplication in the codebase is significantly reduced
