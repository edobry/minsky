# Manual Test Guide for PR Refresh Functionality

## Test Scenarios

### Scenario 1: First PR Creation (No existing PR + title provided)
```bash
# Should create new PR normally
minsky session pr --title "feat(#231): Initial implementation"
```
Expected: ✨ Creating new PR...

### Scenario 2: PR Refresh (Existing PR + no title)
```bash
# Should reuse existing title/body
minsky session pr
```
Expected: 🔄 Refreshing existing PR (reusing title and body)...

### Scenario 3: PR Update (Existing PR + new title)
```bash
# Should use new title/body
minsky session pr --title "feat(#231): Updated implementation" --body "Updated description"
```
Expected: 📝 Updating existing PR with new title/body...

### Scenario 4: Error Case (No PR + no title)
```bash
# Should error with helpful message
minsky session pr
```
Expected: Error: "PR branch pr/task#231 doesn't exist. Please provide --title for initial PR creation."

## Implementation Summary

The implementation includes:

1. **Schema Updates**:
   - Made `title` parameter optional in `sessionPrParamsSchema`
   - Updated parameter descriptions

2. **Command Registry Updates**:
   - Made `title` parameter optional in `sessionPrCommandParams`
   - Updated CLI command descriptions

3. **Core Logic**:
   - Added `checkPrBranchExists()` helper function
   - Added `extractPrDescription()` helper function
   - Implemented smart refresh logic in `sessionPrFromParams()`

4. **Logic Flow**:
   - **Existing PR + no title** → Auto-reuse existing title/body (refresh)
   - **Existing PR + new title** → Use new title/body (update)
   - **No PR + no title** → Error (need title for first creation)
   - **No PR + title** → Normal creation flow

## Benefits

- Eliminates need to retype PR descriptions when refreshing
- Intuitive behavior that matches user expectations
- Maintains safety by requiring explicit title for new PRs
- Solves the original problem of recreating PR branches after main updates

## Usage Examples

```bash
# First time - requires title
minsky session pr --title "feat(#229): Initial implementation"

# Later, refresh with same description
minsky session pr  # Auto-reuses existing title/body

# Or update with new description
minsky session pr --title "feat(#229): Complete implementation" --body "..."
```

## Test Status

- [x] Schema updates implemented
- [x] Command parameter updates implemented  
- [x] Core logic implemented
- [x] Helper functions implemented
- [x] Error handling implemented
- [x] Existing tests still pass
- [x] Changes committed and pushed
- [ ] Manual testing (ready for user verification) 
