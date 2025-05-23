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

## Implementation Plan (Senior Engineer Analysis)

### Overview

To address the duplication and inconsistency of option descriptions across CLI and MCP adapters, we will introduce a single source of truth for all option/parameter descriptions. This will be achieved by creating a centralized module, ensuring all interfaces reference these shared descriptions. The migration will be phased to minimize risk and ensure test coverage.

### Phases

**Phase 1: Centralized Description Module**

- Create `src/utils/option-descriptions.ts`.
- Define constants for all common option/parameter descriptions, grouped by domain (e.g., repo, task, session, rule).
- Use clear, concise, and context-agnostic language suitable for both CLI and API docs.
- Add JSDoc comments for each description for IDE/documentation support.

**Phase 2: CLI Integration**

- Refactor `src/adapters/cli/utils/shared-options.ts` to import and use the centralized descriptions.
- Update all CLI command definitions to reference the shared descriptions.
- Ensure formatting is preserved for CLI help output.

**Phase 3: MCP Adapter Integration**

- Identify all MCP adapter files where option/parameter descriptions are defined.
- Replace inline/duplicated descriptions with imports from the centralized module.
- Ensure MCP documentation generation uses the new shared descriptions.

**Phase 4: Full Migration and Consistency Sweep**

- Audit all command and adapter files (Git, Task, Session, Rule) for any remaining hardcoded/duplicated descriptions.
- Replace with references to the centralized module.
- Remove any obsolete description definitions.

**Phase 5: Testing and Verification**

- Add/extend tests to verify that CLI and MCP interfaces use the same descriptions for equivalent parameters.
- Implement a test to detect any new duplicated description strings in the codebase.
- Manually verify help output and generated docs for clarity and consistency.

### Risks & Mitigations

- **Risk:** Some descriptions may require slight contextualization (CLI vs. API).
  - _Mitigation:_ Allow for optional context-specific overrides, but default to the shared description.
- **Risk:** Incomplete migration could leave some duplication.
  - _Mitigation:_ Use code search and automated tests to detect duplicates.
- **Risk:** Breaking changes to help output or API docs.
  - _Mitigation:_ Review output after migration and adjust descriptions as needed for clarity.

### Best Practices

- Use TypeScript enums or string literal types for grouping where appropriate.
- Prefer template literals for descriptions that require parameterization.
- Ensure all new commands/methods use the shared descriptions by default (document this in the codebase).

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
