# Hosted vs. local MCP server capabilities (mt#1601)

Minsky runs the same MCP tool surface in two deployment shapes that do **not**
have the same capabilities. An agent that loses its local server and reaches for
the hosted one (or vice-versa) needs to know which operations only the local
server can fulfill. This document is the reference for that split.

## The two servers

|                     | **Local** (`minsky mcp start`, stdio)                     | **Hosted** (`minsky mcp start --http`, Railway) |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Transport           | stdio (per-session subprocess)                            | HTTP (long-lived container)                     |
| `git` binary        | present (developer machine)                               | **absent** — the runtime image ships no `git`   |
| Session workspace   | on local disk under `~/.local/state/minsky/sessions/<id>` | **none** — ephemeral container, no clones       |
| Repo backend source | local `.git` + `.minsky/config.yaml`                      | `.minsky/config.yaml` only                      |
| Task DB             | shared (Supabase)                                         | shared (Supabase) — same data                   |

The hosted image's missing `git` is **intentional, not drift**. The root
`Dockerfile` bundles the server (`bun build --target=bun --outdir=dist
--entry-naming minsky.js --sourcemap=external --minify src/cli.ts`) specifically
to remove the runtime `git` dependency; the server reads
its repo backend from `.minsky/config.yaml`, not from `git`. See the `Dockerfile`
comments and `docs/architecture/bundling.md`.

Consequence: hosted is an **HTTP-MCP / metadata-only surface**. It can serve task
and session _metadata_ (shared DB) and GitHub-API-backed reads, but it cannot
create, mutate, or run anything inside a local session workspace.

## What works on hosted vs. local-only

**Local-only** (require `git` and/or a session workspace — these fail on hosted):

- All `git.*` commands (`git_log`, `git_commit`, `git_push`, `git_clone`,
  `git_diff`, `git_status`, `git_stash*`, `git_merge`, `git_rebase`,
  `git_checkout`, `git_pull`, `git_blame`, `git_search`, `git_restore`,
  `git_reset`, `git_conflicts`). Hosted has no `git` binary and no local repo.
- Session creation / mutation / execution: `session_start`, `session_commit`,
  `session_update`, `session_exec`, `session_edit_file`, `session_pr_create`,
  `session_pr_merge`, `session_pr_edit`, `session_cleanup`, `session_repair`,
  `session_review`, `session_conflicts`, `session_apply_post_merge_state_sync`.
- Session **file** tools registered outside the shared-command registry
  (`session_read_file`, `session_write_file`, `session_search_replace`,
  `session_move_file`, etc.). On hosted these currently fail with a filesystem
  `ENOENT` (the workspace doesn't exist) rather than the documented capability
  error — extending the documented error to that path is a tracked fast-follow
  (mt#1601).

**Hosted-OK** (DB- or GitHub-API-served reads; no workspace access):

- `session_get`, `session_list`, `session_dir`, `session_search`,
  `session_inspect`
- `session_pr_list`, `session_pr_get`, `session_pr_checks`
- All non-session, non-git metadata/config/task tools (`tasks_*`, `config_*`,
  `rules_*`, `memory_*`, etc.)

## How the boundary is enforced

`packages/domain/src/configuration/guard.ts` → `guardHostedCapability(commandId)`,
called from `guardProjectSetup` (which every shared-registry command passes through
at `src/adapters/mcp/shared-command-integration.ts`, before dispatch). When the
server is in hosted mode (`setHostedMode(true)`, set when started with `--http`):

- every `git.*` command, and
- every `session.*` command **not** in the `HOSTED_SAFE_SESSION_COMMANDS`
  allowlist,

is rejected with a `ValidationError` naming the command and pointing the caller at
the local `minsky mcp` server — **before** it reaches the `git clone` / workspace
access that would otherwise fail with the opaque `/bin/sh: 1: git: not found`.

The allowlist is **fail-closed**: a new session command is unsupported-on-hosted by
default until it is verified to be DB/API-only and added to
`HOSTED_SAFE_SESSION_COMMANDS`. This is deliberate — a false _allow_ reaches the raw
`git: not found`, the exact bad UX this guard removes; a false _block_ only returns a
clean "use the local server" message.

## Why not just install `git` on hosted?

Considered and rejected (mt#1601). Installing `git` (and `bun`/`gh`) into the hosted
image would contradict the deliberate bundling architecture that removed the runtime
`git` dependency, and hosted has no local-disk session model to clone _into_ in the
first place — session storage is local-filesystem by design (out of scope:
migrating session storage off the local filesystem, see the mt#1601 spec). The
documented-error path is the correct fix for the capability gap.

## A third boundary: MCP protocol capabilities across the shim (mt#4450)

Everything above is about MINSKY's capabilities — which of our commands a server will
run. There is a second, independent capability axis: the **MCP protocol's own**
client-capability negotiation, declared in the `initialize` handshake. The two are
unrelated mechanisms and fail in different places, so they are documented separately.

Since the `.mcp.json` flip to `minsky mcp shim` (ADR-038, 2026-08-20), a local
connection is not client-to-server — it is client → shim → daemon. **The shim is
one-directional**: it reads a line from stdin, POSTs it, and writes the responses back.
It opens no GET/SSE stream and holds no correlation table, and it reads the response
body with a fully-buffering `await response.text()`. So a **server-initiated request**
has no path back to the client, and one sent inside the response stream cannot surface
until that stream closes — which cannot happen until the request is answered.

The consequence, if the declaration is forwarded verbatim: the daemon believes the
client can service a request that structurally cannot arrive, and the call hangs. That
is not hypothetical — it is what mt#4450 diagnosed, where every `direction.decide` ask
routed to the MCP elicitation transport and blocked the calling agent for minutes.

So `src/mcp/shim/capabilities.ts` **removes `elicitation` from the declared set as the
`initialize` frame crosses the shim.** The principle is that a capability declaration
describes a CONNECTION, not a client program: the MCP spec's normative sentence is
"Clients that support elicitation MUST declare the `elicitation` capability during
initialization", and its model has a client and a server on one wire with no
intermediary. Through this connection, elicitation genuinely is not supported.

Two things worth knowing when reading that file:

- **The narrowing is minimal on purpose.** `sampling` and `roots` are also
  server-initiated and equally unservicable here, and are deliberately left declared —
  nothing in this repo calls them, so removing them would change what a connection
  reports without fixing anything. The admission test is "server-initiated **and**
  actually called here."
- **It is not a verdict against elicitation.** If the shim ever carries server-initiated
  requests (a GET/SSE stream plus request correlation), deleting the transform restores
  the capability with no other change.

Routing consequence for asks: with elicitation undeclared, the ADR-008 router falls
through to the static kind→transport binding, so `direction.decide` goes to the
operator inbox. That is Shape B's specified fallback ("async or host-doesn't-support-it
→ write to the Inbox queue"), not a degradation of it.

Related, and NOT fixed by the above: `MCPClientCapabilityRegistry` answers for the
whole daemon process rather than for the calling connection, so one connected
elicitation-capable client still influences routing for asks filed by others.
That is mt#4451.

## Cross-references

- mt#1601 — this capability-gap task
- mt#4450 / mt#4451 — the MCP-protocol capability axis above
- `docs/architecture/adr-038-local-shared-mcp-daemon-architecture.md` — the shim topology
- `src/mcp/shim/capabilities.ts` — the narrowing, with its admission test
- mt#1389 — the local-MCP disconnect investigation whose hosted-fallback attempts
  surfaced this gap (its Acceptance Test 3 is mt#1601's documented-error criterion)
- `docs/architecture/bundling.md` — the bundling that removed runtime `git`
- `docs/architecture/stdio-proxy.md` — the stdio respawn proxy (mt#1714) that fixed
  the disconnect class motivating the hosted fallback
- `packages/domain/src/configuration/guard.ts` — the guard implementation
