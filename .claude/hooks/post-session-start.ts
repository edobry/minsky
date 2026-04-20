#!/usr/bin/env bun
import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import { writeFileSync } from "fs";

const COLORS: [number, number, number][] = [
  [86, 182, 194], // teal
  [210, 144, 52], // amber
  [138, 118, 206], // purple
  [92, 190, 93], // green
  [219, 104, 107], // coral
  [72, 152, 218], // blue
  [204, 168, 82], // gold
  [176, 108, 180], // magenta
  [108, 189, 152], // mint
  [218, 136, 78], // orange
];

function getColorForTaskId(taskId: string): [number, number, number] {
  // Extract numeric portion from taskId (e.g., "mt#843" -> 843)
  const match = taskId.match(/\d+/);
  const num = match ? parseInt(match[0], 10) : 0;
  return COLORS[num % COLORS.length];
}

function emitITermEscapes(taskId: string, title: string): void {
  const termProgram = process.env.TERM_PROGRAM;
  const lcTerminal = process.env.LC_TERMINAL;

  if (termProgram !== "iTerm.app" && lcTerminal !== "iTerm2") {
    return;
  }

  // Skip if running as a subagent (shares parent terminal)
  if (process.env.CLAUDE_AGENT_ID) {
    return;
  }

  const shortTitle = title.length > 50 ? title.slice(0, 47) + "..." : title;
  const tabLabel = `${taskId} — ${shortTitle}`;

  // Set tab title via OSC 1
  const ttyEscapes =
    `\x1b]1;${tabLabel}\x07` +
    (() => {
      const [r, g, b] = getColorForTaskId(taskId);
      return (
        `\x1b]6;1;bg;red;brightness;${r}\x07` +
        `\x1b]6;1;bg;green;brightness;${g}\x07` +
        `\x1b]6;1;bg;blue;brightness;${b}\x07`
      );
    })();

  try {
    // Write escape sequences directly to /dev/tty
    const ttyFd = require("fs").openSync("/dev/tty", "w");
    require("fs").writeSync(ttyFd, ttyEscapes);
    require("fs").closeSync(ttyFd);
  } catch {
    // Silently ignore if /dev/tty is not available
  }
}

async function main(): Promise<void> {
  const input = await readInput<ToolHookInput>();

  // Extract session data from tool_result
  const toolResult = input.tool_result as Record<string, unknown> | undefined;
  if (!toolResult) {
    process.exit(0);
  }

  const taskId = (toolResult.taskId as string) || "";
  const sessionId = input.session_id;

  if (!taskId) {
    process.exit(0);
  }

  // Fetch task title via minsky CLI
  let title = taskId;
  try {
    const minskyPath = "minsky";
    const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;

    const result = Bun.spawnSync([minskyPath, "tasks", "get", taskId, "--json"], {
      env: { ...process.env, PATH: pathPrefix },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode === 0) {
      const output = result.stdout.toString().trim();
      if (output) {
        const taskData = JSON.parse(output) as { title?: string };
        if (taskData.title) {
          title = taskData.title;
        }
      }
    }
  } catch {
    // Silently fall back to using taskId as title
  }

  // Emit iTerm2 escape sequences
  emitITermEscapes(taskId, title);

  // Write state file for auto-session-title hook
  const labelFile = `/tmp/claude-session-label-${sessionId}.json`;
  try {
    writeFileSync(labelFile, JSON.stringify({ taskId, title }), "utf8");
  } catch {
    // Silently ignore write errors
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
