# Rule System Migration Notes

## Removed Workflow Rules

The following rules were removed from the default rule set during the template system refactor. Their guidance now lives in more authoritative locations:

| Removed Rule                  | Equivalent Guidance Now Lives In                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minsky-cli-usage`            | `.claude/hooks/block-git-gh-cli.ts` denial messages (per-command redirects)                                                                                                                                                                                                            |
| `mcp-usage`                   | Tool descriptions in `src/adapters/shared/commands/`; `.claude/hooks/block-github-mcp-pr-writes.ts` denial messages                                                                                                                                                                    |
| `session-first-workflow`      | `CLAUDE.md` §Task Lifecycle; `implement-task` skill                                                                                                                                                                                                                                    |
| `workspace-verification`      | `CLAUDE.md` §Task Lifecycle; `orchestrate` skill                                                                                                                                                                                                                                       |
| `mcp-tools` (retired mt#1955) | Per-tool MCP descriptions (read by the harness from the schema at tool-inspection time); hook denial messages for banned-tool mappings; memory entries for behavioral gotchas (e.g., `feedback_session_update_can_force_push`); `docs/architecture/stdio-proxy.md` for MCP proxy setup |

### Where to Find Equivalent Guidance

- **Session-first workflow** — `CLAUDE.md` §Task Lifecycle describes the `session_start` gate. The `implement-task` and `orchestrate` skills enforce this mechanically.
- **CLI vs. MCP tool use** — enforced at the PreToolUse hook level by `.claude/hooks/block-git-gh-cli.ts`; the denial reason for each blocked CLI command names the Minsky equivalent inline.
- **GitHub MCP PR-write bans** — enforced at the PreToolUse hook level by `.claude/hooks/block-github-mcp-pr-writes.ts`; denial reasons name the Minsky equivalent (per mt#1030).
- **Per-tool behavioral specs** — read from the tool's `description` field in the MCP schema (e.g., `session.pr.close` documents the absorb-and-close pattern; `session.pr.review.submit` documents identity routing; `session.exec` documents the carve-out semantics).
- **Behavioral gotchas tied to specific actions** — surface via the memory-search hook (`.claude/hooks/memory-search.ts`) when relevant keywords appear in a prompt. Example: `feedback_session_update_can_force_push` fires when the agent considers session_update / session_pr_create.
- **Prompt watermark check** — `.claude/hooks/check-prompt-watermark.ts` enforces session context.
- **Task implementation** — The `implement-task` skill covers the full implementation lifecycle.
- **Orchestration** — The `orchestrate` skill covers task selection through merge.
