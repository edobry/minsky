/* eslint-disable custom/no-real-fs-in-tests -- the store IS the file IO layer; testing it without real fs would shim away the only behavior under test */
/**
 * Tests for the findings + signature-seed file store.
 *
 * Acceptance:
 *   - writeFindings creates parent dir and writes a JSON file
 *   - readFindings round-trips a record
 *   - listFindingsSessions walks the dir
 *   - updateFindingVerdict mutates pending → real / false-positive
 *   - appendSignatureSeed appends to per-session seed file
 *   - All read paths return safe defaults on missing/corrupt files
 *
 * Reference: mt#1543 §Acceptance Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFindings,
  readFindings,
  listFindingsSessions,
  updateFindingVerdict,
  appendSignatureSeed,
  readSignatureSeeds,
  findingsPathFor,
  signaturesPathFor,
  __TEST_ONLY,
  type FindingsRecord,
} from "./unasked-direction-store";
import type { AnalyzerOutput } from "./unasked-direction-analyzer";

const FIXTURE_SIGNATURE = "ts:dependency:redis";

const FIXTURE_FINDING = {
  label: "chose Redis over Postgres",
  rationale: "Spec did not name a queue backend.",
  severity: "medium" as const,
  evidenceMessages: [12],
  suggestedSignature: FIXTURE_SIGNATURE,
};

function makeOutput(): AnalyzerOutput {
  return {
    findings: [FIXTURE_FINDING, { ...FIXTURE_FINDING, label: "second", severity: "low" }],
    summary: "Two findings",
  };
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "unasked-store-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("findingsPathFor lands under .minsky/state/unasked-directions/", () => {
    expect(findingsPathFor("/repo", "abc")).toBe("/repo/.minsky/state/unasked-directions/abc.json");
  });

  it("signaturesPathFor lands under .minsky/state/unasked-direction-signatures/", () => {
    expect(signaturesPathFor("/repo", "abc")).toBe(
      "/repo/.minsky/state/unasked-direction-signatures/abc.json"
    );
  });

  it("sanitizeSessionId strips path-traversal and unsafe chars", () => {
    expect(__TEST_ONLY.sanitizeSessionId("../escape")).toBe("___escape");
    expect(__TEST_ONLY.sanitizeSessionId("a/b/c")).toBe("a_b_c");
    expect(__TEST_ONLY.sanitizeSessionId("mt#1543")).toBe("mt#1543"); // # is allowed
    expect(__TEST_ONLY.sanitizeSessionId("abc-123_xyz")).toBe("abc-123_xyz");
  });
});

// ---------------------------------------------------------------------------
// writeFindings + readFindings round-trip
// ---------------------------------------------------------------------------

describe("writeFindings / readFindings", () => {
  it("writes a record and reads it back unchanged", async () => {
    const ok = await writeFindings(tempRoot, "session-A", makeOutput(), {
      taskId: "mt#1543",
    });
    expect(ok).toBe(true);

    const record = await readFindings(tempRoot, "session-A");
    expect(record).not.toBeNull();
    expect(record?.sessionId).toBe("session-A");
    expect(record?.taskId).toBe("mt#1543");
    expect(record?.findings).toHaveLength(2);
    expect(record?.findings[0]?.verdict).toBe("pending");
  });

  it("creates the parent directory if missing", async () => {
    const sessionId = "deep-session";
    const ok = await writeFindings(tempRoot, sessionId, makeOutput(), {});
    expect(ok).toBe(true);
    const path = findingsPathFor(tempRoot, sessionId);
    const raw = await readFile(path, "utf-8");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("returns null when reading a non-existent session", async () => {
    const r = await readFindings(tempRoot, "nope");
    expect(r).toBeNull();
  });

  it("returns null when the file is corrupt JSON", async () => {
    const path = findingsPathFor(tempRoot, "broken");
    await mkdir(join(tempRoot, ".minsky", "state", "unasked-directions"), {
      recursive: true,
    });
    await writeFile(path, "{ not json", "utf-8");
    const r = await readFindings(tempRoot, "broken");
    expect(r).toBeNull();
  });

  it("overwrites a previous record on re-write", async () => {
    await writeFindings(tempRoot, "session-A", makeOutput(), {});
    await writeFindings(tempRoot, "session-A", { findings: [], summary: "now empty" }, {});
    const record = await readFindings(tempRoot, "session-A");
    expect(record?.findings).toHaveLength(0);
    expect(record?.summary).toBe("now empty");
  });
});

// ---------------------------------------------------------------------------
// listFindingsSessions
// ---------------------------------------------------------------------------

describe("listFindingsSessions", () => {
  it("returns [] when the directory is missing", async () => {
    const r = await listFindingsSessions(tempRoot);
    expect(r).toEqual([]);
  });

  it("lists all sessions with .json files", async () => {
    await writeFindings(tempRoot, "alpha", makeOutput(), {});
    await writeFindings(tempRoot, "beta", makeOutput(), {});
    const r = await listFindingsSessions(tempRoot);
    expect(r.sort()).toEqual(["alpha", "beta"]);
  });

  it("ignores non-.json entries", async () => {
    await writeFindings(tempRoot, "alpha", makeOutput(), {});
    const dir = join(tempRoot, ".minsky", "state", "unasked-directions");
    await writeFile(join(dir, "README.md"), "not a session", "utf-8");
    const r = await listFindingsSessions(tempRoot);
    expect(r).toEqual(["alpha"]);
  });
});

// ---------------------------------------------------------------------------
// updateFindingVerdict
// ---------------------------------------------------------------------------

describe("updateFindingVerdict", () => {
  it("flips a finding from pending → real and stamps reviewedAt", async () => {
    await writeFindings(tempRoot, "session-A", makeOutput(), {});
    const ok = await updateFindingVerdict(tempRoot, "session-A", 0, "real", "looks like it");
    expect(ok).toBe(true);

    const record = await readFindings(tempRoot, "session-A");
    expect(record?.findings[0]?.verdict).toBe("real");
    expect(record?.findings[0]?.note).toBe("looks like it");
    expect(record?.findings[0]?.reviewedAt).toBeDefined();
    // Other findings stay pending
    expect(record?.findings[1]?.verdict).toBe("pending");
  });

  it("returns false when session record is missing", async () => {
    const ok = await updateFindingVerdict(tempRoot, "nope", 0, "real");
    expect(ok).toBe(false);
  });

  it("returns false when the finding index is out of bounds", async () => {
    await writeFindings(tempRoot, "session-A", makeOutput(), {});
    const ok = await updateFindingVerdict(tempRoot, "session-A", 99, "real");
    expect(ok).toBe(false);
  });

  it("can apply a false-positive verdict", async () => {
    await writeFindings(tempRoot, "session-A", makeOutput(), {});
    await updateFindingVerdict(tempRoot, "session-A", 0, "false-positive");
    const record = await readFindings(tempRoot, "session-A");
    expect(record?.findings[0]?.verdict).toBe("false-positive");
  });
});

// ---------------------------------------------------------------------------
// appendSignatureSeed + readSignatureSeeds
// ---------------------------------------------------------------------------

describe("appendSignatureSeed / readSignatureSeeds", () => {
  it("creates a fresh seed file on first append", async () => {
    const ok = await appendSignatureSeed(tempRoot, "session-A", {
      signature: "ts:dependency:redis",
      sourceSessionId: "session-A",
      sourceFindingIndex: 0,
      promotedAt: "2026-05-06T00:00:00Z",
    });
    expect(ok).toBe(true);
    const seeds = await readSignatureSeeds(tempRoot, "session-A");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.signature).toBe(FIXTURE_SIGNATURE);
  });

  it("appends to an existing seed file", async () => {
    const seed1 = {
      signature: "a",
      sourceSessionId: "S",
      sourceFindingIndex: 0,
      promotedAt: "2026-05-06T00:00:00Z",
    };
    const seed2 = {
      signature: "b",
      sourceSessionId: "S",
      sourceFindingIndex: 1,
      promotedAt: "2026-05-06T00:01:00Z",
    };
    await appendSignatureSeed(tempRoot, "S", seed1);
    await appendSignatureSeed(tempRoot, "S", seed2);
    const seeds = await readSignatureSeeds(tempRoot, "S");
    expect(seeds).toHaveLength(2);
    expect(seeds.map((s) => s.signature)).toEqual(["a", "b"]);
  });

  it("readSignatureSeeds returns [] when file missing", async () => {
    const seeds = await readSignatureSeeds(tempRoot, "nope");
    expect(seeds).toEqual([]);
  });

  it("readSignatureSeeds returns [] on corrupt JSON", async () => {
    const path = signaturesPathFor(tempRoot, "broken");
    await mkdir(join(tempRoot, ".minsky", "state", "unasked-direction-signatures"), {
      recursive: true,
    });
    await writeFile(path, "not json", "utf-8");
    const seeds = await readSignatureSeeds(tempRoot, "broken");
    expect(seeds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: golden / negative-case fixtures
// ---------------------------------------------------------------------------

describe("acceptance — full lifecycle", () => {
  it("golden case: write → list → mark-real → seed → read", async () => {
    const sessionId = "golden-session";
    await writeFindings(tempRoot, sessionId, makeOutput(), { taskId: "mt#1543" });

    const sessions = await listFindingsSessions(tempRoot);
    expect(sessions).toContain(sessionId);

    const updated = await updateFindingVerdict(tempRoot, sessionId, 0, "real", "promoted");
    expect(updated).toBe(true);

    const record = (await readFindings(tempRoot, sessionId)) as FindingsRecord;
    const target = record.findings[0];
    expect(target?.verdict).toBe("real");
    expect(target?.note).toBe("promoted");

    if (target) {
      await appendSignatureSeed(tempRoot, sessionId, {
        signature: target.finding.suggestedSignature,
        sourceSessionId: sessionId,
        sourceFindingIndex: 0,
        promotedAt: new Date().toISOString(),
        note: "promoted",
      });
    }

    const seeds = await readSignatureSeeds(tempRoot, sessionId);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.signature).toBe(FIXTURE_FINDING.suggestedSignature);
  });
});
