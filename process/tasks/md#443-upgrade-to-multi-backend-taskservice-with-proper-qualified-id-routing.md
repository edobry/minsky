# Upgrade to multi-backend TaskService with proper qualified ID routing

## Context

Replace the current single-backend TaskService with the MultiBackendTaskService to enable proper qualified ID routing (md#123 → route to markdown backend with localId="123"). This will enable true multi-backend coordination and deprecate the current limited single-backend architecture.

## Context

Currently, the TaskService only supports a single backend at a time, even though we have qualified task IDs like md#123, gh#456, db#789. The multi-backend service exists and is mostly working (22/23 tests pass) but isn't integrated into the main codebase.

## Key Requirements

1. **Qualified ID Routing**: When calling getTask("md#123"), automatically route to markdown backend with localId="123"
2. **Backend Interface Updates**: All backends must implement the multi-backend interface with prefix and export/import methods
3. **Local ID Handling**: Backends should ONLY receive the post-# portion (e.g. "123" not "md#123")
4. **Test Coverage**: All existing tests must pass plus new multi-backend routing tests
5. **Backward Compatibility**: Existing CLI/MCP code should work without changes

## Requirements

## Solution

## Notes
