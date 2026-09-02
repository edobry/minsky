/**
 * Testable core of the `concurrent_inflight` L4 smoke harness (mt#4895).
 *
 * `smoke-concurrent-inflight-skip.ts` is an imperative shell: it spawns a
 * server, posts webhooks, and talks to Postgres and GitHub. None of that can be
 * exercised without live credentials. Everything that DECIDES anything lives
 * here instead, as functions over values — so the harness's own logic is
 * covered by the suite rather than resting on a live run that has not happened
 * yet (PR #3566 R1).
 *
 * This is ADR-036 §3's functional core / imperative shell split applied to a
 * script: the shell does I/O and this decides.
 */

/**
 * Accumulate a stream's output as whole lines, and expose a COMPLETION PROMISE.
 *
 * The completion promise is the point. A background reader with no `done`
 * signal is racy: the caller kills the process and parses the accumulated lines
 * immediately, while the reader may still have buffered output to drain — so a
 * trailing log line (exactly where a terminal event like the skip or the
 * publish-failure warn lands) can be missed. That turns a real PASS into a
 * spurious FAIL and, worse, does so intermittently.
 *
 * Callers MUST `await done` after the process exits and BEFORE reading `lines`.
 *
 * Lines are kept whole so callers can `JSON.parse` each one — the reviewer's
 * winston logger emits one JSON object per line, and the assertions are on
 * FIELDS, not on a substring of the raw text.
 */
export function collectStdoutLines(stdout: ReadableStream<Uint8Array> | null): {
  lines: string[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  if (!stdout) return { lines, done: Promise.resolve() };

  const done = (async () => {
    try {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let carry = "";
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const parts = (carry + decoder.decode(value, { stream: true })).split("\n");
        carry = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed) lines.push(trimmed);
        }
      }
      // Flush a trailing newline-incomplete segment so the final write is not
      // silently dropped — the same case `log-capture.ts` handles on restore().
      if (carry.trim()) lines.push(carry.trim());
    } catch {
      // Best-effort reader: a read error must not reject and crash the script.
      // `lines` keeps whatever arrived, and the verdict is derived from that.
    }
  })();

  return { lines, done };
}

/** Every parsed log object whose `event` field equals `eventName`. */
export function findEvents(lines: string[], eventName: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["event"] === eventName) out.push(parsed);
    } catch {
      // Not JSON — skip. The server emits non-JSON banner lines too.
    }
  }
  return out;
}

export type HarnessMode = "contention" | "negative-control";

export interface VerdictInput {
  mode: HarnessMode;
  /** A skip event was observed carrying delivery B's id. */
  skipForB: boolean;
  /** A skip event was observed carrying delivery A's id — A should WIN, not skip. */
  skipForA: boolean;
  /** The `review_skip_check_run_failed` warn was observed (publish attempted, failed). */
  publishFailed: boolean;
  /** A `minsky-reviewer/findings` conclusion read back off the head sha, if any. */
  checkRunConclusion: string | null;
}

export interface Verdict {
  pass: boolean;
  /**
   * SC3. `null` in negative-control mode, where no skip is expected and so no
   * publish should be attempted — the question does not apply.
   */
  skipCheckRunAttempted: boolean | null;
  reason: string;
}

/**
 * Decide the harness's verdict from what was observed.
 *
 * Contention mode requires all three: B skipped, A did NOT (A is the winner
 * that holds the marker — a skip on A would mean something else took it, and
 * the run proves nothing about contention), and the check-run publish was
 * ATTEMPTED.
 *
 * "Attempted" is deliberately two-sided: a publish that SUCCEEDED is readable
 * as a conclusion on the sha, and one that FAILED emits the warn. Either proves
 * the skip branch ran THROUGH the publish call rather than returning before it,
 * which is the gap SC3 exists to close. Only "neither" is a failure.
 */
export function deriveVerdict(input: VerdictInput): Verdict {
  const { mode, skipForB, skipForA, publishFailed, checkRunConclusion } = input;

  if (mode === "negative-control") {
    return {
      pass: !skipForB,
      skipCheckRunAttempted: null,
      reason: skipForB
        ? "negative control FAILED: delivery B reported concurrent_inflight even though the " +
          "marker was released first — the harness cannot distinguish contention from an " +
          "unconditional skip"
        : "negative control passed: with the marker released, delivery B did NOT skip",
    };
  }

  const skipCheckRunAttempted = publishFailed || checkRunConclusion !== null;
  const pass = skipForB && !skipForA && skipCheckRunAttempted;

  return {
    pass,
    skipCheckRunAttempted,
    reason: pass
      ? `delivery B skipped with concurrent_inflight (delivery A did not), and the skip ` +
        `check-run publish was attempted${
          checkRunConclusion !== null
            ? ` (conclusion: ${checkRunConclusion})`
            : " (publish failed — warn observed)"
        }`
      : `expected exactly delivery B to skip with a publish attempt; skipForB=${skipForB} ` +
        `skipForA=${skipForA} publishAttempted=${skipCheckRunAttempted}`,
  };
}
