# Complete Task #286 Follow-up: Inspector Upgrade and FastMCP Cleanup

## Status

BACKLOG

## Priority

MEDIUM

## Description

## Follow-up Issues from Task #286

Task #286 was merged but missed several key objectives that need to be completed:

### 1. ❌ Inspector Version Upgrade  
- Current: @modelcontextprotocol/inspector@0.14.3
- Latest: @modelcontextprotocol/inspector@0.16.1 (published 7 days ago)
- Need to upgrade and test compatibility

### 2. ❌ Inspector Auto-Browser Opening
- --with-inspector flag should automatically open browser 
- According to latest inspector docs, this should work with authentication tokens
- Need to investigate why it's not opening automatically

### 3. ❌ FastMCP Code Cleanup
- Still have legacy FastMCP files in the repo:
  - src/mcp/fastmcp-server.ts
  - src/mcp/fastmcp-command-mapper.ts  
  - src/mcp/command-mapper-extensions.d.ts
  - References in src/adapters/shared/bridges/mcp-bridge.ts
  - Scripts with FastMCP references
- All FastMCP code should be removed since we migrated to official MCP SDK

### Implementation Plan

1. **Upgrade Inspector**: Update package.json and test compatibility
2. **Fix Auto-Browser**: Investigate inspector launcher and fix browser opening  
3. **Remove FastMCP**: Clean up all legacy FastMCP files and references
4. **Test Integration**: Verify HTTP transport + inspector + browser opening works end-to-end
5. **Update Documentation**: Ensure CLI help and docs reflect latest capabilities

### Acceptance Criteria

- [ ] Inspector upgraded to latest version (0.16.1)
- [ ] --with-inspector automatically opens browser with proper authentication
- [ ] All FastMCP files and references removed
- [ ] HTTP transport + inspector integration working properly
- [ ] All tests pass
- [ ] Documentation updated

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
