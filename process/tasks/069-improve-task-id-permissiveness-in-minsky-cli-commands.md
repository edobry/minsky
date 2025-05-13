# Task #069: Improve Task ID Permissiveness in Minsky CLI Commands

## Context

Currently, Minsky CLI commands that accept a task ID (e.g., `minsky session start --task`, `minsky tasks get`) are strict about the format. They often require the ID to include the `#` prefix and leading zeros (e.g., `#064`). This can be cumbersome for users who might naturally type `64`. Recent interactions have shown that these strict requirements lead to errors and repeated attempts.

## Goal

Make Minsky CLI commands that operate on tasks more permissive in how they accept task IDs. The commands should intelligently parse and normalize various common task ID input formats.

## Requirements

1.  **Identify Affected Commands:** Review all Minsky CLI commands that accept a task ID as an argument or option. This includes, but is not limited to:
    - `minsky session start --task <id>`
    - `minsky session get --task <id>` (if applicable)
    - `minsky session dir --task <id>` (if applicable)
    - `minsky tasks get <id>`
    - Any other commands that take a task identifier.
2.  **Supported Input Formats:** The CLI should accept task IDs in the following formats:
    - With `#` prefix and leading zeros (e.g., `#064`) - current format
    - With `#` prefix and no leading zeros (e.g., `#64`)
    - Without `#` prefix but with leading zeros (e.g., `064`)
    - Without `#` prefix and no leading zeros (e.g., `64`)
    - Potentially `task#<id>` as seen in session names (e.g., `task#064`, `task#64`)
3.  **Normalization:** Internally, the CLI should normalize these various inputs into the canonical format used by the system (likely `#064` or just the number `64` depending on how `TaskService` or equivalent expects it).
4.  **Error Handling:**
    - If a provided ID, after attempting normalization, still doesn't match an existing task, a clear error message should be shown.
    - The error message should ideally suggest valid task IDs if a close match is found or if the input is ambiguous.
5.  **Consistency:** The permissive parsing logic should be implemented consistently across all relevant commands. Consider a shared utility function for this.
6.  **Testing:**
    - Add unit tests for the ID parsing and normalization logic, covering all supported formats and edge cases (e.g., non-numeric input, empty input).
    - Add integration tests for a few key commands (e.g., `minsky tasks get`, `minsky session start`) to ensure they work correctly with the different ID formats.
7.  **Documentation:** Update any relevant CLI help messages or documentation to reflect the more permissive ID handling, though the primary goal is for it to "just work" without users needing to know the specifics.

## Implementation Steps

- [ ] Create a utility function `normalizeTaskId(userInput: string): string | null` that takes various ID formats and returns the canonical ID string (e.g., "064" or "#064") or null if invalid.
- [ ] Refactor existing commands (e.g., in `src/commands/tasks/*`, `src/commands/session/*`) to use this utility function before passing the ID to services like `TaskService`.
- [ ] Ensure `TaskService` and `SessionService` (and their underlying storage/retrieval mechanisms) consistently use the canonical ID format.
- [ ] Add comprehensive unit tests for `normalizeTaskId`.
- [ ] Add integration tests for affected CLI commands.
- [ ] Review and update CLI help text if necessary.

## Verification

- [ ] `minsky tasks get 64` works.
- [ ] `minsky tasks get #64` works.
- [ ] `minsky tasks get 064` works.
- [ ] `minsky session start --task 64` works.
- [ ] Commands fail gracefully with an informative message if a truly invalid or non-existent ID is provided (e.g., `minsky tasks get 9999` when task 9999 doesn't exist).
- [ ] All new tests pass.
