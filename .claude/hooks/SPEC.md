# Claude Code Hooks: Behavioral Specification

Derived from working Bash implementations on 2026-04-15.

## System Overview

Seven bash scripts forming two subsystems:

1. **Typecheck subsystem** (4 scripts, shared state): informational feedback on edit, blocking gate on stop
2. **Workflow subsystem** (3 scripts, independent): review gate, auto-pull, remote bootstrap

## Hook 1: `session-start.sh`

### Interface

- **Event**: SessionStart
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_CODE_REMOTE`, `CLAUDE_PROJECT_DIR`
- **Output**: None (side effects only)
- **Exit code**: 0 always (pipefail may cause non-zero on install failure)

### Behavior

1. Guard: exits immediately if `CLAUDE_CODE_REMOTE` is not `"true"` (local sessions skip entirely)
2. If `node_modules/` or `node_modules/winston/` is missing, runs `bun install`
3. If `gitleaks` is not in PATH, downloads v8.21.2 linux_x64 binary from GitHub releases to `/usr/local/bin/gitleaks`

### Side effects

- May create/update `node_modules/`
- May write `/usr/local/bin/gitleaks`
- May write `/tmp/gitleaks.tar.gz` (cleaned up)

### Edge cases

- Hardcodes gitleaks version `8.21.2` and architecture `linux_x64`
- Assumes `/usr/local/bin/` is writable (container environment)

---

## Hook 2: `typecheck-on-edit.sh`

### Interface

- **Event**: PostToolUse (Write, Edit, session_write_file, session_edit_file, session_search_replace)
- **Input (stdin JSON)**: `tool_input.file_path`, `tool_input.path`, `tool_response.filePath`, `session_id`, `agent_id`
- **Output (stdout JSON)**: `hookSpecificOutput` with `additionalContext` on type errors
- **Exit code**: Always 0 (informational only, never blocks)
- **Timeout**: 30s

### Behavior

1. Reads entire stdin into variable, extracts fields via jq
2. Extracts file path from `tool_input.file_path`, falling back to `tool_input.path`, then `tool_response.filePath`
3. Exits silently if file is not `.ts` or `.tsx`
4. **Session-aware root detection**: if file path starts with `$HOME/.local/state/minsky/sessions/`, extracts session root; otherwise uses `$CLAUDE_PROJECT_DIR`
5. **State tracking**: appends `project_root` to `/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt` (or `-main.txt` if no agent_id)
6. Runs `bunx tsc --incremental` in the project root
7. On tsc failure, filters errors into two categories:
   - **File errors**: lines matching `^${relative_path}(` -- errors in the edited file
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

## Hook 3: `typecheck-on-stop.sh`

### Interface

- **Event**: Stop
- **Input (stdin JSON)**: `session_id`
- **Output**: Delegated to `typecheck-tracked-roots.sh`
- **Exit code**: Delegated (0 or 2)
- **Timeout**: 60s

### Behavior

1. Extracts `session_id` from stdin
2. Constructs state file path: `/tmp/claude-typecheck-roots-${session_id}-main.txt`
3. Pipes stdin to `typecheck-tracked-roots.sh` with args `<state_file> "Stop"`

---

## Hook 4: `typecheck-on-subagent-stop.sh`

### Interface

- **Event**: SubagentStop
- **Input (stdin JSON)**: `session_id`, `agent_id`
- **Output**: Delegated to `typecheck-tracked-roots.sh`
- **Exit code**: Delegated (0 or 2)
- **Timeout**: 60s

### Behavior

1. Extracts `session_id` and `agent_id` from stdin
2. Constructs state file path: `/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt` (falls back to `-main` if no agent_id)
3. Pipes stdin to `typecheck-tracked-roots.sh` with args `<state_file> "<event>"`

---

## Hook 5: `typecheck-tracked-roots.sh` (shared logic)

### Interface

- **Called by**: Hooks 3 and 4 (not directly by Claude Code)
- **Args**: `$1` = state file path, `$2` = hook event name ("Stop" or "SubagentStop")
- **Input (stdin JSON)**: `cwd`
- **Output (stdout JSON)**: `hookSpecificOutput` with error details on failure
- **Exit code**: 0 (pass) or 2 (fail -- forces Claude to continue)

### Behavior

1. Reads unique project roots from state file (`sort -u`)
2. Falls back to `cwd` from stdin, then `CLAUDE_PROJECT_DIR` if no state file
3. For each root:
   - Skips if directory doesn't exist
   - Skips if no `tsconfig.json`
   - Runs `bunx tsc` (full, no --incremental) and captures output
   - Counts errors matching `): error TS`
   - Prepends `=== $root ===` header to errors
4. If any root failed: outputs JSON with first 60 lines of errors + total count, exits 2
5. If all passed: deletes state file, exits 0

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

Exit code 2 is a **blocking error** in Claude Code -- stderr is fed back to Claude as context, and the agent is forced to continue. This is the correctness gate.

---

## Hook 6: `require-review-before-merge.sh`

### Interface

- **Event**: PreToolUse (mcp**minsky**session_pr_merge)
- **Input (stdin JSON)**: `tool_input.task`
- **Output (stdout JSON)**: `permissionDecision: "deny"` with reason, or nothing (allow)
- **Exit code**: Always 0
- **Timeout**: 15s

### Behavior

1. Extracts `task` from `tool_input` -- exits silently if empty
2. Constructs branch name: `task/${task with '#' replaced by '-'}`
3. Looks up PR number: `gh pr list --repo edobry/minsky --head "$branch" --json number`
4. Exits silently if no PR found
5. Checks review count: `gh api repos/edobry/minsky/pulls/$pr/reviews --jq 'length'`
6. If 0 reviews: outputs deny with message referencing PR number
7. Checks spec verification: `gh api ... --jq '[.[].body] | any(test("Spec verification|spec verification|SPEC VERIFICATION"))'`
8. If no spec verification in any review: outputs deny with message

### Output format (deny -- no review)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "No review on PR #N. Use /review-pr to submit a review before merging."
  }
}
```

### Output format (deny -- no spec verification)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Review on PR #N lacks spec verification section. Use /review-pr to post a review that includes spec verification before merging."
  }
}
```

### Dependencies

- `gh` CLI (GitHub CLI) -- must be authenticated
- Hardcodes repo: `edobry/minsky`

---

## Hook 7: `post-merge-pull.sh`

### Interface

- **Event**: PostToolUse (session_pr_merge, merge_pull_request)
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_PROJECT_DIR`
- **Output (stdout)**: Plain text warning if MCP server source changed
- **Exit code**: Always 0 (pipefail, but git errors are `|| true`)
- **Timeout**: 20s

### Behavior

1. Records HEAD before pull: `git rev-parse HEAD`
2. Pulls: `git pull --ff-only origin main` (ignores errors)
3. Records HEAD after pull
4. If HEAD changed AND `src/` files were modified in the diff: prints warning about stale MCP server

### Output format (on src/ change)

```
(warning emoji)  Minsky source code updated by this merge.
   The running MCP server is using stale code.
   Run: /mcp then reconnect minsky
```

---

## Behavioral Contract (MUST NOT change)

1. **Exit codes**: edit hook always 0; stop hooks 0 or 2; review hook always 0; merge hook always 0
2. **JSON output schema**: `hookSpecificOutput` structure must match exactly -- Claude Code parses it
3. **State file paths**: `/tmp/claude-typecheck-roots-${session_id}-${agent_id|main}.txt` -- edit writes, stop reads+deletes
4. **Session root detection**: `$HOME/.local/state/minsky/sessions/<uuid>/` prefix check
5. **tsc modes**: `--incremental` for edit (fast feedback), full for stop (correctness gate)
6. **Error filtering**: edit hook separates file-local vs cascade errors; stop hook aggregates all
7. **Review gate**: checks both review existence AND spec verification in review body
8. **Post-merge pull**: ff-only, warns only if src/ changed

## Consolidation for TypeScript Port

Hooks 3, 4, and 5 consolidate into a single `typecheck-on-stop.ts`:

- Input JSON contains `hook_event_name` and `agent_id` -- sufficient to determine state file path
- Shared logic (tracked roots iteration, tsc invocation, error aggregation) becomes internal functions
- Both Stop and SubagentStop settings.json entries point to the same file
