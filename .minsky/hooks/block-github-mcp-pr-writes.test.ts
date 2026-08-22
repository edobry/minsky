/**
 * BINDING-level tests for the block-github-mcp-pr-writes hook.
 *
 * The DECISION tests moved to
 * `packages/domain/src/detectors/github-mcp-pr-write-denial.test.ts` with the
 * decision itself (mt#4374 SC4). What is left here is the only thing this file
 * still owns: that the binding parses a real payload, calls the decision, and
 * relays the verdict in the shape Claude Code expects.
 *
 * These run the hook as a SUBPROCESS, the way the harness runs it — so they are
 * also mt#4374 AT3's replay: a payload the pre-extraction guard denied is
 * replayed against the post-extraction guard and still denies, and one it
 * allowed still allows.
 */
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `new URL(...).pathname` — the latter percent-encodes, so
// it breaks for any checkout path containing a space (mt#4396).
const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "block-github-mcp-pr-writes.ts");

async function runHook(payload: unknown): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

describe("block-github-mcp-pr-writes binding", () => {
  it("relays a deny verdict for a GitHub PR-write tool", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "mcp__github__merge_pull_request",
      tool_input: {},
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "mcp__minsky__session_pr_merge"
    );
  });

  it("stays silent for a tool the decision permits", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "mcp__minsky__session_pr_create",
      tool_input: {},
    });

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});
