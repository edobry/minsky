// Types for Claude Code hook stdin/stdout contract
// Utility: spawnSync wrapper that returns { exitCode, stdout, stderr } without throwing

export interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
}

export interface ToolHookInput extends ClaudeHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
}

export interface StopHookInput extends ClaudeHookInput {
  agent_id?: string;
  reason?: string;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}

// Sync exec helper — returns exit code + output without throwing
export function execSync(
  cmd: string[],
  options?: { cwd?: string }
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

// Read hook input from stdin
export async function readInput<T = ClaudeHookInput>(): Promise<T> {
  return (await Bun.stdin.json()) as T;
}

// Write hook output to stdout
export function writeOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output));
}
