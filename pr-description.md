# feat(#387): Add MCP tool for sessiondb querying

## Summary

Implements MCP tools to allow agents to query the session database directly, providing read-only access to inspect session state and metadata without requiring file system access to session workspaces.

## Changes

### Added

- **sessiondb.search command** - Search sessions by query string across multiple fields
  - Searches session name, repo name, repo URL, task ID, branch, and PR branch
  - Returns raw SessionRecord objects from database
  - Configurable result limit (default: 10)
  - Includes search metadata (total matches, total sessions, etc.)

- **sessiondb.migrate command** (existing) - Migrate session database between backends
- **sessiondb.check command** (existing) - Check database integrity and detect issues

- **MCP adapter integration**
  - Created `src/adapters/mcp/sessiondb.ts` MCP adapter
  - Added `registerSessiondbCommandsWithMcp` function to shared command integration
  - Registered sessiondb tools in main MCP command mapper

### Design Decisions

- **Focused scope**: Only exposed `sessiondb.search` to avoid confusion with existing `session list`/`session get` commands
- **Raw database records**: Returns `SessionRecord` objects directly from database (all fields required) vs mapped `Session` objects (optional fields)
- **Read-only access**: Provides safe inspection capabilities without modification risks
- **Consistent patterns**: Follows established MCP tool architecture and error handling

## Testing

- Implementation follows existing MCP tool patterns from tasks, sessions, rules
- Uses established `createSessionProvider` for database access
- Proper error handling and logging throughout
- TypeScript compilation verified

## Usage

Agents can now use:

```
sessiondb.search query="task-123" limit=5
```

To search for sessions related to task 123, returning raw database records for detailed inspection.

## Checklist

- [x] All requirements implemented
- [x] Follows existing MCP tool patterns
- [x] Proper error handling and validation
- [x] Clear documentation and descriptions
- [x] No overlapping functionality with session commands
- [x] Read-only database access only