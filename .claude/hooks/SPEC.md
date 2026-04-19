# Claude Code Hooks: Behavioral Specification

## System Overview

Six TypeScript hooks (in `.claude/hooks/`) forming two subsystems:

1. **Typecheck subsystem** (3 files, shared state): informational feedback on edit, blocking gate on stop
2. **Workflow subsystem** (3 files, independent): review gate, auto-pull, remote bootstrap

All hooks share types and a sync exec helper from `types.ts`. They are self-contained — no imports from `src/` — so they work even when the main codebase has type errors.

## `session-start.ts`

### Interface

- **Event**: SessionStart
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_CODE_REMOTE`, `CLAUDE_PROJECT_DIR`
- **Output**: None (side effects only)
- **Exit code**: 0

### Behavior

1. Guard: exits immediately if `CLAUDE_CODE_REMOTE` is not `"true"` (local sessions skip entirely)
2. If `node_modules/` or `node_modules/winston/` is missing, runs `bun install`
3. If `gitleaks` is not in PATH, downloads v8.21.2 linux_x64 binary from GitHub releases to `/usr/local/bin/gitleaks`

### Edge cases

- Hardcodes gitleaks version `8.21.2` and architecture `linux_x64`
- Assumes `/usr/local/bin/` is writable (container environment)

---

## `typecheck-on-edit.ts`

### Interface

- **Event**: PostToolUse (Write, Edit, session_write_file, session_edit_file, session_search_replace)
- **Input (stdin JSON)**: `tool_input.file_path`, `tool_input.path`, `tool_result.filePath`, `session_id`, `agent_id`
- **Output (stdout JSON)**: `hookSpecificOutput` with `additionalContext` on type errors
- **Exit code**: Always 0 (informational only, never blocks)
- **Timeout**: 30s

### Behavior

1. Reads stdin JSON via `Bun.stdin.json()`
2. Extracts file path from `tool_input.file_path`, falling back to `tool_input.path`, then `tool_result.filePath`
3. Exits silently if file is not `.ts` or `.tsx`
4. **Session-aware root detection**: if file path starts with `$HOME/.local/state/minsky/sessions/`, extracts session root; otherwise uses `$CLAUDE_PROJECT_DIR`
5. **State tracking**: appends `project_root` to `/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt` (or `-main.txt` if no agent_id)
6. Runs `bunx tsc --incremental` in the project root
7. On tsc failure, filters errors into two categories:
   - **File errors**: lines starting with `${relative_path}(` — errors in the edited file
   - **Cascade errors**: remaining errors in other files
8. Outputs structured JSON with error preview (first 10 lines of file errors) and cascade count

### Output format (on errors in edited file)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "TypeScript errors in edited file:\n<errors>\n(+ N cascade error(s) in other files)"
  }
}
```

### Output format (cascade-only errors)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "TypeScript: N error(s) in other files (cascade from ongoing edits, checked at turn end)"
  }
}
```

### Shared state written

- Appends to: `/tmp/claude-typecheck-roots-${session_id}-${agent_id|main}.txt`

---

## `typecheck-on-stop.ts`

Handles both **Stop** and **SubagentStop** events. Determines which state file to read based on `agent_id` from the input JSON.

### Interface

- **Event**: Stop, SubagentStop
- **Input (stdin JSON)**: `session_id`, `agent_id`, `hook_event_name`, `cwd`
- **Output (stdout JSON)**: `hookSpecificOutput` with error details on failure
- **Exit code**: 0 (pass) or 2 (fail — forces Claude to continue)
- **Timeout**: 60s

### Behavior

1. Reads stdin JSON, determines state file path from `session_id` and `agent_id`
2. Reads unique project roots from state file (deduplication via `Set`)
3. Falls back to `cwd` then `CLAUDE_PROJECT_DIR` if no state file
4. For each root:
   - Skips if directory doesn't exist
   - Skips if no `tsconfig.json`
   - Runs `bunx tsc` (full, no `--incremental`) and captures output
   - Counts errors matching `): error TS`
   - Collects errors with `=== ${root} ===` header
5. If any root failed: outputs JSON with first 60 lines of errors + total count, exits 2
6. If all passed: deletes state file, exits 0

### Output format (on failure)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop|SubagentStop",
    "additionalContext": "TypeScript errors must be fixed before completing:\n<first 60 lines>\n\nTotal: N error(s). Fix all type errors before returning."
  }
}
```

### Critical: exit 2 semantics

Exit code 2 is a **blocking error** in Claude Code — the agent is forced to continue and fix the errors. This is the correctness gate.

---

## `require-review-before-merge.ts`

### Interface

- **Event**: PreToolUse (mcp**minsky**session_pr_merge)
- **Input (stdin JSON)**: `tool_input.task`
- **Output (stdout JSON)**: `permissionDecision: "deny"` with reason, or nothing (allow)
- **Exit code**: Always 0
- **Timeout**: 15s

### Behavior

1. Extracts `task` from `tool_input` — exits silently if empty
2. Constructs branch name: `task/${task.replace("#", "-")}`
3. Looks up PR number via `gh pr list`
4. Exits silently if no PR found
5. Checks review count via `gh api` — deny if 0
6. Checks spec verification in review bodies — deny if absent

### Dependencies

- `gh` CLI (GitHub CLI) — must be authenticated
- Hardcodes repo: `edobry/minsky`

---

## `post-merge-pull.ts`

### Interface

- **Event**: PostToolUse (session_pr_merge, merge_pull_request)
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_PROJECT_DIR`
- **Output (stdout)**: Plain text warning if MCP server source changed
- **Exit code**: Always 0
- **Timeout**: 20s

### Behavior

1. Records HEAD before pull: `git rev-parse HEAD`
2. Pulls: `git pull --ff-only origin main` (ignores errors)
3. Records HEAD after pull
4. If HEAD changed AND `src/` files were modified in the diff: prints warning about stale MCP server

---

## Behavioral Contract

1. **Exit codes**: edit hook always 0; stop hooks 0 or 2; review hook always 0; merge hook always 0
2. **JSON output schema**: `hookSpecificOutput` structure must match exactly — Claude Code parses it
3. **State file paths**: `/tmp/claude-typecheck-roots-${session_id}-${agent_id|main}.txt` — edit writes, stop reads+deletes
4. **Session root detection**: `$HOME/.local/state/minsky/sessions/<uuid>/` prefix check
5. **tsc modes**: `--incremental` for edit (fast feedback), full for stop (correctness gate)
6. **Error filtering**: edit hook separates file-local vs cascade errors; stop hook aggregates all
7. **Review gate**: checks both review existence AND spec verification in review body
8. **Post-merge pull**: ff-only, warns only if src/ changed
