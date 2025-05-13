# Task #066: Investigate and Fix `minsky rules get --format generic` Inconsistency

## Context

During recent work (related to self-improvement on task #064), an inconsistency was observed with the `minsky rules get` CLI subcommand:
The command `minsky rules get minsky-workflow --format generic --json` reported "Rule not found: minsky-workflow". This occurred even though:

1.  `minsky rules list --json` showed the rule `minsky-workflow` exists.
2.  `minsky rules get minsky-workflow --json` (without `--format generic`) successfully retrieved the rule.
    This suggests an issue with how the `--format generic` option interacts with the `get` command, or how specific rules (like `minsky-workflow` which is a "cursor" format rule) are handled when requesting the `generic` format.

## Requirements

1.  **Investigate `minsky rules get <id> --format generic` Behavior:**
    - Reproduce the failure with `minsky rules get minsky-workflow --format generic --json`.
    - Determine why the command fails to find or format the rule when `--format generic` is used, despite the rule being accessible otherwise.
    - Identify if this issue is specific to:
      - The `minsky-workflow` rule.
      - Rules originally in "cursor" format when "generic" is requested.
      - The `--json` output in conjunction with `--format generic`.
    - Test with other rules and combinations of formats to understand the scope of the problem.
2.  **Fix `minsky rules get <id> --format generic`:**
    - Ensure the command reliably retrieves and outputs rule content in the `generic` format if the rule exists and the format request is valid.
    - If a rule cannot be converted or represented in `generic` format, the command should provide a clear error message explaining this, rather than "Rule not found."
3.  **Testing:**
    - Add new unit and/or integration tests specifically for `minsky rules get` covering successful and unsuccessful attempts to retrieve rules with the `--format generic` option.
    - Include tests for rules that are originally in "cursor" format.
    - Ensure these tests verify the content or the appropriate error message.
    - Ensure all existing tests for `minsky rules` commands continue to pass.

## Implementation Steps (Initial Thoughts)

1.  [ ] Create a test case that reliably reproduces the `minsky rules get minsky-workflow --format generic --json` failure.
2.  [ ] Examine the logic in `src/commands/rules/get.ts` (or the relevant module handling rule retrieval and formatting) to trace how the `--format generic` option is processed.
3.  [ ] Identify the root cause:
    - Is it an issue with how rule IDs are resolved when `--format generic` is active?
    - Is there an error in the content conversion logic from "cursor" to "generic" format for certain rules?
    - Does the file path or retrieval mechanism change incorrectly based on the format?
4.  [ ] Implement the fix. This might involve correcting the rule lookup, adjusting the format conversion, or improving error handling for invalid format requests.
5.  [ ] Develop and integrate the new test cases as described in the requirements.
6.  [ ] Manually verify the fix with the `minsky-workflow` rule and other rules of different original formats.

## Verification

- [ ] `minsky rules get minsky-workflow --format generic --json` successfully returns the rule content (or appropriate metadata if content is not applicable for generic) or a clear error if conversion isn't possible.
- [ ] `minsky rules get` with `--format generic` works correctly for other rules where this format is applicable.
- [ ] New and existing tests for `minsky rules` commands pass.
