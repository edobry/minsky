/**
 * Tests for the observability.calibration-review command adapter (mt#2866).
 *
 * Exercises the silent-stretch registry entry through the ACTUAL command
 * surface — not just the pure `calibration-sweep.ts` functions covered in
 * `src/domain/calibration/calibration-sweep.test.ts`. `formatResult` in
 * `calibration.ts` has its own record-shape-detection branches (mirrors the
 * ones in `extractDistinctPhrases`), and mt#2866's acceptance criterion #3
 * ("/calibration-review can classify silent-stretch records ... without
 * erroring") targets this command surface directly — a synthetic log that
 * parses fine in the pure sweep layer could still crash here if this file's
 * shape-detection fallthrough weren't also updated.
 *
 * Uses real filesystem operations against a unique temp directory (mirrors
 * `src/adapters/shared/commands/ask-form-lint-calibration.test.ts`) because
 * this exercises the real JSONL read path through `readFileOrNull`.
 *
 * **PR #2004 R1 red/green verification (manual, performed at review-fix
 * time):** the registry entry in `CALIBRATION_LOG_REGISTRY` was temporarily
 * removed and the suite below was re-run — all three tests failed (the
 * `.find((r) => r.name === "silent-stretch")` lookup returned `undefined`,
 * proving no coincidental/stale registration satisfies these assertions).
 * With the entry removed, EVERY log in the `text mode` assertion's rendered
 * output — including `causal-premise`, which has real accumulated data in
 * the actual repo root — reported `Exists: false`, confirming the command
 * reads from the temp `workspacePath` passed via `ctx`, not the real project
 * root or some other default. The registry entry was then restored and the
 * suite re-confirmed green. This disproved the R1 BLOCKING finding's specific
 * theory (a different path-resolution root) but the check itself is now
 * load-bearing evidence this file preserves for future reviewers instead of
 * requiring them to re-derive it.
 */
/* eslint-disable custom/no-real-fs-in-tests -- exercises the real JSONL read
   path via a unique per-test temp workspace dir (mirrors
   ask-form-lint-calibration.test.ts's justification) */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sharedCommandRegistry } from "../command-registry";
import { registerCalibrationCommands, resolveCalibrationStatePath } from "./calibration";
import {
  UNKNOWN_SILENT_STRETCH_SESSION_LABEL,
  type LogWatermark,
} from "../../../domain/calibration/calibration-sweep";

const COMMAND_ID = "observability.calibration-review";
const SILENT_STRETCH_LOG = "silent-stretch-calibration.jsonl";
const CAUSAL_PREMISE_LOG = "causal-premise-calibration.jsonl";

/**
 * mt#4748 R1: the calibration LOG content this file's fixtures write no
 * longer lives at `join(workspace, ".minsky", logFileName)` — it lives under
 * the state dir, project-keyed. Resolve through the exact same helper the
 * command itself uses (`resolveCalibrationStatePath`, exported from
 * `calibration.ts` for this reason) so a fixture write and the command's own
 * read are GUARANTEED to agree, rather than asserting it by construction in
 * two places.
 */
async function writeCalibrationLog(
  workspace: string,
  logFileName: string,
  content: string
): Promise<void> {
  const path = await resolveCalibrationStatePath(workspace, `.minsky/${logFileName}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function getCommand() {
  let command = sharedCommandRegistry.getCommand(COMMAND_ID);
  if (!command) {
    registerCalibrationCommands();
    command = sharedCommandRegistry.getCommand(COMMAND_ID);
  }
  if (!command) throw new Error(`${COMMAND_ID} not registered`);
  return command;
}

/**
 * Run the read-only sweep and return the receipt it issues (mt#3906).
 *
 * Every `ack: true` below goes through this, because that is now the only way
 * to ack: the token binds the counts the reviewer saw, so the ack cannot write
 * a count nobody looked at. In these tests the fixture does not grow between
 * the read and the ack, so the bound count equals the ack-time count and every
 * pre-existing expectation is unchanged.
 */
async function readReviewToken(workspace: string): Promise<string> {
  const result = (await getCommand().execute(
    { ack: false, json: true },
    { workspacePath: workspace }
  )) as { reviewToken: string };
  return result.reviewToken;
}

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "calibration-review-command-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".minsky"), { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // mt#4748 R1: the calibration logs this file's fixtures write now live
    // under the shared state dir, outside `dir` — clean up both known log
    // names best-effort (a name never written for this workspace is a no-op
    // `force: true` removal) before removing the workspace itself.
    for (const logName of [SILENT_STRETCH_LOG, CAUSAL_PREMISE_LOG]) {
      const path = await resolveCalibrationStatePath(dir, `.minsky/${logName}`);
      rmSync(path, { force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSilentStretchRecord(sessionId: string): string {
  return JSON.stringify({
    timestamp: "2026-07-16T00:00:00Z",
    session_id: sessionId,
    gapMinutes: 12.5,
    toolCallCount: 15,
    hadTextInTurn: false,
  });
}

/** 12 fires across 4 distinct conversations — the mt#2866 acceptance-test fixture. */
async function writeAcceptanceFixture(workspace: string): Promise<void> {
  const conversations = ["conv-a", "conv-b", "conv-c", "conv-d"];
  const lines = Array.from({ length: 12 }, (_, i) =>
    makeSilentStretchRecord(conversations[i % conversations.length] as string)
  );
  await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${lines.join("\n")}\n`);
}

describe("observability.calibration-review — silent-stretch (mt#2866)", () => {
  test("classifies a synthetic silent-stretch log without erroring (json mode)", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: false, json: true },
      { workspacePath: workspace }
    )) as {
      success: boolean;
      results: Array<{
        name: string;
        exists: boolean;
        totalFires: number;
        distinctPhrases: number;
        pastThreshold: boolean;
      }>;
    };

    expect(result.success).toBe(true);
    const silentStretchResult = result.results.find((r) => r.name === "silent-stretch");
    expect(silentStretchResult).toBeDefined();
    expect(silentStretchResult?.exists).toBe(true);
    expect(silentStretchResult?.totalFires).toBe(12);
    expect(silentStretchResult?.distinctPhrases).toBe(4);
    expect(silentStretchResult?.pastThreshold).toBe(true);

    // R1 isolation check: every OTHER registered log must report !exists,
    // since only the silent-stretch fixture was written to this temp
    // workspace. If the command were resolving a different root (the R1
    // BLOCKING finding's theory), a log with real accumulated data in the
    // actual repo (e.g. causal-premise) would report exists:true here.
    const otherResults = result.results.filter((r) => r.name !== "silent-stretch");
    expect(otherResults.length).toBeGreaterThan(0);
    for (const other of otherResults) {
      expect(other.exists).toBe(false);
    }
  });

  test("classifies a synthetic silent-stretch log without erroring (text mode)", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: false, json: false },
      { workspacePath: workspace }
    )) as { success: boolean; message: string };

    expect(result.success).toBe(true);
    expect(result.message).toContain("silent-stretch");
    expect(result.message).toContain("gap=");
  });

  test("--ack advances the silent-stretch watermark without erroring", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const command = getCommand();
    const result = (await command.execute(
      { ack: true, json: true, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as { success: boolean; watermarkAdvanced: boolean };

    expect(result.success).toBe(true);
    expect(result.watermarkAdvanced).toBe(true);
  });

  test("missing-session_id fallback label matches the sweep logic's label (mt#2866, PR #2004 R1)", async () => {
    // PR #2004 R1 non-blocking finding: this surface's fallback ("unknown")
    // had drifted from calibration-sweep.ts's extractDistinctPhrases fallback
    // ("unknown-session"). Both now import UNKNOWN_SILENT_STRETCH_SESSION_LABEL
    // from the same source — this test renders a record missing session_id
    // through the actual command and asserts the shared constant's value
    // appears, so a future re-drift fails here rather than silently diverging.
    //
    // The missing-session_id record is placed FIRST: formatResult only renders
    // the first 5 of `newRecords` in its display, so it must land within that
    // window to be observable in `result.message`.
    const workspace = makeWorkspace();
    const missingSessionIdRecord = JSON.stringify({
      timestamp: "2026-07-16T00:00:00Z",
      gapMinutes: 12.5,
      toolCallCount: 15,
      hadTextInTurn: false,
    });
    const conversations = ["conv-a", "conv-b", "conv-c"];
    const lines = [
      missingSessionIdRecord,
      ...Array.from(
        { length: 9 },
        (_, i) => makeSilentStretchRecord(conversations[i % conversations.length] as string) // 9 more -> 10 total
      ),
    ];
    await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${lines.join("\n")}\n`);

    const command = getCommand();
    const result = (await command.execute(
      { ack: false, json: false },
      { workspacePath: workspace }
    )) as { success: boolean; message: string };

    expect(result.success).toBe(true);
    expect(result.message).toContain(`conversation=${UNKNOWN_SILENT_STRETCH_SESSION_LABEL}`);
  });
});

// ---------------------------------------------------------------------------
// --ack covers every review-due leg, not only pastThreshold (mt#2878)
// ---------------------------------------------------------------------------
//
// `computeReviewDueLogs` has four legs; `--ack` used to advance only the
// `pastThreshold` one, so a log flagged by any other leg could be reviewed but
// never marked reviewed — the cadence hook re-warned on it forever. These
// fixtures deliberately stay BELOW the count bar (FIRES_THRESHOLD = 10) so the
// old `results.filter((r) => r.pastThreshold)` selection cannot pick them up:
// each test fails against the pre-fix code.

const WATERMARKS_FILE = "calibration-review-watermarks.json";
const CAUSAL_PREMISE_PATH = ".minsky/causal-premise-calibration.jsonl";
const SILENT_STRETCH_PATH = ".minsky/silent-stretch-calibration.jsonl";
const ASK_ID = "11111111-2222-3333-4444-555555555555";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Records old enough to trip the 30-day never-reviewed window, and few enough to stay under the count bar. */
async function writeAgedCausalPremiseLog(workspace: string, count: number): Promise<void> {
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      timestamp: daysAgoIso(60),
      session_id: `conv-${i}`,
      matchedPhrases: ["because"],
      hadSameTurnVerification: false,
    })
  );
  await writeCalibrationLog(workspace, CAUSAL_PREMISE_LOG, `${lines.join("\n")}\n`);
}

function writeWatermarks(workspace: string, store: Record<string, unknown>): void {
  writeFileSync(join(workspace, ".minsky", WATERMARKS_FILE), JSON.stringify(store), "utf-8");
}

function readWatermarks(workspace: string): Record<string, LogWatermark> {
  // `as string`: src/types/node.d.ts declares readFileSync as returning
  // `string | Buffer` regardless of encoding, so no overload narrows it. Every
  // other call site in src/ casts the same way.
  const raw = readFileSync(join(workspace, ".minsky", WATERMARKS_FILE), {
    encoding: "utf-8",
  }) as string;
  return JSON.parse(raw) as Record<string, LogWatermark>;
}

type AckResult = {
  success: boolean;
  watermarkAdvanced: boolean;
  skippedOpenAskPaths: string[];
  driftedPaths: string[];
  clearedAskId: boolean;
  reviewDue: Array<{ name: string; reason: string }>;
  results: Array<{ name: string; pastThreshold: boolean; openAskId?: string }>;
};

describe("observability.calibration-review — --ack covers all review-due legs (mt#2878)", () => {
  test("advances a never-reviewed log that has no watermark, and binds its askId", async () => {
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);

    const command = getCommand();

    // Precondition: due via the never-reviewed leg, and NOT past the count bar
    // — so the pre-fix pastThreshold-only filter would have selected nothing.
    const before = (await command.execute(
      { ack: false, json: true },
      { workspacePath: workspace }
    )) as AckResult;
    const dueBefore = before.reviewDue.find((d) => d.name === "causal-premise");
    expect(dueBefore?.reason).toBe("never-reviewed");
    expect(before.results.find((r) => r.name === "causal-premise")?.pastThreshold).toBe(false);

    const acked = (await command.execute(
      { ack: true, json: true, askId: ASK_ID, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as AckResult;

    expect(acked.success).toBe(true);
    expect(acked.watermarkAdvanced).toBe(true);

    // A never-reviewed log has no watermark entry to carry the ask id, so this
    // asserts the entry is CREATED, not merely updated.
    const watermarks = readWatermarks(workspace);
    expect(watermarks[CAUSAL_PREMISE_PATH]?.lastReviewedCount).toBe(3);
    expect(watermarks[CAUSAL_PREMISE_PATH]?.openAskId).toBe(ASK_ID);

    // And the loop actually closes: the log is no longer review-due.
    const after = (await command.execute(
      { ack: false, json: true },
      { workspacePath: workspace }
    )) as AckResult;
    expect(after.reviewDue.find((d) => d.name === "causal-premise")).toBeUndefined();
  });

  test("advances a time-stale log that is below the count bar", async () => {
    const workspace = makeWorkspace();
    // 3 fires total, 1 already reviewed -> 2 new, well under FIRES_THRESHOLD.
    const lines = Array.from({ length: 3 }, (_, i) => makeSilentStretchRecord(`conv-${i}`));
    await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${lines.join("\n")}\n`);
    writeWatermarks(workspace, {
      [SILENT_STRETCH_PATH]: { lastReviewedCount: 1, lastReviewedAt: daysAgoIso(20) },
    });

    const command = getCommand();
    const before = (await command.execute(
      { ack: false, json: true },
      { workspacePath: workspace }
    )) as AckResult;
    expect(before.reviewDue.find((d) => d.name === "silent-stretch")?.reason).toBe("time-stale");
    expect(before.results.find((r) => r.name === "silent-stretch")?.pastThreshold).toBe(false);

    const acked = (await command.execute(
      { ack: true, json: true, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as AckResult;

    expect(acked.watermarkAdvanced).toBe(true);
    expect(readWatermarks(workspace)[SILENT_STRETCH_PATH]?.lastReviewedCount).toBe(3);
  });

  test("still skips a newly-covered-leg log whose ask is open when no askId is supplied", async () => {
    // The mt#2659 safety property must survive the widening: --ack without
    // askId must not silently discharge a log the operator is still deciding.
    //
    // mt#3818: this test used to also assert `acked.watermarkAdvanced === false`.
    // That flag is a PROCESS-GLOBAL boolean — `calibration.ts` sets it true the
    // moment `selectAckablePaths` returns ANY ackable path, not specifically
    // this one. It is not a safe proxy for "this log's watermark held": once
    // wall-clock passes any OTHER registry entry's `liveSinceDate +
    // reviewByDays` window (e.g. `knowledge-acquisition`'s 2026-07-23 + 14
    // days = 2026-08-06), that unrelated entry's never-fired leg (mt#3078)
    // becomes review-due and ackable in this test's temp workspace too — which
    // flips the global flag to `true` while the invariant this test actually
    // cares about (SILENT_STRETCH_PATH's watermark is untouched) still holds.
    // The per-path assertions below are the actual safety property; the
    // deleted global-flag assertion carried a latent wall-clock dependency on
    // registry entries this test never touches. See the mt#3818 spec's
    // Diagnosis section for the full mechanism and the negative-control run
    // that confirmed it (neutralizing the tripping entry's `liveSinceDate`
    // made the old assertion pass).
    const workspace = makeWorkspace();
    const lines = Array.from({ length: 3 }, (_, i) => makeSilentStretchRecord(`conv-${i}`));
    await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${lines.join("\n")}\n`);
    const originalWatermark = {
      lastReviewedCount: 1,
      lastReviewedAt: daysAgoIso(20),
      openAskId: ASK_ID,
    };
    writeWatermarks(workspace, {
      [SILENT_STRETCH_PATH]: originalWatermark,
    });

    const command = getCommand();
    const acked = (await command.execute(
      { ack: true, json: true, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as AckResult;

    expect(acked.skippedOpenAskPaths).toContain(SILENT_STRETCH_PATH);
    // The per-path property the mt#2659 safety invariant actually encodes: a
    // skipped log's watermark entry is byte-for-byte unchanged — not merely
    // its count, but its timestamp and openAskId too.
    expect(readWatermarks(workspace)[SILENT_STRETCH_PATH]).toEqual(originalWatermark);
  });

  test("supplying askId reaffirms an open-ask log on a newly-covered leg", async () => {
    const workspace = makeWorkspace();
    const lines = Array.from({ length: 3 }, (_, i) => makeSilentStretchRecord(`conv-${i}`));
    await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${lines.join("\n")}\n`);
    writeWatermarks(workspace, {
      [SILENT_STRETCH_PATH]: {
        lastReviewedCount: 1,
        lastReviewedAt: daysAgoIso(20),
        openAskId: "00000000-0000-0000-0000-000000000000",
      },
    });

    const command = getCommand();
    const acked = (await command.execute(
      { ack: true, json: true, askId: ASK_ID, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as AckResult;

    expect(acked.skippedOpenAskPaths).toHaveLength(0);
    expect(acked.watermarkAdvanced).toBe(true);
    expect(readWatermarks(workspace)[SILENT_STRETCH_PATH]?.openAskId).toBe(ASK_ID);
  });
});

describe("observability.calibration-review — concurrent-write reconciliation (mt#3899)", () => {
  // The drift DECISION is a pure function, pinned exhaustively in
  // `src/domain/calibration/calibration-sweep.test.ts` (`mergeWatermarkWrite`).
  // These assert the command level: two real passes racing over one store, and
  // the uncontended contract.

  test("two overlapping passes each keep the other's write (spec AT1)", async () => {
    // The incident, at the level it happened. Two passes overlap; each read the
    // store before either wrote it. Pre-fix, both wrote their own stale
    // whole-store snapshot, so whichever finished last erased the other's
    // effect — silently, with both passes reporting success.
    //
    // The two passes must intend DIFFERENT writes for this to be able to fail:
    // when both compute the same values, a stale write is indistinguishable
    // from a fresh one and the test proves nothing (measured — an earlier
    // version of this test used two identical acks and passed against the
    // pre-fix code). So:
    //   pass A = --ack, which skips the open-ask log and advances the other;
    //   pass B = --clearAskId, which touches ONLY the open-ask log.
    // Disjoint targets, one store, one write each.
    //
    // Concurrency is real: no module is patched and no timing is asserted. Both
    // calls start together and each spends its sweep between its read and its
    // write. The assertion holds under either completion order.
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);
    const silentStretch = Array.from({ length: 3 }, (_, i) => makeSilentStretchRecord(`conv-${i}`));
    await writeCalibrationLog(workspace, SILENT_STRETCH_LOG, `${silentStretch.join("\n")}\n`);
    writeWatermarks(workspace, {
      // Carries the open ask -> pass A skips it, pass B clears it.
      [CAUSAL_PREMISE_PATH]: {
        lastReviewedCount: 0,
        lastReviewedAt: daysAgoIso(40),
        openAskId: ASK_ID,
      },
      // No ask -> pass A advances it, pass B never touches it.
      [SILENT_STRETCH_PATH]: { lastReviewedCount: 1, lastReviewedAt: daysAgoIso(20) },
    });

    const command = getCommand();
    // Pass A's receipt is taken BEFORE the pair starts, which is faithful to
    // the incident: both passes read the world, then both write into it.
    const passAToken = await readReviewToken(workspace);
    await Promise.all([
      command.execute(
        { ack: true, json: true, reviewToken: passAToken },
        { workspacePath: workspace }
      ),
      command.execute({ ack: false, json: true, clearAskId: ASK_ID }, { workspacePath: workspace }),
    ]);

    // BOTH effects must survive. Pre-fix, exactly one does.
    const after = readWatermarks(workspace);
    expect(after[SILENT_STRETCH_PATH]?.lastReviewedCount).toBe(3);
    expect(after[CAUSAL_PREMISE_PATH]?.openAskId).toBeUndefined();
  });

  test("an uncontended ack reports no dropped writes and still advances", async () => {
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);

    const acked = (await getCommand().execute(
      { ack: true, json: true, reviewToken: await readReviewToken(workspace) },
      { workspacePath: workspace }
    )) as AckResult;

    expect(acked.watermarkAdvanced).toBe(true);
    expect(acked.driftedPaths).toEqual([]);
    expect(readWatermarks(workspace)[CAUSAL_PREMISE_PATH]?.lastReviewedCount).toBe(3);
  });

  test("ack without a reviewToken is REFUSED and writes nothing (mt#3906)", async () => {
    // The refusal is the point: with no receipt the command cannot know what
    // was classified, and the only count available to it is the one that
    // caused the defect. Failing closed costs one read-only call.
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);

    const refused = (await getCommand().execute(
      { ack: true, json: true },
      { workspacePath: workspace }
    )) as { success: boolean; error: string };

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("reviewToken");
    // No watermark file was created — the refusal happens before any write.
    expect(existsSync(join(workspace, ".minsky", WATERMARKS_FILE))).toBe(false);
  });

  test("ack with a token claiming more records than the log holds is REFUSED (mt#3906)", async () => {
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);
    // A receipt taken while the log held 3 records, replayed against a log
    // that now holds 1 — the shape a rotated log or a foreign tree produces.
    const token = await readReviewToken(workspace);
    await writeAgedCausalPremiseLog(workspace, 1);

    const refused = (await getCommand().execute(
      { ack: true, json: true, reviewToken: token },
      { workspacePath: workspace }
    )) as { success: boolean; error: string };

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("the log holds");
    expect(existsSync(join(workspace, ".minsky", WATERMARKS_FILE))).toBe(false);
  });

  test("an uncontended clear reports no dropped writes and leaves the counts alone", async () => {
    // Doubles as the mt#3899 regression pin from the task's Acceptance Test 4:
    // clearing an ask must not move lastReviewedCount/At. That behavior was
    // CORRECT before this change — the first diagnosis of the incident wrongly
    // blamed it — and the reconciliation must not disturb it.
    const workspace = makeWorkspace();
    await writeAgedCausalPremiseLog(workspace, 3);
    const original = { lastReviewedCount: 1, lastReviewedAt: daysAgoIso(20), openAskId: ASK_ID };
    writeWatermarks(workspace, { [CAUSAL_PREMISE_PATH]: original });

    const cleared = (await getCommand().execute(
      { ack: false, json: true, clearAskId: ASK_ID },
      { workspacePath: workspace }
    )) as AckResult;

    expect(cleared.clearedAskId).toBe(true);
    expect(cleared.driftedPaths).toEqual([]);
    const after = readWatermarks(workspace)[CAUSAL_PREMISE_PATH];
    expect(after?.lastReviewedCount).toBe(original.lastReviewedCount);
    expect(after?.lastReviewedAt).toBe(original.lastReviewedAt);
    expect(after?.openAskId).toBeUndefined();
  });
});

describe("observability.calibration-review — server-injected caller identity (mt#4408)", () => {
  const CLAIMS_FILE = ".minsky/calibration-review-claims.json";
  const INJECTED = "com.anthropic.claude-code:conv:injected-aaaa";
  const OTHER_PASS = "com.anthropic.claude-code:conv:other-bbbb";

  /**
   * Run `fn` with both harness identity env vars unset, then restore.
   *
   * Load-bearing rather than hygiene: this suite runs inside a Claude Code
   * harness, where `CLAUDE_CODE_SESSION_ID` IS set — so a test asserting
   * "no identity ⇒ claimsUnavailable" would pass via the env fallback whether
   * or not the injection worked. That is exactly the can't-fail probe shape
   * (mem#704) this task exists to end.
   */
  async function withoutHarnessIdentity<T>(fn: () => Promise<T>): Promise<T> {
    const saved = {
      agent: process.env.CLAUDE_AGENT_ID,
      session: process.env.CLAUDE_CODE_SESSION_ID,
    };
    delete process.env.CLAUDE_AGENT_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      return await fn();
    } finally {
      if (saved.agent !== undefined) process.env.CLAUDE_AGENT_ID = saved.agent;
      if (saved.session !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved.session;
    }
  }

  function readClaims(workspace: string): Record<string, { actorId: string }> {
    const path = join(workspace, CLAIMS_FILE);
    if (!existsSync(path)) return {};
    // `as string` for the same reason `readWatermarks` above casts: this repo's
    // src/types/node.d.ts declares readFileSync as `string | Buffer` regardless
    // of encoding, so no overload narrows it.
    const raw = readFileSync(path, { encoding: "utf-8" }) as string;
    return JSON.parse(raw) as Record<string, { actorId: string }>;
  }

  test("callerActorId resolves identity, so the pass claims its review-due logs", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const result = await withoutHarnessIdentity(
      async () =>
        (await getCommand().execute(
          { ack: false, json: true, callerActorId: INJECTED },
          { workspacePath: workspace }
        )) as { claimsUnavailable: boolean; reviewDue: { name: string }[] }
    );

    expect(result.claimsUnavailable).toBe(false);
    expect(result.reviewDue.length).toBeGreaterThan(0);

    // The claim is held by the INJECTED id specifically — not merely by "some"
    // id, which an env fallback would also satisfy.
    const claims = readClaims(workspace);
    const holders = Object.values(claims).map((c) => c.actorId);
    expect(holders.length).toBeGreaterThan(0);
    expect(new Set(holders)).toEqual(new Set([INJECTED]));
  });

  test("NEGATIVE CONTROL — without callerActorId the pass is unidentifiable and claims nothing", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const result = await withoutHarnessIdentity(
      async () =>
        (await getCommand().execute({ ack: false, json: true }, { workspacePath: workspace })) as {
          claimsUnavailable: boolean;
        }
    );

    expect(result.claimsUnavailable).toBe(true);
    expect(Object.keys(readClaims(workspace))).toEqual([]);
  });

  test("a second pass is warned about the first pass's claim", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    await withoutHarnessIdentity(async () => {
      await getCommand().execute(
        { ack: false, json: true, callerActorId: INJECTED },
        { workspacePath: workspace }
      );
      const second = (await getCommand().execute(
        { ack: false, json: true, callerActorId: OTHER_PASS },
        { workspacePath: workspace }
      )) as { claimedByOthers: string[]; reviewDue: { name: string }[] };

      // The R4 case, closed: the second pass SEES the first and stands down.
      expect(second.claimedByOthers.length).toBeGreaterThan(0);
      expect(second.reviewDue).toEqual([]);
    });
  });

  test("an unidentifiable second pass still SEES the first pass's claim (SC2)", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    await withoutHarnessIdentity(async () => {
      await getCommand().execute(
        { ack: false, json: true, callerActorId: INJECTED },
        { workspacePath: workspace }
      );
      // No callerActorId: cannot name itself, so it writes no claim — but the
      // read must still happen. Before mt#4408 the early return skipped it and
      // this came back empty, which read as "nobody is here".
      const second = (await getCommand().execute(
        { ack: false, json: true },
        { workspacePath: workspace }
      )) as { claimsUnavailable: boolean; claimedByOthers: string[] };

      expect(second.claimsUnavailable).toBe(true);
      expect(second.claimedByOthers.length).toBeGreaterThan(0);
    });
  });
});

describe("observability.calibration-review — a fully-lost ack names the loss (mt#4408)", () => {
  test("a path this token presented as due, advanced by another pass, is reported", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    // Pass A mints a token over the review-due set.
    const tokenA = await readReviewToken(workspace);

    // Pass B classifies and acks the same window first — the winner.
    const tokenB = await readReviewToken(workspace);
    const ackB = (await getCommand().execute(
      { ack: true, json: true, reviewToken: tokenB },
      { workspacePath: workspace }
    )) as { watermarkAdvanced: boolean };
    expect(ackB.watermarkAdvanced).toBe(true);

    // Pass A now acks with its own valid token. Nothing is left to advance.
    const ackA = (await getCommand().execute(
      { ack: true, json: true, reviewToken: tokenA },
      { workspacePath: workspace }
    )) as {
      watermarkAdvanced: boolean;
      driftedPaths: string[];
      ackedByAnotherPass: string[];
    };

    // The pre-mt#4408 signature: advanced nothing, drifted nothing.
    expect(ackA.watermarkAdvanced).toBe(false);
    expect(ackA.driftedPaths).toEqual([]);
    // ...and now the loss is NAMED rather than silent.
    expect(ackA.ackedByAnotherPass.length).toBeGreaterThan(0);
    expect(ackA.ackedByAnotherPass.some((p) => p.includes("silent-stretch"))).toBe(true);
  });

  test("an uncontended ack reports no lost paths", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);
    const token = await readReviewToken(workspace);
    const acked = (await getCommand().execute(
      { ack: true, json: true, reviewToken: token },
      { workspacePath: workspace }
    )) as { watermarkAdvanced: boolean; ackedByAnotherPass: string[] };

    expect(acked.watermarkAdvanced).toBe(true);
    expect(acked.ackedByAnotherPass).toEqual([]);
  });
});

describe("observability.calibration-review — lost-ack reporting edges (mt#4408 AT3/AT4)", () => {
  test("AT3 — an uncontended ack reports the new field empty and still advances", async () => {
    // The discrimination this field has to preserve: "nobody took anything from
    // me" must not look like "someone else got there first". An empty workspace
    // is NOT the fixture for that — `never-fired` is a review-due reason, so the
    // registry's zero-record logs are due here regardless (measured: an empty
    // workspace returns knowledge-acquisition with reason `never-fired`). What
    // makes this uncontended is that no second pass acks in between.
    const workspace = makeWorkspace();
    const token = await readReviewToken(workspace);
    const acked = (await getCommand().execute(
      { ack: true, json: true, reviewToken: token },
      { workspacePath: workspace }
    )) as { ackedByAnotherPass: string[]; watermarkAdvanced: boolean };

    expect(acked.watermarkAdvanced).toBe(true);
    expect(acked.ackedByAnotherPass).toEqual([]);
  });

  test("AT4 — the text output states the loss in words, not only in JSON", async () => {
    const workspace = makeWorkspace();
    await writeAcceptanceFixture(workspace);

    const tokenA = await readReviewToken(workspace);
    const tokenB = await readReviewToken(workspace);
    await getCommand().execute(
      { ack: true, json: true, reviewToken: tokenB },
      { workspacePath: workspace }
    );

    // json: false — this asserts the RENDERED text, which is the surface a
    // reviewer actually reads. The JSON field being right is a separate claim.
    const acked = (await getCommand().execute(
      { ack: true, reviewToken: tokenA },
      { workspacePath: workspace }
    )) as { text?: string; message?: string };

    const rendered = `${acked.text ?? ""}${acked.message ?? ""}`;
    expect(rendered).toContain("LOST:");
    expect(rendered).toContain("silent-stretch");
    expect(rendered).toContain("do NOT re-ack");
  });
});

// mt#4748 R1: the write(via logCalibrationRecord)/read(via this command)
// parity test lives in `.minsky/hooks/calibration-write-read-parity.test.ts`,
// not here — importing `.minsky/hooks/dispatcher.ts` from this file pulls
// its whole transitive closure into the ROOT tsconfig's compilation unit,
// which does not share `tsconfig.hooks.json`'s `"types": ["bun", "node"]`
// override and turned up 27 pre-existing `string | Buffer` errors across
// unrelated hook files the moment the import was added (measured). The
// hooks tree already imports `src/domain/**` cleanly in the other direction
// (`calibration-review-cadence-detector.ts` does exactly this), so the test
// lives there instead, importing this command in the safe direction.
