# Improve CLI UX: Show available backend options in help and error messages

## Context

**Current Problem:**

- `minsky tasks list --help` shows `--backend <string>` with no indication of valid options
- Error message `❌ Unknown backend: invalid-backend-name` provides no suggestions
- Users have no way to discover available backends

**Solution:**

1. **Update CLI Help Text:**

   - Change `--backend <string>` to `--backend <string>` with list of available options
   - Add description: "Available backends: markdown, json-file, github, minsky"

2. **Improve Error Messages:**

   - Change `❌ Unknown backend: invalid-backend-name`
   - To: `❌ Unknown backend: invalid-backend-name. Available backends: markdown, json-file, github, minsky`

3. **Dynamic Backend Discovery:**
   - Read available backends from task service configuration
   - Don't hardcode backend list in CLI help

**Files to Modify:**

- `src/adapters/shared/commands/tasks/*-commands.ts`
- Error handling in task service creation
- CLI option definitions

**Acceptance Criteria:**

- [ ] Help text shows available backends
- [ ] Error messages suggest valid options
- [ ] Backend list is dynamically generated
- [ ] All task commands (list, create, get, etc.) have improved UX

## Requirements

## Solution

## Notes
