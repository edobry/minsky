# Separate Task ID Storage from Display Format

## Status

BACKLOG

## Priority

MEDIUM

## Description

Refactor task ID handling to store plain numbers in data but display with # prefix consistently

## Problem
Currently task IDs are stored inconsistently - some as plain numbers ('244') and some with hash prefix ('#265'). This creates data inconsistency and makes the display logic dependent on data format.

## Solution
1. **Data Layer**: Store all task IDs as plain numbers/strings without # prefix
   - SessionRecord.taskId: '244' (not '#244')
   - TaskData.id: '244' (not '#244') 
   - All database/storage operations use plain format

2. **Display Layer**: Add # prefix consistently in all UI formatters
   - Session list: 'task#244 (task: #244)'
   - All CLI output adds # when displaying
   - All MCP responses add # when displaying

3. **API Layer**: Accept both formats in input, normalize to plain for storage
   - Commands accept both '244' and '#244'
   - Normalize to '244' before storage
   - Display as '#244' in output

## Benefits
- Clean data model with consistent storage format
- Separation of concerns (data vs display)
- Easier to integrate with external systems
- Consistent user experience
- Better testability

## Implementation Areas
- Session formatters (CLI and MCP)
- Task display functions
- Input normalization functions
- Database migration script
- Test updates

## Requirements

[To be filled in]

## Success Criteria

[To be filled in]
