/* eslint-disable custom/no-real-fs-in-tests -- the CLI commands operate on the real file store; testing via real fs exercises the integration end-to-end */
/**
 * Tests for the `unasked-direction.*` CLI commands.
 *
 * Acceptance:
 *   - list returns rows for written sessions; pending-only by default; --all includes reviewed
 *   - mark-real flips verdict and seeds the signature file
 *   - mark-false-positive flips verdict and does NOT seed
 *   - Out-of-bounds finding indices return applied=false with reason
 *
 * Reference: mt#1543 §Acceptance Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerUnaskedDirectionCommands,
  projectFindingRows,
  type ListRow,
} from "./unasked-direction";
import {
  SharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../command-registry";
import {
  writeFindings,
  readSignatureSeeds,
  readFindings,
} from "@minsky/domain/detectors/unasked-direction-store";
import type { AnalyzerOutput } from "@minsky/domain/detectors/unasked-direction-analyzer";

const CMD_LIST = "unasked-direction.list";
const CMD_MARK_REAL = "unasked-direction.mark-real";
const CMD_MARK_FP = "unasked-direction.mark-false-positive";
const FIXTURE_SIGNATURE_A = "ts:dependency:redis";

const FIXTURE_FINDING_A = {
  label: "chose Redis",
  rationale: "no policy citation",
  severity: "medium" as const,
  evidenceMessages: [12],
  suggestedSignature: FIXTURE_SIGNATURE_A,
};

const FIXTURE_FINDING_B = {
  label: "default timeout = 14 days",
  rationale: "no threshold rule cited",
  severity: "high" as const,
  evidenceMessages: [4],
  suggestedSignature: "config:default:timeout",
};

function makeOutput(): AnalyzerOutput {
  return {
    findings: [FIXTURE_FINDING_A, FIXTURE_FINDING_B],
    summary: "Two findings",
  };
}

let tempRoot: string;
let registry: SharedCommandRegistry;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "unasked-cli-test-"));
  registry = new SharedCommandRegistry();
  registerUnaskedDirectionCommands(() => tempRoot, registry);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const ctx: CommandExecutionContext = { interface: "test" };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerUnaskedDirectionCommands", () => {
  it("registers three commands under DETECTORS category", () => {
    const cmds = registry.getCommandsByCategory(CommandCategory.DETECTORS);
    const ids = cmds.map((c) => c.id).sort();
    expect(ids).toEqual([CMD_LIST, CMD_MARK_FP, CMD_MARK_REAL].sort());
  });
});

// ---------------------------------------------------------------------------
// projectFindingRows (pure helper)
// ---------------------------------------------------------------------------

describe("projectFindingRows", () => {
  it("returns one row per finding with all fields populated", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), { taskId: "mt#1543" });
    const record = await readFindings(tempRoot, "S1");
    if (!record) throw new Error("test setup failed");

    const rows = projectFindingRows(record, false);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe("chose Redis");
    expect(rows[0]?.taskId).toBe("mt#1543");
  });

  it("filters to pending verdicts when pendingOnly=true", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), {});
    const record = await readFindings(tempRoot, "S1");
    if (!record) throw new Error("test setup failed");
    if (record.findings[0]) {
      record.findings[0].verdict = "real";
      record.findings[0].reviewedAt = "2026-05-06T00:00:00Z";
    }

    const rows = projectFindingRows(record, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("default timeout = 14 days");
  });
});

// ---------------------------------------------------------------------------
// list command
// ---------------------------------------------------------------------------

describe(CMD_LIST, () => {
  it("returns pending findings across all sessions by default", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), { taskId: "mt#1543" });
    await writeFindings(tempRoot, "S2", makeOutput(), {});

    const cmd = registry.getCommand(CMD_LIST);
    if (!cmd) throw new Error("command missing");
    const result = (await cmd.execute({ all: false }, ctx)) as { rows: ListRow[] };
    expect(result.rows).toHaveLength(4); // 2 sessions × 2 findings
  });

  it("filters by sessionId when provided", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), {});
    await writeFindings(tempRoot, "S2", makeOutput(), {});
    const cmd = registry.getCommand(CMD_LIST);
    if (!cmd) throw new Error("command missing");

    const result = (await cmd.execute({ sessionId: "S1" }, ctx)) as { rows: ListRow[] };
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.sessionId === "S1")).toBe(true);
  });

  it("returns empty rows when no sessions have been analyzed", async () => {
    const cmd = registry.getCommand(CMD_LIST);
    if (!cmd) throw new Error("command missing");
    const result = (await cmd.execute({}, ctx)) as { rows: ListRow[] };
    expect(result.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mark-real command
// ---------------------------------------------------------------------------

describe(CMD_MARK_REAL, () => {
  it("flips verdict to 'real' and seeds the signature file", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), { taskId: "mt#1543" });
    const cmd = registry.getCommand(CMD_MARK_REAL);
    if (!cmd) throw new Error("command missing");

    const result = (await cmd.execute(
      { sessionId: "S1", findingIndex: 0, note: "real direction" },
      ctx
    )) as { applied: boolean; signatureSeeded?: boolean };

    expect(result.applied).toBe(true);
    expect(result.signatureSeeded).toBe(true);

    const record = await readFindings(tempRoot, "S1");
    expect(record?.findings[0]?.verdict).toBe("real");
    expect(record?.findings[0]?.note).toBe("real direction");

    const seeds = await readSignatureSeeds(tempRoot, "S1");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.signature).toBe(FIXTURE_FINDING_A.suggestedSignature);
    expect(seeds[0]?.note).toBe("real direction");
  });

  it("returns applied=false with reason when sessionId is unknown", async () => {
    const cmd = registry.getCommand(CMD_MARK_REAL);
    if (!cmd) throw new Error("command missing");
    const result = (await cmd.execute({ sessionId: "missing", findingIndex: 0 }, ctx)) as {
      applied: boolean;
      reason?: string;
    };
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("no findings record");
  });

  it("returns applied=false with reason when finding index is out of bounds", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), {});
    const cmd = registry.getCommand(CMD_MARK_REAL);
    if (!cmd) throw new Error("command missing");
    const result = (await cmd.execute({ sessionId: "S1", findingIndex: 99 }, ctx)) as {
      applied: boolean;
      reason?: string;
    };
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("out of bounds");
  });
});

// ---------------------------------------------------------------------------
// mark-false-positive command
// ---------------------------------------------------------------------------

describe(CMD_MARK_FP, () => {
  it("flips verdict to 'false-positive' and does NOT seed", async () => {
    await writeFindings(tempRoot, "S1", makeOutput(), {});
    const cmd = registry.getCommand(CMD_MARK_FP);
    if (!cmd) throw new Error("command missing");

    const result = (await cmd.execute({ sessionId: "S1", findingIndex: 1 }, ctx)) as {
      applied: boolean;
    };
    expect(result.applied).toBe(true);

    const record = await readFindings(tempRoot, "S1");
    expect(record?.findings[1]?.verdict).toBe("false-positive");

    const seeds = await readSignatureSeeds(tempRoot, "S1");
    expect(seeds).toEqual([]);
  });
});
