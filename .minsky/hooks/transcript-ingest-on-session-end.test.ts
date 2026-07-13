import { describe, it, expect } from "bun:test";
import {
  runTranscriptIngestOnSessionEnd,
  isTruthy,
  type CommandResult,
  type IngestDeps,
  type SessionEndHookInput,
} from "./transcript-ingest-on-session-end";

const FIXED_NOW = new Date("2026-06-02T12:00:00.000Z");

interface Harness {
  deps: IngestDeps;
  commands: string[][];
  logLines: string[];
}

/**
 * Build a deps harness with scripted command results. `results` is consumed in
 * order; each runCommand call shifts the next result (defaulting to exit 0).
 */
function makeHarness(opts: {
  results?: CommandResult[];
  embeddingsEnabled?: boolean;
  throwOnCommandIndex?: number;
}): Harness {
  const commands: string[][] = [];
  const logLines: string[] = [];
  const results = [...(opts.results ?? [])];
  let callIndex = 0;

  const deps: IngestDeps = {
    runCommand: (cmd) => {
      const thisIndex = callIndex++;
      commands.push(cmd);
      if (opts.throwOnCommandIndex === thisIndex) {
        throw new Error("spawn failed");
      }
      return results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    appendLog: (_logPath, line) => {
      logLines.push(line);
    },
    resolveLogPath: () => "/tmp/test-transcript-ingest-hook-log.jsonl",
    now: () => FIXED_NOW,
    minskyBin: "minsky",
    embeddingsEnabled: opts.embeddingsEnabled ?? false,
  };

  return { deps, commands, logLines };
}

const input = (sessionId?: string): SessionEndHookInput =>
  ({
    session_id: sessionId as string,
    cwd: "/repo",
    hook_event_name: "SessionEnd",
  }) as SessionEndHookInput;

describe("isTruthy", () => {
  it("accepts 1/true/yes case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "yes"]) {
      expect(isTruthy(v)).toBe(true);
    }
  });
  it("rejects everything else", () => {
    for (const v of [undefined, "", "0", "false", "no", "maybe"]) {
      expect(isTruthy(v)).toBe(false);
    }
  });
});

describe("runTranscriptIngestOnSessionEnd", () => {
  it("skips and logs when session_id is missing", () => {
    const h = makeHarness({});
    const out = runTranscriptIngestOnSessionEnd(input(undefined), h.deps);

    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("no-session-id");
    expect(h.commands).toHaveLength(0);
    expect(h.logLines).toHaveLength(1);
    const record = JSON.parse(h.logLines[0] as string);
    expect(record.skipped).toBe(true);
    expect(record.event).toBe("session_end");
    expect(record.timestamp).toBe(FIXED_NOW.toISOString());
    // Log `reason` and returned `reason` must be the same string (reviewer R1).
    expect(record.reason).toBe("no-session-id");
    expect(out.reason).toBe(record.reason);
    expect(record.detail).toBe("no session_id in hook input");
  });

  it("runs ingest only (no embeddings) on the default path", () => {
    const h = makeHarness({ results: [{ exitCode: 0, stdout: "ok", stderr: "" }] });
    const out = runTranscriptIngestOnSessionEnd(input("sess-1"), h.deps);

    expect(out.skipped).toBe(false);
    expect(out.ingestExitCode).toBe(0);
    expect(out.embeddingsRan).toBe(false);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toEqual([
      "minsky",
      "transcripts",
      "ingest",
      "--session=sess-1",
      "--harness=claude_code",
    ]);

    const record = JSON.parse(h.logLines[0] as string);
    expect(record.sessionId).toBe("sess-1");
    expect(record.ingest.exitCode).toBe(0);
    expect(record.embeddings).toBeUndefined();
  });

  it("records ingest stderr on failure and does not attempt embeddings", () => {
    const h = makeHarness({
      results: [{ exitCode: 1, stdout: "", stderr: "DB unavailable" }],
      embeddingsEnabled: true,
    });
    const out = runTranscriptIngestOnSessionEnd(input("sess-2"), h.deps);

    expect(out.ingestExitCode).toBe(1);
    expect(out.embeddingsRan).toBe(false);
    // Only the ingest command ran; embeddings skipped because ingest failed.
    expect(h.commands).toHaveLength(1);

    const record = JSON.parse(h.logLines[0] as string);
    expect(record.ingest.exitCode).toBe(1);
    expect(record.ingest.stderr).toBe("DB unavailable");
    expect(record.embeddings.attempted).toBe(false);
  });

  it("treats a timed-out ingest as a failure", () => {
    const h = makeHarness({
      results: [{ exitCode: 1, stdout: "", stderr: "", timedOut: true }],
    });
    const out = runTranscriptIngestOnSessionEnd(input("sess-3"), h.deps);

    expect(out.ingestExitCode).toBe(1);
    // Timeout is surfaced in the outcome, not just the log (reviewer R1).
    expect(out.ingestTimedOut).toBe(true);
    const record = JSON.parse(h.logLines[0] as string);
    expect(record.ingest.timedOut).toBe(true);
  });

  it("runs embeddings after a successful ingest when enabled", () => {
    const h = makeHarness({
      results: [
        { exitCode: 0, stdout: "ingested", stderr: "" },
        { exitCode: 0, stdout: "embedded", stderr: "" },
      ],
      embeddingsEnabled: true,
    });
    const out = runTranscriptIngestOnSessionEnd(input("sess-4"), h.deps);

    expect(out.embeddingsRan).toBe(true);
    expect(out.embeddingsExitCode).toBe(0);
    expect(out.embeddingsTimedOut).toBe(false);
    expect(h.commands).toHaveLength(2);
    expect(h.commands[1]).toEqual([
      "minsky",
      "transcripts",
      "index-embeddings",
      "--session=sess-4",
    ]);

    const record = JSON.parse(h.logLines[0] as string);
    expect(record.embeddings.exitCode).toBe(0);
  });

  it("records embedding failure without failing the hook", () => {
    const h = makeHarness({
      results: [
        { exitCode: 0, stdout: "ingested", stderr: "" },
        { exitCode: 7, stdout: "", stderr: "no embedding provider configured" },
      ],
      embeddingsEnabled: true,
    });
    const out = runTranscriptIngestOnSessionEnd(input("sess-5"), h.deps);

    // Ingest still succeeded → FTS search works; embedding failure is logged.
    expect(out.ingestExitCode).toBe(0);
    expect(out.embeddingsRan).toBe(true);
    expect(out.embeddingsExitCode).toBe(7);
    const record = JSON.parse(h.logLines[0] as string);
    expect(record.embeddings.exitCode).toBe(7);
    expect(record.embeddings.stderr).toBe("no embedding provider configured");
  });

  it("records a thrown ingest spawn error without throwing", () => {
    const h = makeHarness({ throwOnCommandIndex: 0 });
    const out = runTranscriptIngestOnSessionEnd(input("sess-6"), h.deps);

    expect(out.skipped).toBe(false);
    expect(out.reason).toBe("ingest-threw");
    const record = JSON.parse(h.logLines[0] as string);
    expect(record.ingest.error).toBe("spawn failed");
  });
});
