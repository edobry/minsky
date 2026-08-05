/* eslint-disable custom/no-real-fs-in-tests -- these assert WHERE a file lands,
   which is the defect (mt#3745). An injected fs would move the assertion off
   the property under test: the resolution is real-fs `findRepoRoot` walking a
   real `.git` marker, and a fake would let a wrong root pass. Uses mkdtemp
   scratch dirs, never the developer's real state dir. */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendEvaluationRecord as appendRetrospectiveTrigger } from "./retrospective-trigger-scanner";
import {
  appendEvaluationRecord as appendSilentStretch,
  readEvaluationLogText as readSilentStretch,
} from "./silent-stretch-detector";
import { appendEvaluationRecord as appendStopAtDecision } from "./stop-at-decision-scan";
import { appendEvaluationRecord as appendOperatorDeferral } from "./operator-deferral-detector";

/**
 * mt#3745 — per-DETECTOR rooting, not just the shared helper.
 *
 * The helper's own test (`dispatcher.test.ts`) pins the precedence chain. These
 * pin that each detector actually ROUTES through it: a detector that kept its
 * own `resolve(findRepoRoot(cwd), …)` would still pass the helper's test while
 * scattering records exactly as before. That gap is what the reviewer flagged
 * on PR #2671, and it is real — "they all call the helper" was an assertion
 * about the diff, not a property under test.
 */

interface Fixture {
  projectRepo: string;
  strayRepo: string;
  cleanup: () => void;
}

function makeFixture(label: string): Fixture {
  const projectRepo = mkdtempSync(join(tmpdir(), `mt3745-${label}-project-`));
  const strayRepo = mkdtempSync(join(tmpdir(), `mt3745-${label}-stray-`));
  mkdirSync(join(projectRepo, ".git"));
  mkdirSync(join(strayRepo, ".git"));
  return {
    projectRepo,
    strayRepo,
    cleanup: () => {
      rmSync(projectRepo, { recursive: true, force: true });
      rmSync(strayRepo, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with CLAUDE_PROJECT_DIR set, restoring whatever was there before. */
function withProjectDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
}

const SILENT_STRETCH_STREAM_FILE = "silent-stretch-evaluations.jsonl";

const DETECTORS: ReadonlyArray<{
  label: string;
  streamFile: string;
  append: (cwd: string, record: Record<string, unknown>) => void;
}> = [
  {
    label: "retrospective-trigger",
    streamFile: "retrospective-trigger-evaluations.jsonl",
    append: appendRetrospectiveTrigger,
  },
  {
    label: "silent-stretch",
    streamFile: SILENT_STRETCH_STREAM_FILE,
    append: appendSilentStretch,
  },
  {
    label: "stop-at-decision",
    streamFile: "stop-at-decision-evaluations.jsonl",
    append: appendStopAtDecision,
  },
  // mt#3782 — the fourth writer, missed by mt#3745's enumeration.
  {
    label: "operator-deferral",
    streamFile: "operator-deferral-evaluations.jsonl",
    append: appendOperatorDeferral,
  },
];

describe("evaluation-stream rooting, per detector (mt#3745 AT1)", () => {
  for (const detector of DETECTORS) {
    test(`${detector.label}: the record lands under CLAUDE_PROJECT_DIR, not the guard's cwd`, () => {
      const fx = makeFixture(detector.label);
      try {
        withProjectDir(fx.projectRepo, () => {
          // `cwd` is the stray repo — what a guard running in a session workspace passes.
          detector.append(fx.strayRepo, { timestamp: "2026-08-05T00:00:00Z", probe: true });
        });

        const landed = join(fx.projectRepo, ".minsky", detector.streamFile);
        const stray = join(fx.strayRepo, ".minsky", detector.streamFile);

        expect(existsSync(landed)).toBe(true);
        expect(JSON.parse(readFileSync(landed, "utf-8").trim())).toEqual({
          timestamp: "2026-08-05T00:00:00Z",
          probe: true,
        });
        // The defect, stated as an assertion: nothing under the guard's cwd.
        expect(existsSync(stray)).toBe(false);
      } finally {
        fx.cleanup();
      }
    });
  }
});

describe("silent-stretch dedupe reader rooting (mt#3745 AT3)", () => {
  // The reader had the bug INDEPENDENTLY of the writer: reading a cwd-rooted
  // path inside a session workspace dedupes against the wrong (usually empty)
  // log, so the dedupe silently stops deduping exactly where the stray writes
  // were landing. Seeding BOTH locations with different content is what makes
  // this test able to fail — if it read the stray, it would find "STRAY".
  test("reads the CLAUDE_PROJECT_DIR-rooted log, not the one under cwd", () => {
    const fx = makeFixture("reader");
    try {
      const projectLog = join(fx.projectRepo, ".minsky", SILENT_STRETCH_STREAM_FILE);
      const strayLog = join(fx.strayRepo, ".minsky", SILENT_STRETCH_STREAM_FILE);
      mkdirSync(join(fx.projectRepo, ".minsky"), { recursive: true });
      mkdirSync(join(fx.strayRepo, ".minsky"), { recursive: true });
      writeFileSync(projectLog, `${JSON.stringify({ marker: "PROJECT" })}\n`, "utf-8");
      writeFileSync(strayLog, `${JSON.stringify({ marker: "STRAY" })}\n`, "utf-8");

      const text = withProjectDir(fx.projectRepo, () => readSilentStretch(fx.strayRepo));

      expect(text).toBeDefined();
      expect(text).toContain("PROJECT");
      expect(text).not.toContain("STRAY");
    } finally {
      fx.cleanup();
    }
  });

  test("returns undefined when the resolved log does not exist", () => {
    const fx = makeFixture("reader-missing");
    try {
      const text = withProjectDir(fx.projectRepo, () => readSilentStretch(fx.strayRepo));
      expect(text).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});
