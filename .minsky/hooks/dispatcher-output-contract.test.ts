/**
 * Dispatcher OUTPUT-CONTRACT tests — what actually reaches Claude Code's stdin.
 *
 * Split out of `dispatcher.test.ts` (PR #2576 R1): that file covers the
 * dispatcher's behavioural surface via injected seams, had crossed the 1500-line
 * `max-lines` limit, and these tests are a distinct concern — they assert the
 * BYTES on stdout rather than values on a seam.
 *
 * Two mechanisms, deliberately:
 *
 * - `runInSubprocess` spawns a real `bun` process and reads its real stdout.
 *   Nothing in-process is monkeypatched, so there is no cross-test interference
 *   and no dependence on test ordering. This is how the mt#3625 stdout-invariant
 *   is pinned.
 * - In-process runs with injected seams cover the aggregation SEMANTICS
 *   (first-wins, deny-interaction), where the value matters and the transport
 *   does not.
 *
 * @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md §D1
 * @see mt#3612 (updatedInput forwarding) · mt#3625 (stdout is one JSON object)
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { runDispatcher, buildDiscardedRewriteAuditLine } from "./dispatcher";
import type { GuardRegistration } from "./registry";
import type { ToolHookInput, HookOutput } from "./types";
import {
  DISPATCH_HOOK_FILENAME,
  baseInput,
  stubContext,
  useIsolatedStateDir,
} from "./test-support/dispatcher-harness";

/** The injection-capable event, used to check the invariant holds off PreToolUse too. */
const UPS_EVENT = "UserPromptSubmit";

// Same isolation contract as dispatcher.test.ts: runDispatcher's default
// `recordFireLogEntry` writes through MINSKY_STATE_DIR, and without this every
// run in this file would append to the developer's real
// ~/.local/state/minsky/fire-log.jsonl (the mt#2876 class). The subprocess
// tests below ALSO need the path itself — a child builds its own env, so
// mutating this process's is not enough.
const getStateDir = useIsolatedStateDir("mt3625-output-contract-");

/**
 * Runs the real dispatcher in a SEPARATE bun process and returns its real
 * stdout/stderr. `guardBody` is the source of a `run()` function, embedded into
 * the child script — registrations contain closures and cannot be serialized.
 */
async function runInSubprocess(
  event: string,
  guardBody: string,
  input: ToolHookInput
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dispatcherPath = join(import.meta.dir, "dispatcher.ts");
  const script = `
    const { runDispatcher } = await import(${JSON.stringify(dispatcherPath)});
    await runDispatcher(${JSON.stringify(event)}, {
      hookFilename: ${JSON.stringify(DISPATCH_HOOK_FILENAME)},
      registrations: [
        {
          name: "subprocess-guard",
          event: ${JSON.stringify(event)},
          matcher: "Bash",
          module: () => Promise.resolve({ run: ${guardBody} }),
          timeoutMs: 5000,
          denyCapable: true,
        },
      ],
      readInputFn: () => Promise.resolve(${JSON.stringify(input)}),
      resolveDispatchContextFn: () => (${JSON.stringify(stubContext())}),
    });
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MINSKY_STATE_DIR: getStateDir() },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("stdout is exactly one JSON object (mt#3625)", () => {
  // A guard emitting BOTH a diagnostic and JSON-bound output — the exact
  // combination that produced the defect: the diagnostic used to land on stdout
  // ahead of the JSON, and Claude Code then discarded the whole output.
  const NOISY_GUARD = `() => ({
    auditLines: ["[subprocess-guard] a diagnostic line\\n"],
    additionalContext: "context that must survive",
  })`;

  test("PreToolUse: real subprocess stdout parses whole, diagnostic goes to stderr", async () => {
    const { stdout, stderr, exitCode } = await runInSubprocess(
      "PreToolUse",
      NOISY_GUARD,
      baseInput()
    );
    expect(exitCode).toBe(0);
    // The whole buffer — not a substring. A leading diagnostic line is exactly
    // what a substring assertion would miss.
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toBe("context that must survive");
    // ...and the diagnostic is not lost, just relocated.
    expect(stderr).toContain("a diagnostic line");
  });

  test("UserPromptSubmit: same invariant holds on the event that TOLERATES extra stdout", async () => {
    // mt#3625 measured that UserPromptSubmit does NOT discard on extra stdout —
    // the harness tolerates it. This pins the dispatcher's behaviour anyway:
    // tolerance is not a guarantee, and the reason the fix is not gated to
    // PreToolUse is that a future deny-capable event would inherit the defect
    // through this shared path. (PR #2576 R1 asked for this coverage.)
    const { stdout, stderr, exitCode } = await runInSubprocess(
      UPS_EVENT,
      NOISY_GUARD,
      baseInput({ hook_event_name: UPS_EVENT })
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput?.additionalContext).toBe("context that must survive");
    expect(stderr).toContain("a diagnostic line");
  });

  test("a deny reaches stdout intact even when the guard also emits a diagnostic", async () => {
    // The security-relevant shape: the audit line must not be able to void the
    // deny. Pre-fix, this stdout carried the diagnostic first and Claude Code
    // dropped the whole thing — the tool ran.
    const denyGuard = `() => ({
      auditLines: ["[subprocess-guard] override noise\\n"],
      deny: { reason: "must not be swallowed" },
    })`;
    const { stdout, stderr } = await runInSubprocess("PreToolUse", denyGuard, baseInput());
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toBe("must not be swallowed");
    expect(stderr).toContain("override noise");
  });
});

// ---------------------------------------------------------------------------
// updatedInput aggregation semantics (mt#3612)
//
// These assert VALUES, so the injected `writeOutputFn` seam is the right tool;
// the byte-level contract is covered by the subprocess tests above.
// ---------------------------------------------------------------------------

describe("updatedInput aggregation (mt#3612)", () => {
  function updatedInputGuard(
    name: string,
    updatedInput: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): GuardRegistration {
    return {
      name,
      event: "PreToolUse",
      matcher: "Bash",
      module: () => Promise.resolve({ run: () => ({ updatedInput, ...extra }) }),
      timeoutMs: 1000,
      denyCapable: false,
    };
  }

  async function run(registrations: GuardRegistration[]): Promise<{
    written: HookOutput[];
    stderr: string[];
  }> {
    const written: HookOutput[] = [];
    const stderr: string[] = [];
    await runDispatcher("PreToolUse", {
      hookFilename: DISPATCH_HOOK_FILENAME,
      registrations,
      readInputFn: () => Promise.resolve(baseInput()),
      writeOutputFn: (o) => written.push(o),
      stderrWrite: (s) => stderr.push(s),
      resolveDispatchContextFn: () => stubContext(),
    });
    return { written, stderr };
  }

  test("AT1: a guard's updatedInput is forwarded verbatim", async () => {
    const rewrite = { command: "echo rewritten", nested: { keep: true } };
    const { written } = await run([updatedInputGuard("rewriter", rewrite)]);
    expect(written.length).toBe(1);
    expect(written[0]?.hookSpecificOutput?.updatedInput).toEqual(rewrite);
  });

  test("AT2: no guard returns updatedInput -> key ABSENT from the emitted object", async () => {
    const { written } = await run([
      {
        name: "ctx-only",
        event: "PreToolUse",
        matcher: "Bash",
        module: () => Promise.resolve({ run: () => ({ additionalContext: "ctx" }) }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ]);
    const hso = (written[0]?.hookSpecificOutput ?? {}) as Record<string, unknown>;
    // `in`, not `=== undefined`: the claim is that a JSON consumer sees no key.
    expect("updatedInput" in hso).toBe(false);
    expect(hso.additionalContext).toBe("ctx");
  });

  test("AT3: a rewrite-only guard still produces output (emission-gate control)", async () => {
    // Pre-mt#3612 the final write was gated on additionalContext/sessionTitle,
    // so a rewrite-only guard emitted NOTHING. Measured negative control at the
    // time: reverting that gate failed exactly the tests whose guards return
    // `updatedInput` with no context fragment.
    const rewrite = { command: "echo only-rewrite" };
    const { written } = await run([updatedInputGuard("solo", rewrite)]);
    expect(written.length).toBe(1);
    expect(written[0]?.hookSpecificOutput?.updatedInput).toEqual(rewrite);
  });

  test("AT4: two guards -> FIRST in registry order wins, discard audited on stderr", async () => {
    const { written, stderr } = await run([
      updatedInputGuard("first", { command: "from-first" }),
      updatedInputGuard("second", { command: "from-second" }),
    ]);
    expect(written[0]?.hookSpecificOutput?.updatedInput).toEqual({ command: "from-first" });
    const discardLine = stderr.find((s) => s.includes("REWRITE-DISCARDED"));
    expect(discardLine).toBeDefined();
    expect(discardLine).toContain("guard=second");
    expect(discardLine).toContain("kept=first");
  });

  test("AT5: deny plus updatedInput -> deny wins, no updatedInput key", async () => {
    const { written } = await run([
      {
        name: "deny-and-rewrite",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => ({
              deny: { reason: "blocked" },
              updatedInput: { command: "never-applied" },
            }),
          }),
        timeoutMs: 1000,
        denyCapable: true,
      },
    ]);
    const hso = (written[0]?.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("deny");
    expect("updatedInput" in hso).toBe(false);
  });

  test("a non-denyCapable guard's deny does not suppress its updatedInput", async () => {
    // The deny branch is gated on `reg.denyCapable`, so a non-deny-capable guard
    // falls through to aggregation. Keeps AT5's "deny wins" from being read as
    // "any deny field wins".
    const { written } = await run([
      {
        name: "not-deny-capable",
        event: "PreToolUse",
        matcher: "Bash",
        module: () =>
          Promise.resolve({
            run: () => ({
              deny: { reason: "ignored — guard is not deny-capable" },
              updatedInput: { command: "applied" },
            }),
          }),
        timeoutMs: 1000,
        denyCapable: false,
      },
    ]);
    const hso = (written[0]?.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso.updatedInput).toEqual({ command: "applied" });
    expect("permissionDecision" in hso).toBe(false);
  });

  test("buildDiscardedRewriteAuditLine formats the discard record", () => {
    const line = buildDiscardedRewriteAuditLine(
      "PreToolUse",
      "loser",
      "winner",
      "sess-9",
      () => "TS"
    );
    expect(line).toBe(
      "[dispatcher:PreToolUse] REWRITE-DISCARDED: guard=loser kept=winner session=sess-9 ts=TS\n"
    );
    // R1 non-blocking: the trailing newline is part of the contract — these are
    // written verbatim, so a missing one would run two audit lines together.
    expect(line.endsWith("\n")).toBe(true);
  });
});
