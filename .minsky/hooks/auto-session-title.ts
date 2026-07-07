#!/usr/bin/env bun
import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { existsSync, readFileSync, unlinkSync } from "fs";

async function main(): Promise<void> {
  const input = await readInput<ClaudeHookInput>();
  const sessionId = input.session_id;

  const labelFile = `/tmp/claude-session-label-${sessionId}.json`;

  if (!existsSync(labelFile)) {
    process.exit(0);
  }

  let taskId: string;
  let title: string;

  try {
    const contents = readFileSync(labelFile, "utf8");
    const data = JSON.parse(contents) as { taskId: string; title: string };
    taskId = data.taskId;
    title = data.title;
  } catch {
    // If we can't read/parse the file, clean it up and exit
    try {
      unlinkSync(labelFile);
    } catch {
      // Ignore cleanup errors
    }
    process.exit(0);
  }

  // Delete the file so it's only consumed once
  try {
    unlinkSync(labelFile);
  } catch {
    // Ignore cleanup errors
  }

  const sessionTitle = `${taskId} — ${title}`;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      sessionTitle,
    } as HookOutput["hookSpecificOutput"] & { sessionTitle: string },
  };

  writeOutput(output);
  process.exit(0);
}

main().catch(() => process.exit(0));
