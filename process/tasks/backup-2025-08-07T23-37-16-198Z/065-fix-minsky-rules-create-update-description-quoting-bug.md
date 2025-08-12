# Fix `minsky rules create/update` Description Quoting Bug

## Context

The `minsky rules create` and `minsky rules update` commands currently enclose the `description` field in the YAML frontmatter of rule files with single quotes. According to the `rule-creation-guidelines`, descriptions should be single-line but not enclosed in quotes unless they contain special characters that require quoting. This bug results in incorrectly formatted rule files.

## Requirements

- Modify the `minsky rules create` command to write the `--description` value to the YAML frontmatter without adding unintended single quotes around it.
- Modify the `minsky rules update` command to update the `description` field in the YAML frontmatter without adding unintended single quotes around it.
- The commands should handle descriptions that _do_ require quoting (e.g., containing colons or other special YAML characters) correctly, adding quotes only when necessary according to standard YAML practices.

## Implementation Steps

- [ ] Locate the code responsible for writing/updating the YAML frontmatter in `src/commands/rules/create.ts` and potentially `src/commands/rules/update.ts`.
- [ ] Identify how the description string is being formatted for inclusion in the YAML.
- [ ] Adjust the formatting logic to write the description value literally, without adding single quotes.
- [ ] Implement logic to add YAML-standard quoting only when the description string requires it.
- [ ] Add unit tests for the YAML formatting logic, covering descriptions that require quoting and those that don't.
- [ ] Add integration tests for the `minsky rules create` and `minsky rules update` commands to verify descriptions are written correctly in the rule files.

## Verification

- [ ] Create a new rule using `minsky rules create --description "A simple description"`. Verify the description in the `.mdc` file is `description: A simple description` (no quotes).
- [ ] Update a rule using `minsky rules update <ruleId> --description "A simple description"`. Verify the description is updated correctly (no quotes).
- [ ] Create a new rule using a description that requires quoting (e.g., `minsky rules create --description "Description: with a colon"`). Verify the description is correctly quoted in the `.mdc` file (e.g., `description: 'Description: with a colon'`).
- [ ] All new unit and integration tests pass.
