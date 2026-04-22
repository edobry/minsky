# MCP Adapter — Caller Convention

This document describes how cooperating callers (agents, scripts, remote triggers) identify themselves to Minsky over MCP so that session activity can be traced back to the originating agent.

## `_meta["io.minsky/agent_id"]`

### What it is

Every MCP tool-call request carries an optional `_meta` object alongside the tool arguments. Minsky reads `_meta["io.minsky/agent_id"]` on every call and, when present and well-formed, writes the resolved value into the `agentId` field of the session record (last-touched-by semantics).

This is the **Layer 2 (declared)** path of the ADR-006 three-layer agent identity scheme. It takes priority over the **Layer 1 (ascribed)** fallback that Minsky computes from `clientInfo.name` + a hash of `(hostname, user, pid, start-time)`.

### Format

```
{kind}:{scope}:{id}[@{parent-agentId}]
```

| Segment           | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `kind`            | Reverse-domain harness identifier (see table below)          |
| `scope`           | How `id` is scoped: `conv`, `run`, `proc`, `inst`, or `hash` |
| `id`              | Unique within the `kind`+`scope` pair                        |
| `@parent-agentId` | Optional — the full `agentId` of the delegating agent        |

#### `kind` normalization table

| Caller                            | `kind`                      |
| --------------------------------- | --------------------------- |
| Claude Code                       | `com.anthropic.claude-code` |
| Codex CLI / Codex VS Code         | `com.openai.codex`          |
| Cursor                            | `com.cursor.cursor`         |
| Zed                               | `app.zed.zed`               |
| Minsky-dispatched native subagent | `minsky.native-subagent`    |
| GitHub-App-based agent (non-MCP)  | `github-app`                |
| Unrecognized                      | `unknown`                   |

### When to set it

Set `_meta["io.minsky/agent_id"]` when your caller:

- Is a script or automation that knows its own run ID
- Is a Minsky-dispatched subagent (the dispatch command will set this automatically once mt#441 ships)
- Is a remote trigger that carries a stable run identifier
- Is any harness that wants its activity to be attributable in session records

You do **not** need to set it for interactive Claude Code usage — the Layer 3 Claude Code PreToolUse hook (Phase 2, tracked separately) will inject it automatically.

### Examples

**Minsky-dispatched subagent (task `mt#456`, dispatched by `com.anthropic.claude-code:proc:a1b2c3d4`):**

```json
{
  "_meta": {
    "io.minsky/agent_id": "minsky.native-subagent:run:task-mt456@com.anthropic.claude-code:proc:a1b2c3d4"
  }
}
```

**Remote trigger with a known run ID:**

```json
{
  "_meta": {
    "io.minsky/agent_id": "com.anthropic.claude-code:run:trigger-run-7f3a2d1b"
  }
}
```

**Nested subagent (child of a Minsky subagent):**

```json
{
  "_meta": {
    "io.minsky/agent_id": "minsky.native-subagent:run:task-mt789@minsky.native-subagent:run:task-mt456@com.anthropic.claude-code:proc:a1b2c3d4"
  }
}
```

### Validation

Minsky silently ignores malformed values (never errors). The Layer 1 fallback is used when:

- `_meta` is absent
- `_meta["io.minsky/agent_id"]` is missing or not a string
- The value doesn't match `{kind}:{scope}:{id}` with a recognized scope

### Security

No forgery defense today. The single-user trust model means Minsky accepts any well-formed value without verification. The format is designed so that when multi-user deployment requires it, a Layer 0 JWT-verification step slots in above the declared layer without changing the `agentId` format. See ADR-006 for the full threat model.

## References

- [ADR-006](../../docs/architecture/adr-006-agent-identity.md) — Full agent identity scheme decision record
- `src/domain/agent-identity/` — Kind normalization, format parsing, layer readers, resolver
- `src/mcp/server.ts` — MCP server integration (agentId resolution + session write on every tool call)
