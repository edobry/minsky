import { describe, expect, test } from "bun:test";
import {
  CONSUMER_ACCOUNT_SKIP_ENV_VAR,
  extractConsumerAccountDeferral,
  findRemovedSignalCalls,
  hasConsumerAccount,
  runConsumerAccountCalibration,
  type PrFilePatch,
} from "./consumer-account-evidence";

/** The supervised in-scope path these fixtures use throughout. */
const DAEMON_FILE = "src/mcp/daemon.ts";

/** The canonical removed signal line. */
const EXIT_LINE = "  process.exit(0);";

/** A unified-diff patch removing one line. */
function removalPatch(line: string): string {
  return ["@@ -10,3 +10,2 @@", " const before = 1;", `-${line}`, " const after = 2;"].join("\n");
}

const NO_ACCOUNT_BODY = "## Summary\n\nRefactored the daemon shutdown path.\n";

const ACCOUNT_BODY =
  "## Summary\n\nThe daemon releases its listener instead of exiting.\n\n" +
  "Consumer account: the tray's `registry.rs` supervises on a 5 s `/health` poll, so a\n" +
  "non-serving port is already an observable trigger and replaces the exit.\n";

function run(patches: PrFilePatch[], body: string) {
  return runConsumerAccountCalibration(
    "mt#4493",
    3331,
    patches,
    "fix(mt#4493): x",
    body,
    {},
    () => new Date("2026-08-25T00:00:00Z")
  );
}

// ---------------------------------------------------------------------------
// Trigger — the closed token set, read off REMOVAL lines only
// ---------------------------------------------------------------------------

describe("findRemovedSignalCalls", () => {
  test("finds a removed process.exit in an in-scope file", () => {
    const found = findRemovedSignalCalls([
      { filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("process-exit");
    expect(found[0]?.filename).toBe(DAEMON_FILE);
  });

  test("does NOT read the `---` unified-diff file header as a removed line", () => {
    const found = findRemovedSignalCalls([
      {
        filename: DAEMON_FILE,
        patch: "--- a/src/mcp/daemon.ts\n+++ b/src/mcp/daemon.ts\n@@ -1 +1 @@\n context.close();",
      },
    ]);
    expect(found).toHaveLength(0);
  });

  test("ignores ADDED lines — only removals count", () => {
    const found = findRemovedSignalCalls([
      { filename: DAEMON_FILE, patch: "@@ -1 +1,2 @@\n+  process.exit(0);" },
    ]);
    expect(found).toHaveLength(0);
  });

  test("deduplicates per (file, kind) so one refactor is one finding", () => {
    const patch = [
      "@@ -1,4 +1,1 @@",
      "-  process.exit(0);",
      "-  process.exit(1);",
      "-  process.exit(2);",
    ].join("\n");
    const found = findRemovedSignalCalls([{ filename: DAEMON_FILE, patch }]);
    expect(found).toHaveLength(1);
  });

  test("a missing patch (binary/oversized) is skipped, not treated as empty", () => {
    expect(findRemovedSignalCalls([{ filename: "src/a.ts", patch: null }])).toHaveLength(0);
    expect(findRemovedSignalCalls([{ filename: "src/a.ts" }])).toHaveLength(0);
  });

  for (const [kind, line] of [
    ["event-emit", "  bus.emit('disconnect', id);"],
    ["event-emit", "  recordDisconnect(sessionId);"],
    ["connection-close", "  socket.close();"],
    ["state-write", "  writeFileSync('local-mcp.json', data);"],
  ] as const) {
    test(`classifies ${kind}: ${line.trim()}`, () => {
      const found = findRemovedSignalCalls([{ filename: DAEMON_FILE, patch: removalPatch(line) }]);
      expect(found[0]?.kind).toBe(kind);
    });
  }

  test("test files are out of scope", () => {
    const found = findRemovedSignalCalls([
      { filename: "src/mcp/daemon.test.ts", patch: removalPatch(EXIT_LINE) },
    ]);
    expect(found).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Accounting — the literal marker, fence-aware
// ---------------------------------------------------------------------------

describe("hasConsumerAccount", () => {
  for (const form of [
    "Consumer account: the tray polls /health.",
    "**Consumer account:** the tray polls /health.",
    "**Consumer account**: the tray polls /health.",
    "- Consumer account: the tray polls /health.",
    "## Consumer account",
    "### Consumer account:",
    "consumer account: lowercase is fine",
  ]) {
    test(`accepts: ${form}`, () => {
      expect(hasConsumerAccount(`## Summary\n\ntext\n\n${form}\n`)).toBe(true);
    });
  }

  test("a marker inside a fenced block does NOT count", () => {
    const body = "## Summary\n\n```\nConsumer account: this is quoted documentation\n```\n";
    expect(hasConsumerAccount(body)).toBe(false);
  });

  test("prose merely mentioning a consumer does not satisfy the marker", () => {
    expect(hasConsumerAccount("The tray consumes the exit signal via registry.rs.")).toBe(false);
  });

  test("extracts a tracked deferral marker", () => {
    expect(extractConsumerAccountDeferral("body [consumer-account-deferred: mt#1234] end")).toBe(
      "mt#1234"
    );
    expect(extractConsumerAccountDeferral("body with prose about deferring")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The spec's acceptance tests, by its own numbering
// ---------------------------------------------------------------------------

describe("mt#4493 acceptance tests", () => {
  test("AT1: removed process.exit on a supervised daemon path, body names no consumer → fires", () => {
    const result = run(
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      NO_ACCOUNT_BODY
    );
    expect(result.ranCheck).toBe(true);
    expect(result.calibrationRecord).not.toBeNull();
    expect(result.calibrationRecord?.decision).toBe("warn");
    expect(result.calibrationRecord?.kinds).toEqual(["process-exit"]);
    expect(result.warning).toContain("Consumer account:");
  });

  test("AT2: removed process.exit(1) from a one-shot script → no fire (scripts/ is out of scope)", () => {
    const result = run(
      [{ filename: "scripts/backfill.ts", patch: removalPatch("  process.exit(1);") }],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord).toBeNull();
    expect(result.warning).toBeNull();
  });

  test("AT3: removes a signal AND names its consumer + replacement → no fire", () => {
    const result = run([{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }], ACCOUNT_BODY);
    expect(result.calibrationRecord).toBeNull();
    expect(result.warning).toBeNull();
  });

  /**
   * AT4 is the CODE form of mt#3025's shape, deliberately — the originating instance was
   * a design in prose with no diff, which a diff-anchored surface cannot reach. The spec
   * says so in `## Scope → Out of scope` and AT4 records it rather than papering over it.
   */
  test("AT4: the mt#3025 shape, code form — the daemon staleness exit, unaccounted → fires", () => {
    const result = run(
      [
        {
          filename: "src/mcp/staleness.ts",
          patch: removalPatch("      process.exit(0); // staleness: let the tray respawn us"),
        },
      ],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord).not.toBeNull();
  });

  test("AT4: the same removal, accounted for by registry.rs's /health poll → does not fire", () => {
    const result = run(
      [
        {
          filename: "src/mcp/staleness.ts",
          patch: removalPatch("      process.exit(0); // staleness: let the tray respawn us"),
        },
      ],
      ACCOUNT_BODY
    );
    expect(result.calibrationRecord).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Posture and instrumentation
// ---------------------------------------------------------------------------

describe("posture", () => {
  test("never denies — the only decision this surface emits is warn", () => {
    const result = run(
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord?.decision).toBe("warn");
  });

  test("the documented override suppresses the check entirely", () => {
    const result = runConsumerAccountCalibration(
      "mt#4493",
      3331,
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      "fix(mt#4493): x",
      NO_ACCOUNT_BODY,
      { [CONSUMER_ACCOUNT_SKIP_ENV_VAR]: "1" }
    );
    expect(result.ranCheck).toBe(false);
    expect(result.calibrationRecord).toBeNull();
  });

  test("a tracked deferral marker suppresses the fire and prose does not", () => {
    const deferred = run(
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      `${NO_ACCOUNT_BODY}\n[consumer-account-deferred: mt#9999]\n`
    );
    expect(deferred.calibrationRecord).toBeNull();

    const prose = run(
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      `${NO_ACCOUNT_BODY}\nDeferring the consumer question to a follow-up task.\n`
    );
    expect(prose.calibrationRecord).not.toBeNull();
  });

  /**
   * `patchesIncomplete` is what lets a review pass tell a clean window from a partly-read
   * one. Without it, an unreadable in-scope patch is indistinguishable from no removal.
   */
  test("records patchesIncomplete when an in-scope file has no patch", () => {
    const result = run(
      [
        { filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) },
        { filename: "src/assets/big.bin", patch: null },
      ],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord?.patchesIncomplete).toBe(true);
  });

  test("an unreadable patch OUTSIDE the scanned roots does not flag the window", () => {
    const result = run(
      [
        { filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) },
        { filename: "docs/diagram.png", patch: null },
      ],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord?.patchesIncomplete).toBe(false);
  });

  test("captures the judged PR body so the verdict stays re-derivable after an edit", () => {
    const result = run(
      [{ filename: DAEMON_FILE, patch: removalPatch(EXIT_LINE) }],
      NO_ACCOUNT_BODY
    );
    expect(result.calibrationRecord?.judgedPrBody).toBeDefined();
    expect(result.calibrationRecord?.captureSchema).toBeGreaterThan(0);
  });
});
