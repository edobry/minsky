# Implement session PR refresh functionality

## Description

Enhance session pr command to intelligently handle PR branch recreation based on existing state.

## Requirements

### Logic Flow

- **Existing PR + no title** → Auto-reuse existing title/body (refresh)
- **Existing PR + new title** → Use new title/body (update)
- **No PR + no title** → Error (need title for first creation)
- **No PR + title** → Normal creation flow

### Implementation Changes

1. **Update schema** - Make title parameter optional in session PR command
2. **Add PR branch detection** - Check if pr/{session-name} branch exists early in sessionPrFromParams
3. **Extract existing description** - Read title/body from existing PR branch commit when reusing
4. **Enhanced error handling** - Clear error message when no PR exists and no title provided
5. **Update parameter descriptions** - Reflect new optional title behavior

### User Experience

```bash
# First time - requires title
minsky session pr --title "feat(#229): Initial implementation"

# Later, refresh with same description
minsky session pr  # Auto-reuses existing title/body

# Or update with new description
minsky session pr --title "feat(#229): Complete implementation" --body "..."

# Error case - no PR exists and no title
minsky session pr  # Error: "PR branch pr/229 doesn't exist. Please provide --title"
```

### Benefits

- Eliminates need to retype PR descriptions when refreshing
- Intuitive behavior that matches user expectations
- Maintains safety by requiring explicit title for new PRs
- Solves the original problem of recreating PR branches after main updates

## Status

- [ ] Update schema to make title optional
- [ ] Add PR branch existence check
- [ ] Implement title/body extraction from existing PR branch
- [ ] Add enhanced error handling
- [ ] Update parameter descriptions
- [ ] Add tests for the new functionality
