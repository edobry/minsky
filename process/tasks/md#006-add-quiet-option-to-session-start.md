# Add `--quiet` Option to `session start` for Programmatic Output

## Context

The `minsky session start` command currently outputs a mix of human-readable messages and the actual session directory path. While this is helpful for interactive use, it makes the command difficult to use in programmatic contexts where scripts or other tools need to capture just the session directory path without any additional text. Adding a `--quiet` option would simplify integrating Minsky into automated workflows, CI/CD pipelines, and other scripting scenarios.

## Requirements

1. **CLI Behavior**

   - Add a `--quiet` (or `-q`) option to the `session start` command:
     ```
     minsky session start <session-name> [--repo <repo-url-or-path>] [--task <task-id>] [--quiet]
     ```
   - When `--quiet` is specified:
     - Output only the essential, consumable value (the session directory path)
     - Suppress all informational messages, warnings, and progress indicators
     - Exit with appropriate status codes for error handling
   - When `--quiet` is not specified, maintain the current verbose output for interactive use

2. **Output Format**

   - With `--quiet`, output just the absolute path to the session directory, with no other text
   - Ensure the output is newline-terminated for easy consumption by scripts
   - Do not include any formatting or color codes that might interfere with parsing

3. **Error Handling**

   - Even in quiet mode, ensure appropriate exit codes are set (0 for success, non-zero for errors)
   - In quiet mode, errors should still output to stderr (not stdout) so they don't contaminate captured output
   - Error messages in quiet mode should be brief and machine-readable when possible

4. **Backward Compatibility**

   - The default behavior (without `--quiet`) must remain unchanged
   - All existing options must continue to function as before

5. **Documentation**
   - Update CLI help text to describe the new option
   - Update the `minsky-workflow.mdc` rule file to include the `--quiet` option in its examples
   - Add a new section to `minsky-workflow.mdc` for programmatic usage patterns
   - Add examples of programmatic usage to README and documentation
   - Include shell script examples for common use cases

## Implementation Steps

1. Update the `session start` command in `src/commands/session/start.ts`:

   - Add the `--quiet` option to the command definition
   - Modify the output logic to check for the quiet flag
   - Ensure proper error handling with appropriate exit codes

2. Update tests to cover:

   - Normal output mode (unchanged)
   - Quiet output mode showing only the essential value
   - Error handling in quiet mode

3. Update documentation:

   - Add the new option to CLI help text
   - Update README with examples of programmatic usage
   - Add script examples for common scenarios

4. Update `minsky-workflow.mdc`:
   - Add the `--quiet` option to the existing session start command examples
   - Add a new subsection under "Session Management" titled "Programmatic Usage"
   - Include examples of using the command in scripts and automated workflows
   - Explain the difference between interactive and programmatic usage patterns

## Verification

- [ ] The `--quiet` option suppresses all output except the session directory path
- [ ] The quiet output is clean, containing only the path with no extra text
- [ ] The command maintains backward compatibility with existing options
- [ ] Error handling works correctly in quiet mode, with appropriate exit codes
- [ ] Stderr is still used for error messages in quiet mode
- [ ] All tests related to the new functionality pass
- [ ] Documentation and CLI help are updated with clear examples
- [ ] The `minsky-workflow.mdc` rule file is updated with the new option and programmatic usage examples

## Notes

- This enhancement greatly improves the utility of Minsky in automated workflows
- Recommended usage in shell scripts would be: `SESSION_DIR=$(minsky session start my-session --repo https://github.com/org/repo.git --quiet)`
- This pattern is common in CLI tools that need to support both human and programmatic interfaces
- Future consideration: Add similar `--quiet` options to other commands that output both human-readable text and consumable values
- The `minsky-workflow.mdc` update should target both new users learning the tool and experienced users automating their workflows
