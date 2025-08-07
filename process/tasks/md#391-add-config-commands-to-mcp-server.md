# Add config commands to MCP server

## Context

The config commands (config list, config show) are implemented in the shared command system but are not exposed via the MCP server. This task will add the config commands to the MCP server so they can be used remotely.

## Requirements

1. **Create MCP config adapter**: Create `src/adapters/mcp/config.ts` following the same pattern as other MCP adapters (tasks.ts, session.ts, rules.ts, etc.)

2. **Register config tools**: Add the config tool registration to the MCP server in `src/commands/mcp/index.ts` alongside the other tool registrations

3. **Follow existing patterns**:
   - Use the `registerConfigCommandsWithMcp` function that already exists in `shared-command-integration.ts`
   - Include proper command overrides with descriptions
   - Follow the same structure as `rules.ts` or `session.ts`

## Implementation Details

The config commands that should be exposed are:

- `config.list` - List all configuration values and their sources
- `config.show` - Show the final resolved configuration

Both commands support JSON output format which is perfect for MCP usage.

## Files to Modify

1. **New file**: `src/adapters/mcp/config.ts` - Config MCP adapter
2. **Modify**: `src/commands/mcp/index.ts` - Add config tool registration

## Technical Notes

- Config commands are already implemented in the shared command system
- The `registerConfigCommandsWithMcp` function already exists
- Just need to create the adapter file and wire it up in the MCP server
- No changes needed to the actual config command implementations

## Requirements

## Solution

## Notes
