# MCP Adapter

Two conventions governing Minsky's MCP adapter:

1. **Caller convention** — how cooperating callers (agents, scripts, remote triggers) identify themselves to Minsky so session activity can be traced back to the originating agent.
2. **Bridge contract** — the structured-data guarantee that MCP-exposed shared commands return, and the command-authoring rules that keep the bridge honest.

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

## Bridge contract

The shared-command → MCP bridge at `shared-command-integration.ts` translates commands from the shared registry into MCP tools. The contract callers and command authors can rely on:

### Return shape

**MCP tool results are always structured.** Every MCP-exposed shared command returns an object or array — never a human-readable confirmation string. The bridge hardcodes `ctx.format = "json"` on every call, and commands' `formatResult()` paths return the underlying payload rather than collapsing it into a `message` field.

If you're writing an MCP client, parse tool results as JSON and read fields directly. Don't assume a `text` content block.

### The `json` parameter is managed by the bridge

Shared commands conventionally declare a boolean `json` parameter to toggle JSON vs. text output from the CLI. In MCP this parameter is owned by the bridge, not the client:

1. **Stripped from the MCP schema.** `convertParametersToZodSchema()` skips the `json` key so MCP clients cannot set it. A client that tries to pass `json: true` will see a schema-validation error for an unknown field.
2. **Injected with `true`.** After argument conversion, the bridge sets `parameters.json = true` so commands that gate on `params.json` (rather than `ctx.format`) still return structured data.
3. **Guarded by a boolean-compatibility probe.** The injection fires only when the `json` parameter's schema accepts boolean values. The probe is `safeParse(true) && safeParse(false)`, which accepts wrapped schemas (`z.boolean().optional()`, `.default()`, `.preprocess()`) and is immune to duplicate-zod-instance identity issues in monorepos.

Net effect: every MCP-exposed shared command returns structured data, with no client-side configuration required.

### Command-authoring guidance

When adding a new shared command:

- **Keep the `json` name for the boolean formatting flag.** The bridge recognizes it by name + schema shape, not by metadata.
- **Don't name a non-formatting parameter `json`.** If a command legitimately needs a parameter called `json` (e.g., a JSON payload string), pick a namespaced key — `jsonPayload`, `jsonBody`. The bridge's boolean-compatibility probe will skip a non-boolean `json`, but avoid the name collision regardless; it's confusing for readers and puts the bridge's sanity check on the hot path.
- **Return structured data from the JSON branch of `formatResult()`.** The text branch exists for CLI use; MCP will never take it. Collapsing structured data into a `message` string in the JSON branch is the bug mt#1174 fixed — don't reintroduce it.

### Why this exists

mt#1174 fixed a silent data-loss bug: MCP-exposed `tasks_get` (and every other command whose result carried a `message` field) was returning only the confirmation string `"Task mt#XXXX retrieved"` and discarding the structured payload. Root cause was a two-layer bridge issue — `ctx.format` driven by a stringly-typed value that never appeared (`args?.json === "true"`, compared against a schema field that had been stripped upstream), and `params.json` defaulting to `false`. The fix hardcoded `ctx.format = "json"` and added the `params.json = true` injection described above. Inline comments in `shared-command-integration.ts` cover the probe semantics in detail.

## References

- [ADR-006](../../docs/architecture/adr-006-agent-identity.md) — Full agent identity scheme decision record
- `src/domain/agent-identity/` — Kind normalization, format parsing, layer readers, resolver
- `src/mcp/server.ts` — MCP server integration (agentId resolution + session write on every tool call)
- `src/adapters/mcp/shared-command-integration.ts` — Bridge implementation: schema conversion, `ctx.format` / `params.json` handling, boolean-compatibility probe
- `src/adapters/shared/commands/tasks/base-task-command.ts` — `formatResult()` pattern commands use to split JSON vs. text output
