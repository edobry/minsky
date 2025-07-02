# Integrate JsonFileTaskBackend with CLI Commands

## Context

The JsonFileTaskBackend is fully implemented and tested (Task #129), but it's not integrated with the CLI. Users cannot access it via `--backend json-file` because:

1. The old TaskService in `src/domain/tasks.ts` only registers `["markdown", "github"]` backends
2. All help text hardcoded to show `"Specify task backend (markdown, github)"`
3. No CLI integration testing has been done

The JsonFileTaskBackend provides centralized task synchronization across sessions, which is a key advantage over the markdown backend.

## Requirements

1. **Add JsonFileTaskBackend to CLI**: Integrate with the old TaskService in `src/domain/tasks.ts`
2. **Update Help Text**: Change all descriptions from `(markdown, github)` to `(markdown, json-file, github)`
3. **Keep Default Backend as Markdown**: Don't change the default backend
4. **Use Static Imports**: Follow the `no-dynamic-imports` rule - no `require()` statements
5. **CLI Integration Testing**: Verify all commands work with `--backend json-file`

## Implementation Steps

1. **Fix TaskService Backend Registration**

   - Add static import for `createJsonFileTaskBackend`
   - Register json-file backend in TaskService constructor
   - Keep "markdown" as default backend

2. **Update Help Text in Multiple Files**

   - `src/schemas/tasks.ts` (6 locations)
   - `src/adapters/shared/commands/tasks.ts` (3 locations)
   - `src/domain/tasks/taskCommands.ts` (1 location)

3. **CLI Integration Testing**

   - Test `minsky tasks list --backend json-file`
   - Test `minsky tasks create --backend json-file`
   - Test cross-session synchronization
   - Verify migration from markdown to JSON

4. **Fix Import Statement Linting Issues**
   - Use extensionless imports per Bun-native style
   - Fix any TypeScript compilation errors

## Verification

- [ ] `minsky tasks list --help` shows `(markdown, json-file, github)`
- [ ] `minsky tasks list --backend json-file` works correctly
- [ ] `minsky tasks create --backend json-file` works correctly
- [ ] Tasks created with json-file backend are synchronized across sessions
- [ ] No linter errors or TypeScript compilation issues
- [ ] All existing markdown backend functionality still works

## Notes

- Follow the `no-dynamic-imports` rule - use static imports only
- The JsonFileTaskBackend is already fully implemented and tested
- This is purely a CLI integration task
