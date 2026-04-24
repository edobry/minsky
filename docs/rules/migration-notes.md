# Rule System Migration Notes

## Removed Workflow Rules

The following rules were removed from the default rule set during the template system refactor. Their guidance now lives in more authoritative locations:

| Removed Rule             | Equivalent Guidance Now Lives In                    |
| ------------------------ | --------------------------------------------------- |
| `minsky-cli-usage`       | `CLAUDE.md` §MCP Tools; hooks `block-git-gh-cli.ts` |
| `mcp-usage`              | `CLAUDE.md` §MCP Tools                              |
| `session-first-workflow` | `CLAUDE.md` §Task Lifecycle; `implement-task` skill |
| `workspace-verification` | `CLAUDE.md` §Task Lifecycle; `orchestrate` skill    |

### Where to Find Equivalent Guidance

- **Session-first workflow** — `CLAUDE.md` §Task Lifecycle describes the `session_start` gate. The `implement-task` and `orchestrate` skills enforce this mechanically.
- **CLI vs. MCP tool use** — `CLAUDE.md` §MCP Tools lists banned GitHub MCP write tools and their Minsky equivalents.
- **Block git/gh CLI** — `.claude/hooks/block-git-gh-cli.ts` enforces this at the PreToolUse hook level.
- **Prompt watermark check** — `.claude/hooks/check-prompt-watermark.ts` enforces session context.
- **Task implementation** — The `implement-task` skill covers the full implementation lifecycle.
- **Orchestration** — The `orchestrate` skill covers task selection through merge.
