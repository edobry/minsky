/* eslint-disable custom/no-real-fs-in-tests -- the hook reads/writes real files (dismissals JSON, calibration JSONL) and these tests verify those file-IO helpers end-to-end */
/**
 * Tests for the policy-coverage-detector hook helpers.
 *
 * The end-to-end flow (input → outcome) is covered by integration tests at
 * the corpus-loader / coverage / emit boundary; this file tests the helpers
 * that live inside the hook file (file-backed dismissals + message formatting).
 *
 * Acceptance:
 *   - readLocalDismissals tolerates missing file / corrupt JSON
 *   - readLocalDismissals returns the signature list when file is well-formed
 *   - formatPermitMessage cites source + line range
 *   - formatBlockMessage includes the question, signature, and options
 *
 * Reference: mt#1575 §Acceptance Tests, "dismissal does not re-fire" path
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLocalDismissals,
  formatPermitMessage,
  formatBlockMessage,
  appendCalibrationRecord,
} from "./policy-coverage-detector";
import type { CoverageEvidence } from "../../packages/domain/src/detectors/policy-coverage/coverage";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "policy-cov-hook-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("readLocalDismissals", () => {
  it("returns [] when the file does not exist", () => {
    const result = readLocalDismissals(join(tempRoot, "missing.json"));
    expect(result).toEqual([]);
  });

  it("returns [] when the file contains invalid JSON", async () => {
    const path = join(tempRoot, "bad.json");
    await writeFile(path, "{ not json", "utf-8");
    expect(readLocalDismissals(path)).toEqual([]);
  });

  it("returns the signatures array when file is well-formed", async () => {
    const path = join(tempRoot, "good.json");
    await writeFile(
      path,
      JSON.stringify({ signatures: ["sigA", "sigB"], comment: "ignored" }),
      "utf-8"
    );
    expect(readLocalDismissals(path)).toEqual(["sigA", "sigB"]);
  });

  it("returns [] when 'signatures' field is missing", async () => {
    const path = join(tempRoot, "missing-field.json");
    await writeFile(path, JSON.stringify({ other: "x" }), "utf-8");
    expect(readLocalDismissals(path)).toEqual([]);
  });

  it("filters non-string entries from signatures", async () => {
    const path = join(tempRoot, "mixed.json");
    await writeFile(path, JSON.stringify({ signatures: ["a", 42, null, "b"] }), "utf-8");
    expect(readLocalDismissals(path)).toEqual(["a", "b"]);
  });
});

describe("formatPermitMessage", () => {
  it("includes source + line range for each evidence entry", () => {
    const evidence: CoverageEvidence[] = [
      {
        policySource: "decision-defaults.mdc",
        span: "Datastores: Postgres-via-Supabase by default ...",
        lineRange: [10, 12],
        matchedCategory: "default",
        matchedAuthority: "must",
      },
    ];
    const msg = formatPermitMessage(evidence);
    expect(msg).toContain("decision-defaults.mdc:10-12");
    expect(msg).toContain("default");
    expect(msg).toContain("must");
  });
});

describe("formatBlockMessage", () => {
  it("renders question, signature, and options", () => {
    const msg = formatBlockMessage("Is this default authorized?", "abc1234567890def", [
      { label: "Approve once", description: "Allow this specific call." },
      { label: "Dismiss", description: "Suppress future matches." },
    ]);
    expect(msg).toContain("Is this default authorized?");
    expect(msg).toContain("abc1234567890def");
    expect(msg).toContain("Approve once");
    expect(msg).toContain("Dismiss");
  });

  it("renders options without descriptions cleanly", () => {
    const msg = formatBlockMessage("Q?", "sig", [{ label: "A" }]);
    expect(msg).toContain("- A");
    expect(msg).not.toContain("undefined");
  });
});

describe("dismiss-and-remember integration", () => {
  it("dismissed signature does not re-fire on next matching action", async () => {
    // Build the signature for an action; write it into the dismissals file;
    // confirm readLocalDismissals returns it. The hook short-circuits when
    // a signature appears here, so the same action will not re-emit.
    const { buildEvidenceSignature } = await import(
      "../../src/domain/detectors/policy-coverage/emit"
    );
    const action = {
      reason: "new-config-key" as const,
      detail: "edit to options.json",
      filePath: "src/options.json",
    };
    const signature = buildEvidenceSignature(action);

    const dismissalsPath = join(tempRoot, "policy-coverage-dismissals.json");
    await writeFile(dismissalsPath, JSON.stringify({ signatures: [signature] }), "utf-8");

    expect(readLocalDismissals(dismissalsPath)).toContain(signature);

    // Same action a second time: still produces the same signature, so
    // dismissal lookup hits.
    const secondSignature = buildEvidenceSignature(action);
    expect(secondSignature).toBe(signature);
    expect(readLocalDismissals(dismissalsPath)).toContain(secondSignature);
  });

  it("a different action's signature does NOT match a dismissed one", async () => {
    const { buildEvidenceSignature } = await import(
      "../../src/domain/detectors/policy-coverage/emit"
    );
    const dismissed = buildEvidenceSignature({
      reason: "new-config-key",
      detail: "x",
      filePath: "a.json",
    });
    const fresh = buildEvidenceSignature({
      reason: "new-dependency",
      detail: "y",
      filePath: "package.json",
    });

    const dismissalsPath = join(tempRoot, "policy-coverage-dismissals.json");
    await writeFile(dismissalsPath, JSON.stringify({ signatures: [dismissed] }), "utf-8");

    expect(readLocalDismissals(dismissalsPath)).toContain(dismissed);
    expect(readLocalDismissals(dismissalsPath)).not.toContain(fresh);
  });
});

describe("appendCalibrationRecord", () => {
  it("appends a JSONL line to the log path", async () => {
    const path = join(tempRoot, "calibration.jsonl");
    appendCalibrationRecord(path, { outcome: "covered", reason: "new-config-key" });
    appendCalibrationRecord(path, { outcome: "uncovered-blocked", reason: "new-dependency" });
    const text = await readFile(path, "utf-8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const [first, second] = lines;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first !== undefined) {
      expect(JSON.parse(first)).toMatchObject({ outcome: "covered" });
    }
    if (second !== undefined) {
      expect(JSON.parse(second)).toMatchObject({ outcome: "uncovered-blocked" });
    }
  });

  it("creates the parent directory if missing", async () => {
    const path = join(tempRoot, "nested", "subdir", "calibration.jsonl");
    appendCalibrationRecord(path, { outcome: "covered" });
    const text = await readFile(path, "utf-8");
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
