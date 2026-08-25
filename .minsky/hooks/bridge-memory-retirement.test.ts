/**
 * Tests for the bridge-memory-retirement hook's candidate lookup (mt#4449).
 *
 * This file did not exist before mt#4449, which is the proximate reason the
 * hook shipped with `--output json` — an argument `minsky memory search` does
 * not accept — and reported "no candidates to retire" on every invocation for
 * its entire life. Nothing executed `searchBridgeCandidates`, so nothing
 * observed that its subprocess exited 1.
 *
 * The first describe block below is therefore the load-bearing one: it asserts
 * the ARGV, because the argv was the defect.
 */

import { describe, test, expect } from "bun:test";
import {
  lookupBridgeCandidates,
  parseListOutput,
  isBridgeCandidate,
  decide,
  OVERRIDE_ENV_VAR,
  type MemoryRecordLite,
} from "./bridge-memory-retirement";
import type { ExecResult, ToolHookInput } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Label reused across the parse assertions below. */
const PARSED_PAYLOAD = "the parsed payload";

/** Narrow away null/undefined with a real failure message instead of a `!`. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}

/** An `exec` stub that records the argv it was handed and returns a canned result. */
function stubExec(result: Partial<ExecResult>): {
  exec: (cmd: string[], options?: { timeout?: number }) => ExecResult;
  calls: { cmd: string[]; timeout?: number }[];
} {
  const calls: { cmd: string[]; timeout?: number }[] = [];
  return {
    calls,
    exec: (cmd, options) => {
      calls.push({ cmd, timeout: options?.timeout });
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    },
  };
}

/** A `memory list` payload carrying the given records. */
function listPayload(records: Partial<MemoryRecordLite>[]): string {
  return JSON.stringify({
    records: records.map((r, i) => ({
      id: r.id ?? `id-${i}`,
      name: r.name ?? `name-${i}`,
      description: r.description ?? "",
      content: r.content ?? "",
      tags: r.tags ?? [],
    })),
    returned: records.length,
    total: records.length,
    truncated: false,
  });
}

/** A DONE transition on `tasks_status_set` for the given task. */
function doneInput(taskId: string): ToolHookInput {
  return {
    tool_name: "mcp__minsky__tasks_status_set",
    tool_input: { taskId },
    tool_result: { success: true, status: "DONE" },
  } as unknown as ToolHookInput;
}

/** Capture everything written to stdout while `fn` runs. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

/** Capture everything written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// The argv — the actual defect
// ---------------------------------------------------------------------------

describe("lookupBridgeCandidates argv", () => {
  test("queries the exact association, and passes NO --output flag", () => {
    const { exec, calls } = stubExec({ stdout: listPayload([]) });

    lookupBridgeCandidates("mt#4494", 7000, exec);

    expect(calls).toHaveLength(1);
    const cmd = must(calls[0], "the recorded call").cmd;

    // The exact instrument, in order.
    expect(cmd).toEqual([
      "minsky",
      "memory",
      "list",
      "--association-type",
      "tracksTask",
      "--association-target",
      "mt#4494",
      "--all-projects",
    ]);

    // The regression itself: `--output` is not a flag any minsky command
    // accepts (outside `tasks deps --output <file>`). Passing it makes the
    // process exit 1 before doing any work.
    expect(cmd).not.toContain("--output");

    // A semantic search is not the instrument for an identifier.
    expect(cmd).not.toContain("search");

    // Load-bearing, and easy to "tidy" away: without it, ADR-021 project
    // scoping drops every `scope: "user"` memory — 49 of 168 tracksTask
    // carriers, and 7 of 7 for mt#1034.
    expect(cmd).toContain("--all-projects");

    // No `--limit`: a limit turns an exact filter back into a ranked prefix.
    expect(cmd).not.toContain("--limit");
  });

  test("passes the caller's timeout through to the subprocess", () => {
    const { exec, calls } = stubExec({ stdout: listPayload([]) });
    lookupBridgeCandidates("mt#1", 1234, exec);
    expect(must(calls[0], "the recorded call").timeout).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// AT1 — found regardless of how the prose embeds
// ---------------------------------------------------------------------------

describe("exact lookup vs. prose (AT1)", () => {
  test("finds a memory whose prose is deliberately unlike the task, because the association is exact", () => {
    // Prose shares no vocabulary with any plausible task title for mt#9999 —
    // exactly the case an embedding-ranked search returns neighbours for and
    // misses the exact match on.
    const record = {
      id: "mem-1",
      name: "unrelated_sounding_record",
      description: "Pelicans, tide charts, and the price of tin.",
      content: "Tracking task: mt#9999\n\nNothing here resembles the task's title.",
    };
    const { exec } = stubExec({ stdout: listPayload([record]) });

    const lookup = lookupBridgeCandidates("mt#9999", 7000, exec);

    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.candidates).toHaveLength(1);
    expect(must(lookup.candidates[0], "the single candidate").id).toBe("mem-1");
  });

  test("isBridgeCandidate accepts that record on its 'Tracking task' marker", () => {
    const record: MemoryRecordLite = {
      id: "mem-1",
      name: "n",
      description: "Pelicans, tide charts, and the price of tin.",
      content: "Tracking task: mt#9999",
    };
    expect(isBridgeCandidate(record, "mt#9999")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AT3 / SC4 — failure and clean-zero must not collapse
// ---------------------------------------------------------------------------

describe("failure is distinguishable from a clean zero (SC4)", () => {
  test("a clean zero reports ok with an empty candidate list", () => {
    const { exec } = stubExec({ stdout: listPayload([]) });
    const lookup = lookupBridgeCandidates("mt#1", 7000, exec);

    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.candidates).toEqual([]);
  });

  test("a non-zero exit reports NOT-ok and names the exit code and stderr", () => {
    const { exec } = stubExec({
      exitCode: 1,
      stdout: "",
      stderr: "error: unknown option '--output'",
    });
    const lookup = lookupBridgeCandidates("mt#1", 7000, exec);

    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toContain("exited 1");
    expect(lookup.reason).toContain("unknown option");
  });

  test("a timeout reports NOT-ok and says so", () => {
    const { exec } = stubExec({ exitCode: 0, timedOut: true });
    const lookup = lookupBridgeCandidates("mt#1", 7000, exec);

    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toContain("timed out");
  });

  test("unparseable stdout reports NOT-ok rather than an empty result", () => {
    const { exec } = stubExec({ stdout: "not json at all" });
    const lookup = lookupBridgeCandidates("mt#1", 7000, exec);

    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.reason).toContain("parse");
  });
});

// ---------------------------------------------------------------------------
// AT2 — the fail-open contract survives, and the failure is announced
// ---------------------------------------------------------------------------

describe("decide fail-open contract (AT2)", () => {
  test("emits nothing when the lookup cleanly finds no candidates, and stays quiet", () => {
    let out: string | null = "unset";
    const stderr = captureStderr(() => {
      out = decide(doneInput("mt#1"), () => ({ ok: true, candidates: [] }));
    });
    expect(out).toBeNull();
    expect(stderr).toBe("");
  });

  test("emits nothing when the lookup FAILS, but says so on stderr", () => {
    let out: string | null = "unset";
    const stderr = captureStderr(() => {
      out = decide(doneInput("mt#1"), () => ({ ok: false, reason: "boom" }));
    });
    expect(out).toBeNull();
    expect(stderr).toContain("FAILED");
    expect(stderr).toContain("boom");
    // The whole point: this state must not read as "no candidates found".
    expect(stderr).toContain('not the same as "no candidates found"');
  });

  test("builds a reminder naming each candidate when the lookup finds some", () => {
    const out = decide(doneInput("mt#9999"), () => ({
      ok: true,
      candidates: [{ id: "mem-1", name: "bridge_thing", description: "", content: "" }],
    }));
    const reminder = must(out, "the reminder");
    expect(reminder).toContain("mt#9999");
    expect(reminder).toContain("mem-1");
    expect(reminder).toContain("bridge_thing");
  });

  test("emits no context when the override env var is set, and audits to stderr not stdout", () => {
    const prior = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    let out: string | null = "unset";
    let stderr = "";
    try {
      const stdout = captureStdout(() => {
        stderr = captureStderr(() => {
          out = decide(doneInput("mt#1"), () => ({
            ok: true,
            candidates: [{ id: "m", name: "n", description: "", content: "" }],
          }));
        });
      });
      expect(out).toBeNull();

      // stdout carries ONLY the HookOutput JSON object. `types.ts`: "Claude
      // Code discards a hook's ENTIRE output when stdout carries anything
      // besides the single JSON object, which silently voids even a different
      // guard's `deny`" (mt#3625). This branch emits no JSON, so stdout must
      // be completely empty.
      expect(stdout).toBe("");
      expect(stderr).toContain("override active");
    } finally {
      if (prior === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// parseListOutput
// ---------------------------------------------------------------------------

describe("parseListOutput", () => {
  test("reads the { records: [...] } shape memory list actually emits", () => {
    const parsed = must(parseListOutput(listPayload([{ id: "a", name: "n-a" }])), PARSED_PAYLOAD);
    expect(parsed.records).toHaveLength(1);
    expect(must(parsed.records[0], "the first record").id).toBe("a");
  });

  test("tolerates warning lines printed before the JSON body", () => {
    const noisy = `warning: something chatty\n${listPayload([{ id: "a", name: "n-a" }])}`;
    const parsed = must(parseListOutput(noisy), PARSED_PAYLOAD);
    expect(must(parsed.records[0], "the first record").id).toBe("a");
  });

  test("drops malformed records rather than failing the whole parse", () => {
    const payload = JSON.stringify({
      records: [{ id: "good", name: "ok" }, { id: 42 }, null, "nope"],
    });
    const parsed = must(parseListOutput(payload), PARSED_PAYLOAD);
    expect(parsed.records).toHaveLength(1);
    expect(must(parsed.records[0], "the surviving record").id).toBe("good");
  });

  test("returns null on non-JSON so the caller can report a failure", () => {
    expect(parseListOutput("not json at all")).toBeNull();
    expect(parseListOutput("")).toBeNull();
  });

  test("an empty records array is a successful parse, not a failure", () => {
    const parsed = must(parseListOutput(listPayload([])), PARSED_PAYLOAD);
    expect(parsed.records).toEqual([]);
  });
});
