# Minsky Rules System

This directory contains Cursor rules (`.mdc` files) that define behavior guidelines, conventions, and workflows for the Minsky project.

## Important Notes on Rule Synchronization

### Workspace Isolation and Rules

Minsky uses a session-based workspace model with complete isolation between workspaces:

- **Main workspace**: Your primary checkout of the Minsky repository
- **Session workspaces**: Separate clones created for specific tasks, located at `~/.local/state/minsky/git/{repo}/sessions/task#{id}`

Due to this isolation model, **changes to rule files in one workspace are not automatically synchronized to other workspaces**. This is by design to maintain workspace separation.

### Reading Rules

When you use `minsky rules get <rule-id>`, the command reads the rule file from the **current workspace**:

- If run from the main workspace: reads from `/path/to/main/workspace/.cursor/rules/`
- If run from a session workspace: reads from `/path/to/session/workspace/.cursor/rules/`

### Managing Rule Updates

When making changes to rule files:

1. **Decide where the authoritative version should live**:

   - For project-wide rules, usually the main workspace is authoritative
   - For task-specific rules, the session workspace may be authoritative

2. **Manually synchronize changes when needed**:
   - When updating project-wide rules in the main workspace, you may need to copy those changes to active session workspaces
   - When finalizing task-specific rule changes in a session, remember to include them in your PR to be merged back to the main workspace

### Future Improvements

Future enhancements may include a rule synchronization command to make this process easier, but for now, be aware that rule changes must be manually propagated between workspaces.

## Rules Usage

Rules can be managed using the following commands:

```bash
# List all rules
minsky rules list

# Get a specific rule
minsky rules get <rule-id>

# Create a new rule
minsky rules create <rule-id>

# Update an existing rule
minsky rules update <rule-id> [--content file] [--description "New description"]

# Search rules
minsky rules search "query"
```

For more details, use `minsky rules --help` or see the [Minsky documentation](../../../docs/rules.md).
