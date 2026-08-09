//! Minimal Rust stdio->HTTP MCP shim -- spike for mt#3884.
//!
//! Scope, deliberately narrow (matches the mt#3884 task spec's "In scope"
//! bullet exactly): read newline-delimited JSON-RPC from stdin, forward each
//! message to a Streamable-HTTP MCP daemon over HTTP, stamp
//! `_meta["io.minsky/agent_id"]` from `CLAUDE_CODE_SESSION_ID` on
//! `tools/call` requests only, write the daemon's response back to stdout as
//! newline-delimited JSON-RPC. No GET/SSE server-push proxying (out of
//! scope: Claude Code's stdio client never asks for one -- that's an HTTP-
//! transport-only concept the shim absorbs, matching the production
//! TypeScript stdio proxy's identity-injection surface, not its full
//! transport feature set).
//!
//! Config via env:
//!   MINSKY_SHIM_DAEMON_URL   e.g. http://127.0.0.1:48800/mcp
//!   MINSKY_MCP_AUTH_TOKEN    static bearer token (optional)
//!   CLAUDE_CODE_SESSION_ID   set by Claude Code on every spawned MCP child;
//!                            stamped verbatim as the _meta value (matching
//!                            ADR-038 Observation F's minimal-shim precedent
//!                            -- raw session id, not the canonical
//!                            `com.anthropic.claude-code:conv:<uuid>` form
//!                            the production stdio proxy emits).

use std::io::{self, BufRead, Write};

use serde_json::Value;

const META_KEY: &str = "io.minsky/agent_id";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let daemon_url = std::env::var("MINSKY_SHIM_DAEMON_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:48800/mcp".to_string());
    let auth_token = std::env::var("MINSKY_MCP_AUTH_TOKEN").ok();
    let conversation_id = std::env::var("CLAUDE_CODE_SESSION_ID").ok();

    // Spike-only diagnostic: record the conversation id this process actually
    // observed at startup, so the measurement run has an authoritative value
    // to compare against what the daemon's diagnostic capture logs receive.
    // Not part of the shim's real job -- only active when the env var is set.
    if let Ok(selflog_path) = std::env::var("MINSKY_SHIM_SELFLOG") {
        let pid = std::process::id();
        let line = format!(
            "{{\"pid\":{pid},\"conversation_id\":{}}}\n",
            conversation_id
                .as_deref()
                .map(|s| format!("{s:?}"))
                .unwrap_or_else(|| "null".to_string())
        );
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&selflog_path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("failed to build HTTP client");

    let mut mcp_session_id: Option<String> = None;
    let mut protocol_version: Option<String> = None;

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // EOF/closed pipe -- parent exited
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[shim] failed to parse stdin line as JSON: {e}");
                continue;
            }
        };

        // Remember the negotiated protocol version from the client's own
        // initialize request so we can echo it on subsequent requests.
        if msg.get("method").and_then(Value::as_str) == Some("initialize") {
            if let Some(pv) = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
            {
                protocol_version = Some(pv.to_string());
            }
        }

        // Stamp _meta["io.minsky/agent_id"] on tools/call only.
        if msg.get("method").and_then(Value::as_str) == Some("tools/call") {
            if let Some(id) = &conversation_id {
                inject_agent_id(&mut msg, id);
            }
        }

        let body = serde_json::to_string(&msg).unwrap_or_else(|_| trimmed.to_string());

        let mut req = client
            .post(&daemon_url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body);

        if let Some(token) = &auth_token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        if let Some(sid) = &mcp_session_id {
            req = req.header("mcp-session-id", sid);
        }
        if let Some(pv) = &protocol_version {
            req = req.header("mcp-protocol-version", pv);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[shim] HTTP request failed: {e}");
                continue;
            }
        };

        if let Some(sid) = resp.headers().get("mcp-session-id") {
            if let Ok(s) = sid.to_str() {
                mcp_session_id = Some(s.to_string());
            }
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[shim] failed to read response body: {e}");
                continue;
            }
        };
        let text = String::from_utf8_lossy(&bytes);

        if content_type.contains("text/event-stream") {
            // Spike-only limitation, documented rather than fixed (non-blocking reviewer
            // finding): per-event `data:` lines are joined with embedded "\n" if a single SSE
            // event legitimately spans multiple `data:` lines. That is safe ONLY because every
            // MCP JSON-RPC message the daemon emits is `JSON.stringify`'d without pretty-printing
            // -- a single line, one `data:` per event -- which is what this measurement's real
            // `claude` traffic actually produced (verified in the captured runs). A shim carrying
            // production traffic from an SSE source that legitimately multi-lines its payload
            // would need to preserve the embedded newlines correctly instead of writing them into
            // what stdio expects to be one JSON-RPC line.
            for event in text.split("\n\n") {
                let mut data_lines = Vec::new();
                for l in event.lines() {
                    if let Some(rest) = l.strip_prefix("data:") {
                        data_lines.push(rest.trim_start());
                    }
                }
                if data_lines.is_empty() {
                    continue;
                }
                let data = data_lines.join("\n");
                write_stdout_line(&mut stdout, &data);
            }
        } else if !text.trim().is_empty() {
            write_stdout_line(&mut stdout, text.trim());
        }
    }
}

fn inject_agent_id(msg: &mut Value, agent_id: &str) {
    let params = msg.as_object_mut().and_then(|o| o.get_mut("params"));
    let params = match params {
        Some(p) if p.is_object() => p,
        _ => {
            // No params object (unusual for tools/call, but be defensive):
            // create one.
            if let Some(obj) = msg.as_object_mut() {
                obj.insert("params".to_string(), serde_json::json!({}));
                obj.get_mut("params").unwrap()
            } else {
                return;
            }
        }
    };
    let params_obj = params.as_object_mut().unwrap();
    let meta = params_obj
        .entry("_meta".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(meta_obj) = meta.as_object_mut() {
        // Preserve an already-present, more-specific caller-declared id
        // (mirrors the production stdio proxy's injectAgentIdMeta semantics).
        if !meta_obj.contains_key(META_KEY) {
            meta_obj.insert(META_KEY.to_string(), Value::String(agent_id.to_string()));
        }
    }
}

fn write_stdout_line(stdout: &mut io::Stdout, line: &str) {
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}
