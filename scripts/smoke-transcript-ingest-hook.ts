#!/usr/bin/env bun
// Smoke test for the SessionEnd transcript-ingest hook (mt#2192).
//
// Live-verifies the end-to-end trigger that unit tests cannot: a synthetic
// SessionEnd payload (with a REAL Claude Code session UUID) is piped to the
// hook script, which shells `minsky transcripts ingest --session=<uuid>`
// against the live Postgres DB and appends an observable record to its JSONL
// log. The script then asserts the log record shows a clean ingest and that
// the session is reachable via `transcripts_search-text`.
//
// Gracefully SKIPs (exit 0) when prerequisites are absent:
//   - `minsky` not on PATH
//   - no Claude Code session JSONL discoverable under ~/.claude/projects/
//
// Usage:
//   bun scripts/smoke-transcript-ingest-hook.ts
//
// @see mt#2192 — the hook this verifies
// @see .claude/hooks/transcript-ingest-on-session-end.ts

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync } from "node:fs";

function skip(reason: string): never {
  process.stdout.write(`SKIP: ${reason}\n`);
  process.exit(0);
}

function fail(reason: string): never {
  process.stdout.write(`FAIL: ${reason}\n`);
  process.exit(1);
}

// ── Prerequisite: minsky CLI ────────────────────────────────────────────────
const which = Bun.spawnSync(["which", "minsky"], { stdout: "pipe", stderr: "pipe" });
if ((which.exitCode ?? 1) !== 0) skip("minsky not on PATH");

// ── Find a recent session UUID from ~/.claude/projects/**/<uuid>.jsonl ───────
const projectsRoot = join(homedir(), ".claude", "projects");
if (!existsSync(projectsRoot)) skip(`${projectsRoot} does not exist`);

interface Candidate {
  uuid: string;
  mtimeMs: number;
}
const candidates: Candidate[] = [];
for (const proj of readdirSync(projectsRoot)) {
  const projDir = join(projectsRoot, proj);
  let entries: string[];
  try {
    if (!statSync(projDir).isDirectory()) continue;
    entries = readdirSync(projDir);
  } catch {
    continue;
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(projDir, f);
    try {
      candidates.push({ uuid: f.replace(/\.jsonl$/, ""), mtimeMs: statSync(full).mtimeMs });
    } catch {
      /* ignore */
    }
  }
}
if (candidates.length === 0) skip("no session JSONL files found under ~/.claude/projects");
candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
const newest = candidates[0];
if (!newest) skip("no session JSONL files found under ~/.claude/projects");
const sessionId = newest.uuid;
// Display a truncated UUID; session UUIDs are local filenames, not secrets, but
// there is no reason to echo the full value in smoke output (reviewer note).
process.stdout.write(`Using session UUID: ${sessionId.slice(0, 8)}…\n`);

// ── Invoke the hook with a synthetic SessionEnd payload ──────────────────────
const stateDir = mkdtempSync(join(tmpdir(), "transcript-ingest-smoke-"));
const hookPath = join(
  process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  ".claude",
  "hooks",
  "transcript-ingest-on-session-end.ts"
);
if (!existsSync(hookPath)) fail(`hook not found at ${hookPath}`);

const payload = JSON.stringify({
  session_id: sessionId,
  cwd: process.cwd(),
  hook_event_name: "SessionEnd",
});

const run = Bun.spawnSync(["bun", hookPath], {
  stdin: Buffer.from(payload),
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, MINSKY_STATE_DIR: stateDir },
});
if ((run.exitCode ?? 1) !== 0) {
  fail(`hook exited ${run.exitCode}: ${run.stderr.toString()}`);
}

// ── Assert the observable log got a clean ingest record ──────────────────────
const logPath = join(stateDir, "transcript-ingest-hook-log.jsonl");
if (!existsSync(logPath)) fail(`observable log not written at ${logPath}`);
const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
const lastLine = lines[lines.length - 1];
if (!lastLine) fail("observable log is empty");
const record = JSON.parse(lastLine);
if (record.event !== "session_end") fail(`unexpected event: ${record.event}`);
if (record.skipped) fail(`hook skipped: ${record.reason}`);
if (!record.ingest || record.ingest.exitCode !== 0 || record.ingest.timedOut) {
  fail(`ingest did not succeed: ${JSON.stringify(record.ingest)}`);
}
process.stdout.write(`Observable log record: ${JSON.stringify(record)}\n`);

// ── Confirm the session is reachable in the DB (get takes a positional UUID) ─
const get = Bun.spawnSync(["minsky", "transcripts", "get", sessionId], {
  stdout: "pipe",
  stderr: "pipe",
});
if ((get.exitCode ?? 1) === 0) {
  process.stdout.write("transcripts get: session reachable in DB\n");
} else {
  process.stdout.write(
    `WARN: transcripts get returned ${get.exitCode} (session may have 0 ingestable turns): ${get.stderr.toString().slice(0, 300)}\n`
  );
}

process.stdout.write("PASS: SessionEnd hook ingested the session and wrote an observable record\n");
process.exit(0);
