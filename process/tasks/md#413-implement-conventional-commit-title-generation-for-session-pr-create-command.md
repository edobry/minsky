# Implement conventional commit title generation for session pr create command

## Context

Add automatic conventional commit title generation to the `session pr create` command. Add a `type` parameter (feat, fix, etc.) and modify the `title` parameter to only accept the description part. The full title should be auto-generated as `{type}({task_id}): {title}` instead of requiring users to manually format conventional commit titles.

## Requirements

1. **Add `--type` parameter** to `session pr create` command

   - Accepts conventional commit types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
   - Required parameter (no default)

2. **Modify `--title` parameter behavior**

   - Should only accept the description part (e.g., "implement session pr open command for GitHub backend")
   - Should NOT include the conventional commit prefix

3. **Automatic title generation**

   - Generate full title as: `{type}({task_id}): {title}`
   - Task ID should use full format (e.g., `md#409` not `#409`)
   - Auto-detect task ID from session context when available

4. **Backward compatibility**
   - If `--type` is not provided, fall back to current behavior
   - Existing `--title` format should still work when no `--type` is specified

## Solution

### Implementation Steps

1. **Update parameter schema** in `session-parameters.ts`

   - Add `type` parameter with enum validation
   - Update `title` parameter description

2. **Update command logic** in `pr-subcommand-commands.ts`

   - Add title generation logic when `type` is provided
   - Combine `type`, `task_id`, and `title` into conventional commit format

3. **Session context integration**
   - Auto-detect task ID from session context
   - Use resolved task ID in generated title

### Example Usage

```bash
# New behavior with --type
minsky session pr create --type feat --title "implement session pr open command"
# Generates: "feat(md#409): implement session pr open command"

# Backward compatibility
minsky session pr create --title "feat(md#409): implement session pr open command"
# Works as before
```

## Notes

- This will make PR creation cleaner and ensure consistent conventional commit formatting
- Reduces user error in formatting conventional commit titles
- Maintains backward compatibility for existing workflows
