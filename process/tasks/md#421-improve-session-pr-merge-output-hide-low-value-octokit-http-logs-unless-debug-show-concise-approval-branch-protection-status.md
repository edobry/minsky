# Improve session PR merge output: hide low-value Octokit HTTP logs unless --debug; show concise approval/branch-protection status

## Context

Problem: During 'minsky session pr merge', Octokit request logs like 'GET /repos/.../protection - 404 with id ...' leak into default CLI output, adding noise without actionable value.

Requirements:

1. Suppress low-value transport-level HTTP logs from default output paths for merge/approval checks; only show them when --debug is enabled.
2. Provide concise, human-friendly status lines for:
   - PR approval status (required vs. current approvals)
   - Branch protection status (enabled/disabled or not configured)
   - Next steps when approval is insufficient
3. Preserve structured/JSON outputs unchanged.
4. Add tests for merge command output formatting covering: approved, unapproved, branch protection missing (404), and debug mode (logs visible).
5. Update documentation and CHANGELOG.

Notes:

- Integrate with existing logging system; avoid printing Octokit raw request logs by default.
- Keep technical details available behind --debug for troubleshooting.

## Requirements

## Solution

## Notes
