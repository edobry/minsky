# Fix rule format errors in rules.ts

## Problem Statement

When running `minsky rules list`, several errors appear related to rules not being found in 'cursor' format. The error occurs for these rules:

- no-dynamic-imports
- designing-tests
- rule-creation-guidelines
- testing-router
- bun-test-patterns
- framework-specific-tests

These rules exist in the `.cursor/rules` directory but the rules system is unable to find them.

## Context

The Minsky rule system is designed to load and manage rules from the `.cursor/rules` and `.ai/rules` directories. When listing rules using the `minsky rules list` command, the system should be able to find and load all rule files present in these directories. However, currently some rules are not being found despite existing in the `.cursor/rules` directory, causing errors when trying to list all rules.

This issue affects the usability of the rules system and needs to be fixed to ensure proper functioning of the Minsky CLI.

## Goals

1. Diagnose why the rules system cannot find these specific rules despite them existing in the `.cursor/rules` directory
2. Fix the issue in the `rules.ts` file to properly handle rule lookup
3. Ensure running `minsky rules list` completes without any "Rule not found" errors

## Acceptance Criteria

1. Running `minsky rules list` shows no rule-related errors
2. All existing rules in `.cursor/rules` are properly recognized
3. The fix is minimal and focused on the specific issue in the rule lookup process

## Implementation Notes

The error occurs in `/Users/edobry/Projects/minsky/src/domain/rules.ts` at line 235 in the `getRule` function. The likely causes could be:

1. Incorrect file name handling or format detection
2. Issues with frontmatter parsing
3. Issues with the rule search paths
4. Permission problems reading the rule files

The solution should focus on debugging and fixing the issue in the rules system without changing the existing rule files themselves.

## Dependencies

None

## Estimation

2 hours
