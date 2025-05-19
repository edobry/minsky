# Task #089: Align CLI Commands with Revised Concepts

## Context

The current CLI commands use inconsistent terminology and concepts related to workspaces, repositories, and sessions. This inconsistency creates confusion for users and makes the CLI harder to understand and use. This task aims to update CLI commands to use the revised concepts and terminology established in the formalization task.

## Requirements

1. **Update Command Help Text**

   - Review and update help text for all CLI commands
   - Ensure consistent terminology aligned with formalized concepts
   - Clarify the relationship between sessions, repositories, and workspaces
   - Update parameter descriptions to use precise terminology

2. **Parameter Naming Consistency**

   - Standardize parameter names across all commands:
     - `--repo` for repository URIs (supporting multiple formats)
     - `--session` for session identifiers
     - Remove any references to "workspace" that don't align with new definitions
   - Ensure consistent handling of repository URIs in all commands

3. **Improved Error Messages**

   - Update error messages to reflect concept boundaries
   - Provide more helpful errors when users mix concepts incorrectly
   - Include references to documentation in error messages where appropriate

4. **CLI Documentation Updates**

   - Update CLI documentation to reflect revised concepts
   - Include examples using the correct terminology
   - Document relationship between parameters and concepts

5. **Update Auto-detection Behavior**
   - Make auto-detection behavior consistent across commands
   - Document auto-detection rules clearly
   - Provide consistent feedback about auto-detection outcomes

## Implementation Steps

1. [ ] Review and update CLI command definitions:

   - [ ] Update parameter names and descriptions
   - [ ] Review option flags for consistency
   - [ ] Update help text with precise terminology

2. [ ] Update error messages:

   - [ ] Identify all user-facing error messages
   - [ ] Update messages to use correct terminology
   - [ ] Improve clarity and helpfulness

3. [ ] Update CLI adapters:

   - [ ] Ensure consistent parameter handling
   - [ ] Update validation logic
   - [ ] Align with domain concepts

4. [ ] Update documentation:

   - [ ] Update CLI documentation
   - [ ] Add examples using correct terminology
   - [ ] Document parameter relationships

5. [ ] Update tests:
   - [ ] Update CLI tests to reflect changes
   - [ ] Ensure test expectations use correct terminology
   - [ ] Add tests for clear error messages

## Verification

- [ ] All CLI commands use consistent terminology
- [ ] Parameter names are standardized across commands
- [ ] Help text clearly reflects revised concepts
- [ ] Error messages are clear and use correct terminology
- [ ] Documentation is updated with correct terminology
- [ ] All tests pass
- [ ] User experience is improved with clearer concepts
