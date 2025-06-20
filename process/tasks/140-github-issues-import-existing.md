# Import Existing GitHub Issues Under Minsky Management

## Status
TODO

## Priority
Medium

## Summary
Implement functionality to bring existing GitHub issues under Minsky management, allowing users to manage pre-existing issues through the Minsky task system.

## Description
Currently, the GitHub Issues backend only manages issues that were created by Minsky (with Minsky labels). This task involves implementing the ability to:

1. Import existing GitHub issues as Minsky tasks
2. Add Minsky status labels to existing issues
3. Handle issues that may not follow Minsky's task ID conventions
4. Provide filtering options for selective import
5. Handle label conflicts gracefully

## Requirements

### Core Features
- [ ] Implement `minsky tasks import` command for GitHub backend
- [ ] Add Minsky labels to existing issues without overwriting existing labels
- [ ] Generate appropriate task IDs for imported issues
- [ ] Map issue state and existing labels to Minsky status
- [ ] Support filtering by issue number ranges, labels, or date

### Import Strategy
- [ ] Detect existing issues without Minsky labels
- [ ] Analyze issue content to determine appropriate status
- [ ] Preserve all existing issue metadata
- [ ] Create local task spec files if needed
- [ ] Handle conflicts with existing task IDs

### User Experience
- [ ] Interactive mode to review issues before import
- [ ] Dry-run option to preview changes
- [ ] Progress indicators for bulk imports
- [ ] Clear reporting of imported vs skipped issues

### Error Handling
- [ ] Handle rate limiting during bulk operations
- [ ] Graceful handling of permission errors
- [ ] Recovery from partial imports
- [ ] Clear error messages for common issues

## Acceptance Criteria
1. Users can import existing GitHub issues with a single command
2. Imported issues retain all original metadata
3. Minsky labels are added without disrupting existing labels
4. Import process is idempotent (can be run multiple times safely)
5. Clear feedback on what was imported and why issues were skipped

## Technical Considerations
- Need to rethink label approach for mixed Minsky/non-Minsky issues
- Consider using issue metadata or comments to track Minsky management
- May need alternative task ID generation for imported issues
- Should support incremental imports (only new issues since last import)

## Dependencies
- #138: Add GitHub Issues Support as Task Backend (must be completed first)
- GitHub Issues API pagination for large repositories
- Label management strategy for existing issues

## Estimated Effort
Medium (4-6 hours)

## Notes
- Consider using issue comments to store Minsky metadata
- May need to support custom label prefixes for different projects
- Should integrate with existing task list filtering options
- Consider supporting GitHub Projects integration in the future 
