# Task #029: Add `rules` command for managing Minsky rules

## Objective

Add a new CLI command `rules` to the Minsky CLI that provides functionality for listing, inspecting, creating, and managing Minsky rule files. The command should support operations similar to the `tasks` command but specialized for working with `.mdc` rules files with their YAML frontmatter format.

## UX and CLI Conventions

- Follow the same pattern as other Minsky commands:
  - Main command `minsky rules` with various subcommands
  - Support for `--repo <path>` and `--session <name>` flags to locate the target repo
  - Use `resolveRepoPath` helper to determine the repo path
  - Support `--json` output option where appropriate

- Subcommands should include:
  - `list`: List all available rules in a repository
  - `get`: View the content and metadata of a specific rule
  - `create`: Create a new rule file with proper frontmatter
  - `update`: Update an existing rule file or its metadata
  - `search`: Find rules by keywords or tags

- The command should have awareness of rule storage locations:
  - `.cursor/rules/` for Cursor rules
  - `.ai/rules/` for generic AI assistant rules
  - Support a flag to specify which type to work with (default to Cursor)

- The command should parse and validate YAML frontmatter:
  - Standard frontmatter fields: name, description, globs, alwaysApply
  - Support for custom fields and metadata

## Task Breakdown

- [ ] Create the core `rules` command module structure in `src/commands/rules/`
- [ ] Create a domain module for rule management in `src/domain/rules.ts`
- [ ] Implement key functionality in the domain module:
  - [ ] `listRules()`: List all rules in a repo
  - [ ] `getRule()`: Get a specific rule's content and metadata
  - [ ] `createRule()`: Create a new rule file with proper format
  - [ ] `updateRule()`: Update an existing rule
  - [ ] `searchRules()`: Search for rules by content or metadata
  - [ ] YAML frontmatter parsing and validation
- [ ] Implement CLI subcommands:
  - [ ] `list` subcommand with filtering options
    - [ ] `--format <cursor|generic|both>` to filter by rule format
    - [ ] `--json` option for structured output
    - [ ] `--tag <tag>` to filter by tags in metadata
  - [ ] `get` subcommand for viewing rule content
    - [ ] `--json` option to output rule with parsed frontmatter
    - [ ] `--meta-only` option to only show frontmatter
  - [ ] `create` subcommand
    - [ ] Interactive mode when run without arguments
    - [ ] Support providing rule content via file or stdin
    - [ ] Template selection for common rule types
  - [ ] `update` subcommand for editing rules
    - [ ] Support for updating only frontmatter
    - [ ] Support for updating only content
  - [ ] `search` subcommand
    - [ ] Full-text search within rule content
    - [ ] Metadata search options
- [ ] Add comprehensive testing:
  - [ ] Unit tests for the domain module
  - [ ] Integration tests for the CLI interface
  - [ ] Test for proper YAML frontmatter handling
  - [ ] Test for edge cases (missing files, invalid formats)
- [ ] Add documentation:
  - [ ] Update README.md with new command info
  - [ ] Add detailed help text for all subcommands
- [ ] Update the changelog with a reference to this task

## Verification

- [ ] The `minsky rules` command appears in the CLI help and provides appropriate subcommands
- [ ] The command can list all rules in a repository
- [ ] The command can display the content and metadata of a specific rule
- [ ] The command can create new rule files with proper YAML frontmatter
- [ ] The command can update existing rule files
- [ ] The command can search for rules by content or metadata
- [ ] All operations work correctly for both Cursor and generic rule formats
- [ ] All provided options work as expected
- [ ] The YAML frontmatter is correctly parsed and validated
- [ ] All tests pass
- [ ] Documentation is updated

## Context/References

- Current rule files are stored in `.cursor/rules/` with a `.mdc` extension
- Rules have a YAML frontmatter section at the top followed by markdown content
- Example frontmatter structure:
  ```yaml
  ---
  name: rule-name
  description: Brief description of what the rule does
  globs: ["**/*.ts", "**/*.js"]
  alwaysApply: false
  ---
  ```
- The `rule-creation-guidelines.mdc` file provides formatting standards for rules
- This command should support the workflow outlined in the `rule-creation-guidelines.mdc` rule 
