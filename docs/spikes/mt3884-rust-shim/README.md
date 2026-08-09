# mt#3884 — minimal Rust stdio->HTTP MCP shim (spike artifact)

This crate is **not part of the minsky build** — it has no workspace membership and nothing in
the repo references it. It is kept here purely as the reproducibility artifact for the RSS
measurement described in `docs/mcp-http-daemon-spike-findings.md` (§Rust shim measurement) and
folded into ADR-038's resource table (`docs/architecture/adr-038-local-shared-mcp-daemon-architecture.md`).

## What it does

Reads newline-delimited JSON-RPC from stdin (as Claude Code's stdio MCP transport speaks),
forwards each message to a Streamable-HTTP MCP daemon over HTTP, stamps
`_meta["io.minsky/agent_id"]` from `CLAUDE_CODE_SESSION_ID` on `tools/call` requests only, and
writes the daemon's response back to stdout. It intentionally does not proxy the HTTP transport's
GET/SSE server-push channel — Claude Code's stdio client never asks for one, so implementing it
would measure a capability the shim's actual job (mt#3812's real shim) does not need either.

## Build

```
cargo build --release
```

Uses the same Rust toolchain already installed for `cockpit-tray/src-tauri/` — no new build
infrastructure was needed.

## Config (env vars)

- `MINSKY_SHIM_DAEMON_URL` — daemon `/mcp` endpoint, e.g. `http://127.0.0.1:48800/mcp`
- `MINSKY_MCP_AUTH_TOKEN` — static bearer token (matches the daemon's own auth path)
- `MINSKY_SHIM_SELFLOG` — spike-only: path to append `{pid, conversation_id}` at startup, used to
  get an authoritative value for the identity-stamp verification (not part of the production
  shim's design; a real shim would not need this)

## Measurement result

See `docs/mcp-http-daemon-spike-findings.md` for the full methodology and numbers, and
ADR-038's resource table for how it changes (or doesn't change) the topology's central tradeoff.
