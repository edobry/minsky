import { describe, expect, it } from "bun:test";

import { classifyExecFailure, executeCommand } from "@minsky/shared/exec";
import { buildSessionExecFailureResult } from "./basic-commands";
import { sessionExecCommandParams } from "./session-parameters";

// ---------------------------------------------------------------------------
// mt#3909 — session_exec must distinguish "your command failed" from
// "we killed your command".
//
// These drive the pure result-shaper with REAL errors from real spawns, so both
// halves are exercised without standing up a session or patching the handler's
// dynamic imports.
// ---------------------------------------------------------------------------

const CONTEXT = { timeoutMs: 120_000, workdir: "/tmp/session-workdir" };

async function catchExecError(command: string, timeout?: number): Promise<unknown> {
  try {
    await executeCommand(command, timeout === undefined ? {} : { timeout });
    throw new Error(`expected \`${command}\` to fail, but it succeeded`);
  } catch (error) {
    return error;
  }
}

describe("buildSessionExecFailureResult", () => {
  it("reports a genuine non-zero exit with its real code and no timeout flag", async () => {
    const error = await catchExecError("exit 3");
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.failureKind).toBe("exit");
    expect(result.timedOut).toBe(false);
    // The negative control against "fix it by flagging everything as a timeout".
    expect(result.descendantsMaySurvive).toBeUndefined();
  });

  // The load-bearing assertion. Before mt#3909 this and the case above both
  // produced `exitCode: 1` with nothing to tell them apart — which is what made
  // a killed command look like a failed one and invited a retry.
  it("flags a timeout kill, and does not present it as an exit code", async () => {
    const error = await catchExecError("sleep 5", 150);
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.timedOut).toBe(true);
    expect(result.failureKind).toBe("timeout");
    expect(result.timeoutMs).toBe(CONTEXT.timeoutMs);
    expect(result.killedSignal).toBe("SIGTERM");
  });

  // Criterion 2: a killed shell can leave grandchildren running, and the result
  // has to say so — that is exactly how the originating incident's log looked
  // like a success while the tool reported failure.
  it("warns that descendants may outlive a timeout kill", async () => {
    const error = await catchExecError("sleep 5", 150);
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.descendantsMaySurvive).toBe(true);
  });

  // Criterion 4, answered empirically rather than assumed: Node attaches the
  // bytes it captured before the kill, so nothing needs recovering.
  it("preserves output printed before the kill", async () => {
    const error = await catchExecError("echo partial-output; sleep 5", 300);
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.stdout).toContain("partial-output");
    expect(result.timedOut).toBe(true);
  });

  // Guards the latent bug found while reading the old handler: `code ?? 1` on a
  // maxBuffer overrun would have put a STRING into the numeric `exitCode`.
  it("never lets a string error code reach exitCode", () => {
    const error = Object.assign(new Error("maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      signal: "SIGTERM",
    });
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.exitCode).toBe(1);
    expect(typeof result.exitCode).toBe("number");
    expect(result.failureKind).toBe("maxbuffer");
    // A maxBuffer overrun is not a timeout — waiting longer would not help.
    expect(result.timedOut).toBe(false);
  });

  // Criterion 3. The criterion assumed the ceiling "silently overrides an explicit larger
  // request"; it does not — the schema rejects first, so an over-cap request fails loudly
  // rather than quietly becoming 120000. Pinned here because that was asserted from reading
  // the schema before it was observed, and reading is how the criterion got it wrong.
  it("rejects an over-cap timeout rather than silently clamping it", () => {
    const parsed = sessionExecCommandParams.timeout.schema.safeParse(600_000);
    expect(parsed.success).toBe(false);
  });

  it("accepts a timeout at the cap", () => {
    expect(sessionExecCommandParams.timeout.schema.safeParse(120_000).success).toBe(true);
  });

  it("carries the workdir and the error message through unchanged", async () => {
    const error = await catchExecError("exit 1");
    const result = buildSessionExecFailureResult(error, classifyExecFailure(error), CONTEXT);

    expect(result.workdir).toBe(CONTEXT.workdir);
    expect(typeof result.error).toBe("string");
  });
});
