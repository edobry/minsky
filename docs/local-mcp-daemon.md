# The local shared MCP daemon

How Claude Code reaches Minsky's MCP tools, and how to move between the two topologies.

Architecture and the decisions behind it: `docs/architecture/adr-038-local-shared-mcp-daemon-architecture.md`.
This page is the operator-facing reference.

## Two topologies

**Today (proxy).** Claude Code spawns one Minsky MCP server per conversation. The config entry runs
`minsky mcp proxy`, which spawns `minsky mcp start` as a child. N conversations means N servers.

**Target (shared daemon + shim).** One long-lived HTTP daemon serves every conversation on the
machine. Each conversation still spawns a process — but a thin stdio→HTTP shim rather than a whole
server.

```
before:  command: minsky   args: [mcp, proxy, --child-args, "[...]"]
after:   command: minsky   args: [mcp, shim, --url, http://127.0.0.1:48765/mcp]
```

The entry stays `type: "stdio"`. Only what gets spawned changes, which is why the migration is an
`args` swap rather than a transport change (ADR-038 §Question 7).

### Why a shim rather than pointing Claude Code straight at the HTTP URL

Identity. Claude Code puts the conversation UUID in the environment of the server process it
spawns, and Minsky stamps it onto every tool call (ADR-006 Layer 3) — that is what presence claims,
dispatch attribution, and attention accounting key on. Over plain HTTP there is no per-conversation
process and therefore no such environment: mt#3808 verified that **no per-conversation identifier
reaches the server by any route** — not headers, not `initialize` params, not `_meta`. The shim is
the per-conversation process that still has the environment, so it can stamp the identity the
daemon cannot otherwise learn.

## Migrating

Dry-run first — this is the default, and it writes nothing:

```bash
minsky setup local-http
```

It prints every Minsky MCP entry it found, the exact before/after `args`, and the daemon command it
would run. Apply it with:

```bash
minsky setup local-http --execute
```

Then restart any running Claude Code conversation to pick up the new entry.

### What it scans, and why it scans all of it

Claude Code resolves MCP servers at three scopes, and **two of them are per-project**
(<https://code.claude.com/docs/en/mcp>):

| Scope                                    | Loads in             | Stored in                                   |
| ---------------------------------------- | -------------------- | ------------------------------------------- |
| Local (the default for `claude mcp add`) | Current project only | `~/.claude.json`, under that project's path |
| Project                                  | Current project only | `.mcp.json` in the project root             |
| User                                     | All your projects    | `~/.claude.json`, top level                 |

So there is no single "the config" to rewrite. The command scans all three and migrates every
Minsky entry it finds, because a migration that covered one project would leave every other project
spawning its own server — the exact cost this topology exists to remove.

It never creates an entry in a scope that did not already have one. Claude Code takes the winning
definition whole from the highest-precedence source rather than merging across scopes, so
introducing an entry elsewhere would silently change which definition wins.

An entry that is neither proxy nor shim form (a bare `mcp start`, say) is reported and left alone.

### Entries that cannot be migrated

`mcp shim` is routed by the `minsky` bin wrapper, not by the CLI: `scripts/cli-entry.ts` intercepts
it from argv and loads a separate, deliberately thin build artifact, never entering the full CLI
(mt#3812 — the shim's memory floor is the whole point of the shared-daemon topology). So only an
invocation that goes _through_ that wrapper can run the shim:

| Entry's `command`           | Can run `mcp shim`? |
| --------------------------- | ------------------- |
| `minsky` (installed binary) | yes                 |
| `bunx` / `npx` + `minsky`   | yes                 |
| `bun <path>/src/cli.ts`     | no                  |
| `bun <path>/dist/minsky.js` | no                  |

The rewrite preserves whatever preceded `mcp`, so migrating one of the bottom two would produce
`bun <path>/src/cli.ts mcp shim --url …` — a command that exits with `error: unknown command
'shim'`. That is strictly worse than not migrating, because the proxy entry that did work is gone.

Such entries are therefore **reported and left on the proxy**, which keeps working. The command does
not substitute the installed `minsky` binary for you: that would silently change which binary — and
which version — your entry runs. To move one onto the shim, point its `command` at an installed
`minsky` and re-run.

### Flags

| Flag            | Effect                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--execute`     | Apply. Without it, the plan prints and nothing is written.                                                                                                                              |
| `--revert`      | Restore the most recent backup of each config and stop the daemon. Also dry-run by default.                                                                                             |
| `--url <url>`   | Daemon MCP URL (default `http://127.0.0.1:48765/mcp`). Decides all three: what the rewritten entry points at, where the daemon is probed for, and the host/port a spawned daemon binds. |
| `--repo <path>` | Project root whose `.mcp.json` is scanned (default: current directory).                                                                                                                 |

## Reverting

```bash
minsky setup local-http --revert            # preview
minsky setup local-http --revert --execute  # restore + stop the daemon
```

The revert restores the **bytes** of the most recent backup, so you get the original file back
rather than a re-serialized equivalent. Backups sit beside the config as
`<config>.minsky-backup-<timestamp>`; every file touched in one run shares one timestamp.

`minsky mcp proxy` is unchanged and keeps working, which is what makes the migration safe to try.

## The daemon

`minsky mcp start --http --local-daemon` — the mode implies `--http` and supplies ADR-038's
contract:

- **Port `48765`, host `127.0.0.1`.** Fixed, not negotiated: the Claude Code config is static, so a
  daemon that "helpfully" moved to a free port would be a daemon nobody talks to. A port conflict
  is a hard stop, never a fallback to another port.
- **Adopt-or-fail on conflict.** If something already holds the port, the daemon probes `/health`
  and adopts it only when the body asserts `service: "minsky-mcp"`. A 200 alone is not enough —
  every Minsky service answers `/health` the same way, and mt#3142 is the incident where that
  mattered.
- **Readiness, separately from liveness.** `/health` carries a `ready` boolean alongside `status`.
  They answer different questions and both are load-bearing: `status` (and the status code) says the
  process booted; `ready` says it can serve DB-backed work. See §Liveness is not readiness.
- **A `0600` bearer token** at `~/.config/minsky/local-mcp-token`, minted once and read by both the
  daemon and the shim. It is never rewritten, because rewriting it would invalidate the token every
  running shim already holds.
- **A discovery file** at `~/.local/state/minsky/local-mcp.json` (port, host, pid, startedAt) for
  the supervisor and the CLI. Deliberately not a client mechanism: the MCP client reads a static
  config and cannot consult a file. A hook subprocess is not an MCP client and CAN read it.

`minsky setup local-http --execute` starts the daemon itself if nothing is already serving, so a
migrated config is never left pointing at nothing.

### The response shape is pinned (mt#4322)

`/health`'s body is a checked-in contract: `contract/mcp-health-shape.json`, asserted by
`src/mcp/health-payload.test.ts` against the same builder the route calls. Renaming or removing a
field fails a test rather than surfacing later as a downstream misread. The fields:

| field         | meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `status`      | `"ok"` / `"unhealthy"` — liveness, matching the status code                             |
| `ready`       | can it serve DB-backed work? See §Liveness is not readiness — **not** the same question |
| `service`     | `"minsky-mcp"` — the identity assertion below                                           |
| `server`      | `"Minsky MCP Server"`, retained for older diagnostics that read it                      |
| `transport`   | `"http"` (this route exists only on the HTTP transport)                                 |
| `persistence` | `{ mode, reason? }` — `connected` / `unconfigured` / `unavailable`                      |
| `timestamp`   | ISO, when the response was built                                                        |

**Assert `service`, not just the status code.** Every Minsky service is built from the same
monorepo, so a misconfigured build can put a DIFFERENT application on this port and it answers 200
exactly like the right one — mt#3142 is the incident where the MCP server served the reviewer's host
for about an hour while every reviewer route 404'd, with the status check green throughout. A probe
that cannot fail carries no information.

```bash
curl -s 127.0.0.1:48765/health | jq -r '.service'   # expect: minsky-mcp
```

### Liveness is not readiness

Check readiness before pointing anything at the daemon:

```bash
curl -s 127.0.0.1:48765/health | jq '.ready, .persistence.mode'
# ready to serve:   true   "connected"
# booted, no DB:    false  "unconfigured"
```

**A 200 does not mean the daemon can do anything.** `persistence.mode: "unconfigured"` is reported
as _healthy_ on purpose — it is the expected offline/dev boot, and the `bundle-boot-smoke` CI gate
asserts exactly that 200. So the status code cannot be the readiness signal without breaking a gate
that depends on it, which is why `ready` exists as a separate field.

The gap that produced it (mt#4297): a tray-supervised daemon ran for 31 hours serving `/health` 200
with the right `service` identity and no database at all. Nothing was wrong with the endpoint — it
was answering the question it was asked. Every DB-backed tool call against that daemon would have
failed at call time, while the connection itself looked healthy, because tool registration does not
need the database. Triage from a green connection points everywhere except the daemon.

**`minsky setup local-http --execute` now refuses to migrate onto a not-ready daemon**, before it
writes anything. That is the check that must fail loudly, rather than the operator discovering it
when conversations start failing. A daemon built before `ready` existed is judged on
`persistence.mode` instead, so an older daemon is classified correctly rather than refused outright.

**"Before it writes anything" is an ordering guarantee, not a statement of intent (mt#4337).** The
daemon step runs first and the config write is the last thing `--execute` does, so every refusal —
not-ready, foreign, or spawned-but-never-healthy — leaves `.mcp.json` and its backup directory
untouched. From mt#4297 until mt#4337 this paragraph was **false**: the check sat below the write,
so a refusal rewrote the entry to the shim, left a timestamped backup beside it, and then told the
operator "Nothing has been written." Nothing detected it, because the only test of that path
exercised `ensureDaemonRunning` in isolation, where there is no config to observe.
`setup-local-http.test.ts` now asserts the config bytes are unchanged after each refusal — the
assertion that would have caught it. Asserting on the message text alone passes either way.

### Which repo the daemon binds

The spawned daemon is passed `--repo` for the project whose entry was migrated, and the command
prints the exact spawn line so the choice is visible rather than implicit. A machine-wide daemon
serving several projects is a live design question owned by mt#3814 and mt#2430, not by this
command.

## Troubleshooting

**The command reports "No Minsky MCP entries found".** It scanned the wrong project root. Pass
`--repo <path>` explicitly — the default is the current directory, and a `.mcp.json` is per-project.

**It refuses to start the daemon, naming something else on the port.** Another application holds
`48765` and does not identify as `minsky-mcp`. Stop it and re-run; the command will not spawn a
daemon that would lose the bind race and leave your config pointing at someone else's server.

**It refuses to migrate, saying the daemon cannot reach the database.** The daemon on the port is a
real `minsky-mcp` daemon but reports `ready: false` — it booted without a persistence provider, so
its DB-backed tools would fail at call time. Nothing was written. Restart the daemon (the tray
supervises it) and re-run once `/health` reports `"ready": true`. See §Liveness is not readiness.

**A conversation still spawns the old server.** Claude Code reads the config at conversation start.
Restart the conversation.

**Revert reports a stale discovery record.** The recorded pid's live command line is no longer a
local daemon — it already exited, or the number has been reused. Nothing was killed, deliberately.

## Related

- ADR-038 — the topology decision, including why the shim exists.
- `docs/architecture/stdio-proxy.md` — the entry shape being replaced.
- `docs/architecture/hosted-vs-local-mcp-capabilities.md` — why the hosted Railway server is not a
  candidate for this (it is metadata-only: no git, no workspaces).
