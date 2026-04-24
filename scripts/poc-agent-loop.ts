/**
 * PoC for mt#216: run a Minsky task lifecycle without Claude Code as the harness.
 *
 * Connects to the Minsky MCP server via stdio, drives a scripted sequence of tool
 * calls through a full task lifecycle, and prints observations about what breaks
 * or requires harness-specific context.
 *
 * This is level 1: no LLM in the loop. The sequence is hardcoded. The point is to
 * prove that a non-Claude-Code process can drive Minsky end-to-end, and to surface
 * the gaps — not to demonstrate LLM reasoning over MCP tools.
 *
 * Run: bun run scripts/poc-agent-loop.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Observation tracking ──────────────────────────────────────────────────
type Observation = { step: string; kind: "success" | "gap" | "friction"; note: string };
const observations: Observation[] = [];

function observe(step: string, kind: Observation["kind"], note: string): void {
  observations.push({ step, kind, note });
  const icon = kind === "success" ? "✓" : kind === "gap" ? "⚠ GAP" : "⚠ FRICTION";
  console.log(`  [${icon}] ${note}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("PoC: driving Minsky MCP server from outside Claude Code\n");

  // 1. Connect
  console.log("Step 1: Connect to MCP server via stdio");
  // The MCP server's cwd determines its workspace. From inside a session, session.start
  // refuses to run (nested-session guard). Point cwd at the main workspace.
  // Resolution order: $MINSKY_MAIN_WORKSPACE env var → current working directory.
  const mainWorkspace = process.env.MINSKY_MAIN_WORKSPACE ?? process.cwd();
  if (!process.env.MINSKY_MAIN_WORKSPACE) {
    console.log(`  (using cwd=${mainWorkspace}; set MINSKY_MAIN_WORKSPACE to override)`);
  }
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/cli.ts", "mcp", "start"],
    cwd: mainWorkspace,
  });
  const client = new Client({ name: "poc-agent-loop", version: "0.1.0" });
  try {
    await client.connect(transport);
    observe("connect", "success", "Stdio transport connected on first try");
    observe(
      "connect",
      "friction",
      "Had to set cwd on the MCP subprocess to the main workspace — running from inside a session triggered a nested-session guard on session.start. Agents need to know which path counts as 'main workspace'."
    );
  } catch (err) {
    observe("connect", "gap", `Connection failed: ${(err as Error).message}`);
    throw err;
  }

  // 2. List tools
  console.log("\nStep 2: List available tools");
  const { tools } = await client.listTools();
  observe("list-tools", "success", `Server exposes ${tools.length} tools`);
  observe(
    "list-tools",
    "friction",
    "Tool names use dotted notation (tasks.create, session.commit) — different from the mcp__minsky__tasks_create form Claude Code exposes. An external agent must discover this by listing."
  );
  const hasTask = tools.find((t) => t.name === "tasks.create");
  const hasSession = tools.find((t) => t.name === "session.start");
  const hasCommit = tools.find((t) => t.name === "session.commit");
  if (!hasTask || !hasSession || !hasCommit) {
    observe("list-tools", "gap", "Missing one of: tasks.create, session.start, session.commit");
  } else {
    observe("list-tools", "success", "tasks.create, session.start, session.commit all present");
  }

  // 3. Create a task
  console.log("\nStep 3: Create a throwaway task");
  let taskId: string | undefined;
  try {
    const specBody = [
      "## Summary",
      "PoC artifact — automated test of Minsky task lifecycle from outside Claude Code.",
      "",
      "## Success Criteria",
      "- [x] Task created via MCP from external client",
      "",
      "## Acceptance Tests",
      "- n/a (PoC artifact)",
    ].join("\n");
    const result = await client.callTool({
      name: "tasks.create",
      arguments: {
        title: "PoC: external-harness task lifecycle test",
        spec: specBody,
      },
    });
    observe(
      "tasks-create",
      "friction",
      "Param is named `spec`, not `description`. No docs mention this; must inspect the tool schema."
    );
    const text = extractText(result);
    const match = /(mt#\d+|gh#\d+)/.exec(text);
    taskId = match?.[1];
    if (!taskId) {
      observe(
        "tasks-create",
        "gap",
        `Could not parse task ID from response: ${text.slice(0, 120)}`
      );
      throw new Error("Task ID not parseable — cannot continue lifecycle");
    }
    observe("tasks-create", "success", `Created ${taskId}`);
  } catch (err) {
    observe("tasks-create", "gap", `tasks_create failed: ${(err as Error).message}`);
    throw err;
  }

  // 4. Transition to READY (sessions can't start from TODO/PLANNING)
  console.log("\nStep 4: Transition task to READY");
  try {
    await client.callTool({
      name: "tasks.status.set",
      arguments: { taskId, status: "PLANNING" },
    });
    await client.callTool({
      name: "tasks.status.set",
      arguments: { taskId, status: "READY" },
    });
    observe("status-transition", "success", "TODO → PLANNING → READY completed");
    observe(
      "status-transition",
      "friction",
      "Two sequential calls required for valid transition; an agent would need to know the lifecycle graph"
    );
  } catch (err) {
    observe("status-transition", "gap", `Status transition failed: ${(err as Error).message}`);
    throw err;
  }

  // 5. Start a session
  console.log("\nStep 5: Start a session for the task");
  let sessionId: string | undefined;
  let _sessionDir: string | undefined;
  try {
    const result = await client.callTool({
      name: "session.start",
      arguments: {
        task: taskId,
        quiet: false,
        noStatusUpdate: false,
        skipInstall: false,
        recover: false,
      },
    });
    const text = extractText(result);
    // session.start returns JSON, not prose
    try {
      const parsed = JSON.parse(text);
      sessionId = parsed?.session?.session;
    } catch {
      // fallback — some tools return prose
      const idMatch = /Session ID:\s*([a-f0-9-]+)/.exec(text);
      sessionId = idMatch?.[1];
    }
    if (!sessionId) {
      observe("session-start", "gap", `Could not parse session ID: ${text.slice(0, 200)}`);
      throw new Error("Session ID not parseable — cannot continue lifecycle");
    }
    observe("session-start", "success", `Session ${sessionId.slice(0, 8)}... started`);
    observe(
      "session-start",
      "friction",
      "Response is JSON, not prose — tool output format is tool-specific. Agents need per-tool parsers or a uniform envelope."
    );
  } catch (err) {
    observe("session-start", "gap", `session_start failed: ${(err as Error).message}`);
    throw err;
  }

  // 6. Get session directory so we can edit a file
  console.log("\nStep 6: Resolve session directory");
  try {
    if (!sessionId) throw new Error("sessionId missing — cannot call session.dir");
    const result = await client.callTool({
      name: "session.dir",
      arguments: { name: sessionId },
    });
    const dirText = extractText(result).trim();
    try {
      const parsed = JSON.parse(dirText);
      _sessionDir = parsed?.directory || parsed?.path || parsed?.dir || dirText;
    } catch {
      _sessionDir = dirText;
    }
    observe("session-dir", "success", `Session dir resolved`);
  } catch (err) {
    observe("session-dir", "gap", `session_dir failed: ${(err as Error).message}`);
    throw err;
  }

  // 7. Edit a file in the session
  console.log("\nStep 7: Create a trivial file in the session");
  try {
    await client.callTool({
      name: "session.write_file",
      arguments: {
        sessionId,
        path: "scripts/poc-artifact.txt",
        content: `PoC artifact for mt#216\nCreated by poc-agent-loop.ts at ${new Date().toISOString()}\n`,
        createDirs: true,
      },
    });
    observe(
      "session-edit",
      "friction",
      "createDirs is 'required' in the MCP schema even though it has a default — Zod schema generation quirk forces external agents to pass defaulted booleans"
    );
    observe("session-edit", "success", "session_write_file created poc-artifact.txt");
    observe(
      "session-edit",
      "gap",
      "No equivalent of Claude Code PostToolUse[Write] → typecheck-on-edit fired; no eager type feedback"
    );
  } catch (err) {
    observe("session-edit", "gap", `session_write_file failed: ${(err as Error).message}`);
    throw err;
  }

  // 8. Commit
  console.log("\nStep 8: Commit the change via session_commit");
  try {
    const result = await client.callTool({
      name: "session.commit",
      arguments: {
        sessionId,
        message: "chore(mt#216): PoC artifact from external agent loop",
        all: true,
        amend: false,
        noStage: false,
        oneline: false,
        noFiles: false,
      },
    });
    const text = extractText(result);
    let committed = false;
    try {
      const parsed = JSON.parse(text);
      committed = parsed?.success === true && typeof parsed?.commitHash === "string";
    } catch {
      // legacy prose response
      committed = text.includes("Committed");
    }
    if (committed) {
      observe("session-commit", "success", "Commit succeeded; pre-commit hook must have passed");
      observe(
        "session-commit",
        "success",
        "Git hooks (portable enforcement) fired without any harness involvement — expected result"
      );
    } else {
      observe("session-commit", "friction", `Commit output unclear: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    observe("session-commit", "friction", `session_commit failed: ${(err as Error).message}`);
  }

  // 9. Attempt to create a PR (the last lifecycle step)
  console.log("\nStep 9: Create a draft PR for the PoC change");
  let prUrl: string | undefined;
  try {
    const result = await client.callTool({
      name: "session.pr.create",
      arguments: {
        sessionId,
        title: "PoC artifact (automated) — will be closed immediately",
        type: "chore",
        body: "Auto-generated by mt#216 PoC agent loop. Safe to close.",
        draft: true,
        debug: false,
        noStatusUpdate: true,
        autoResolveDeleteConflicts: false,
        skipConflictCheck: false,
      },
    });
    const text = extractText(result);
    const urlMatch = /https:\/\/github\.com\/[^\s"]+\/pull\/\d+/.exec(text);
    prUrl = urlMatch?.[0];
    if (prUrl) {
      observe("pr-create", "success", `Draft PR created: ${prUrl}`);
    } else {
      observe("pr-create", "friction", `PR created but URL not parseable: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    observe(
      "pr-create",
      "gap",
      `session.pr.create failed: ${(err as Error).message.slice(0, 200)}`
    );
  }

  // 10. Summarize gaps that are now known without needing to try them
  console.log("\nStep 10: Known gaps (from mt#054 audit; would need to be tested to confirm)");
  observe(
    "known-gap",
    "gap",
    "review-before-merge: this PoC could try session_pr_merge and it would succeed without a review (Claude Code hook doesn't fire)"
  );
  observe(
    "known-gap",
    "gap",
    "typecheck-gate (Stop/SubagentStop): there's no turn concept here; nothing enforces zero type errors at end-of-session"
  );
  observe(
    "known-gap",
    "gap",
    "acceptance-test-gate: could set task to DONE without acknowledging acceptance tests"
  );
  observe(
    "known-gap",
    "gap",
    "task-spec-validation: tasks_create succeeded even though this is a PostToolUse advisory — no warning surfaced"
  );
  observe(
    "known-gap",
    "gap",
    "prompt-watermark-enforcement: inapplicable — there's no Agent tool dispatch in this harness"
  );
  observe(
    "known-gap",
    "friction",
    "block-git-gh-cli: inapplicable — external agent could call raw git and bypass MCP tool preference entirely"
  );

  // 11. Cleanup — mark task as CLOSED so it doesn't clutter the task list
  console.log("\nStep 11: Close the PoC task");
  try {
    await client.callTool({
      name: "tasks.status.set",
      arguments: { taskId, status: "CLOSED" },
    });
    observe("cleanup", "success", `Task ${taskId} marked CLOSED`);
  } catch (err) {
    observe("cleanup", "friction", `Could not close task: ${(err as Error).message}`);
  }

  // ─── Report ─────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log("OBSERVATIONS SUMMARY");
  console.log("═".repeat(72));
  const successes = observations.filter((o) => o.kind === "success").length;
  const gaps = observations.filter((o) => o.kind === "gap").length;
  const frictions = observations.filter((o) => o.kind === "friction").length;
  console.log(`\n${successes} successes, ${gaps} gaps, ${frictions} friction points\n`);

  console.log("GAPS (enforcement or infrastructure that's missing outside Claude Code):");
  for (const o of observations.filter((o) => o.kind === "gap")) {
    console.log(`  • [${o.step}] ${o.note}`);
  }
  console.log("\nFRICTION (works but would hurt at scale):");
  for (const o of observations.filter((o) => o.kind === "friction")) {
    console.log(`  • [${o.step}] ${o.note}`);
  }

  await client.close();
  console.log("\nPoC complete.");
}

function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return "";
  const parts: string[] = [];
  for (const c of r.content) {
    if (c.type === "text" && c.text) parts.push(c.text);
  }
  return parts.join("\n");
}

main().catch((err) => {
  console.error("\nPoC FAILED:", err);
  process.exit(1);
});
