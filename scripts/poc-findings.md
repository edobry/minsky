# mt#216 PoC findings: running Minsky outside Claude Code

## TL;DR

An external agent **can** drive Minsky end-to-end through the MCP server. The infrastructure works: connect via stdio, list tools, call them in sequence, complete a task lifecycle. But the experience surfaces eight distinct friction points and confirms six enforcement gaps. The friction is mostly interface-design inconsistencies that Claude Code papers over; the gaps are exactly what the mt#054 audit predicted.

The PoC does one end-to-end run: `tasks.create` → status transitions → `session.start` → `session.dir` → `session.write_file` → `session.commit` → `session.pr.create` (draft) → `tasks.status.set(CLOSED)`. The portable enforcement layer (git hooks) fires identically regardless of harness, which is the thesis of mt#054 confirmed from the other direction.

> Note: Each end-to-end run of this PoC creates one throwaway GitHub PR in draft mode. That PR is safe to close by hand after the run.

## What worked

- **Stdio transport** connects on the first try using `@modelcontextprotocol/sdk` client library
- **Tool listing** exposes all 129 MCP tools with JSON Schema
- **Task creation** with structured spec body
- **Status transitions** TODO → PLANNING → READY → (later) CLOSED
- **Session start** with full `bun install` and husky bootstrap
- **Session directory resolution**
- **File writes** via `session.write_file`
- **Task closure** to clean up the PoC artifact

## Friction points (interface inconsistencies)

### 1. Nested-session cwd guard

`session.start` refuses to run when the MCP server's cwd is inside another session. An external agent process has to know which path counts as "main workspace" and set the subprocess cwd accordingly. There's no way to ask the server "what workspace are you in?"

### 2. Tool naming mismatch with Claude Code

The raw MCP server exposes tools as `tasks.create`, `session.commit` (dotted). Claude Code rewrites these as `mcp__minsky__tasks_create` (underscored, server-prefixed). Documentation uses the Claude Code form, which an external agent can't use. The agent must discover names by listing.

### 3. Inconsistent parameter names for the same concept

- `session.commit` takes `sessionId`
- `session.dir` takes `name` (but didn't accept a UUID — only task IDs worked)
- `session.start` returns a session object where the ID field is `session.session`

There's no uniform session-identity parameter across tools.

### 4. Status lifecycle requires sequential calls

Starting a session from a TODO task needs: `tasks.status.set(PLANNING)` → `tasks.status.set(READY)` → `session.start`. An agent must know the state graph; there's no "start session and move task to READY" composite operation, and no programmatic way to introspect valid transitions.

### 5. Response format varies by tool

- `session.start` returns JSON (`{"success":true,"session":{...}}`)
- `session.dir` returns a path string
- Other tools return prose
- `tasks.create` returns prose with the task ID embedded

Agents need per-tool parsers. There's no uniform response envelope.

### 6. Zod "defaults-as-required" schema quirk

Parameters with defaults (`createDirs: boolean = true`, `all: boolean = false`, `amend: boolean = false`) appear as **required** in the emitted JSON Schema. External agents must pass every defaulted boolean explicitly. This is a quirk of `zod-to-json-schema` on the server side; Claude Code's tool wrapper probably fills them in.

### 7. Tool error messages cascade the full stderr

When a tool fails, the MCP error's `message` field embeds the subprocess's full stdout/stderr. An error from `session.commit` carried the entire pre-commit validation output as a 2000-character error message. Agents using this as an error signal will get overwhelmed.

### 8. Raw git/gh CLI remain bypassable

The `block-git-gh-cli` hook (Claude Code) blocks raw CLI calls that have MCP equivalents. An external agent can just run `git commit` directly, bypassing the whole MCP layer. The enforcement depends on the harness refusing to run those commands, not on the MCP server disallowing them (which it can't — it doesn't see Bash calls).

## Enforcement gaps confirmed (predicted by mt#054)

None of the 9 harness-trapped policies fire for the external PoC agent:

| Policy                         | How confirmed                                                       |
| ------------------------------ | ------------------------------------------------------------------- |
| `typecheck-on-edit`            | No eager feedback after `session.write_file`                        |
| `review-before-merge`          | Not tested (would have succeeded without review if attempted)       |
| `typecheck-gate`               | No turn concept in the PoC                                          |
| `acceptance-test-gate`         | `tasks.status.set(CLOSED)` worked without running acceptance tests  |
| `task-spec-validation`         | `tasks.create` succeeded without surfacing the PostToolUse advisory |
| `prompt-watermark-enforcement` | N/A — no Agent tool dispatch in this harness                        |
| `block-git-gh-cli`             | N/A — no Bash tool dispatch                                         |
| `pr-identity-provenance`       | Not tested                                                          |
| `post-merge-sync`              | Not tested                                                          |

## Confirmation: portable enforcement works exactly as designed

Git hooks fired normally for the external agent. The first PoC run even tripped over pre-commit checking `rules compile --check` output — identical to what a Claude Code user would hit. When the session was clean, the commit succeeded; when it wasn't, the commit was blocked. Git hooks are truly harness-agnostic.

This is the mirror image of the gap above: the policies we identified as **portable** in mt#054 fired correctly for the external agent; the **harness-trapped** ones didn't. The audit's classification held up under real conditions.

## What this means for mt#762 (policy layer design)

Don't pre-commit to a design yet, but the PoC surfaced a concrete question: **should MCP tool middleware become the new enforcement surface, or should agents self-report compliance?**

Arguments for middleware:

- The MCP server has a single dispatch choke point (`CallToolRequestSchema`)
- Every agent calling `tasks.status.set(DONE)` flows through it — so an acceptance-test gate could fire there
- Claude Code hooks are pre-call interceptors; MCP middleware is the same concept moved into the server

Arguments against middleware:

- `typecheck-gate` and `prompt-watermark` are fundamentally about turn boundaries and prompt generation — concepts that don't exist at the MCP call level
- The MCP server process may not have the context needed (e.g., which agent is calling, what its turn looks like)
- Moving enforcement into the server makes the server stateful in ways it isn't today

The PoC didn't resolve this, but it sharpened the question: **some** harness-trapped enforcement could move to MCP middleware cleanly (`review-before-merge`, `acceptance-test-gate`). Others (`typecheck-gate`, `prompt-watermark`) are harness-boundary concepts that have no MCP-level equivalent.

## What would make a real external agent viable

1. **A uniform response envelope** — every tool returns `{ok, data, error}` as JSON
2. **A session-identity parameter** that's consistent across session tools
3. **A "valid next status" query** for task lifecycle awareness
4. **A workspace introspection tool** — `workspace.info` returning cwd, session status, config path
5. **Defaulted parameters marked non-required** in the JSON Schema (Zod config fix)
6. **A canonical naming convention** for MCP tools — pick dotted or underscored and stick with it
7. **Structured error responses** with type + message + details, not stderr dumps
8. **Explicit policy hooks at the MCP layer** — so external agents get the same enforcement floor Claude Code users do (this is mt#762's domain)

## Recommendation for mt#762

Start the policy design with the **infrastructure** questions, not the **policy** questions:

- How do agents declare themselves to the MCP server (identity, capabilities, harness)?
- What's the shape of a pre/post tool-call interceptor?
- Where does enforcement state live (per-session? per-agent? per-repo?)
- How are policies themselves authored — declarative YAML, TypeScript modules, or compiled from rules?

These are the questions this PoC raised that weren't visible from the audit alone.
