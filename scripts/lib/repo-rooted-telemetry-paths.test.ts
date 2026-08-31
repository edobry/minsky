/* eslint-disable custom/no-real-fs-in-tests -- this check's entire subject is the REAL source
   tree: it asserts that no file in the repo resolves a telemetry path against the repo root. A
   mocked filesystem would assert that a fixture I wrote contains what I put in it, which is the
   can't-fail probe (mem#704) rather than the check. The pure functions under test take
   `ScannedFile[]` and touch no fs at all — every synthetic case below drives them directly; the
   fs is confined to `realTree()`, which supplies the one input that must not be a fixture. */
/**
 * mt#4816 SC5 — the behaviour-scoped check, run against the real tree plus synthetic controls.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALLOWLIST,
  SCAN_ROOTS,
  findRepoRootedTelemetryPaths,
  findStaleAllowlistEntries,
  findUnallowedRepoRootedTelemetryPaths,
  type ScannedFile,
} from "./repo-rooted-telemetry-paths";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "web-dist", "generated"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function realTree(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walk(join(REPO_ROOT, root))) {
      files.push({ path: relative(REPO_ROOT, full), source: readFileSync(full, "utf-8") });
    }
  }
  return files;
}

describe("SC5 — no unallowed writer resolves a telemetry path against the repo root", () => {
  test("the real tree carries no unallowed repo-rooted telemetry path", () => {
    const findings = findUnallowedRepoRootedTelemetryPaths(realTree());
    // The message names the file AND the expression: mt#4804's lesson is that a check reporting
    // a COUNT is useless here, because the whole cost of this class is that the writer is unnamed.
    expect(findings.map((f) => `${f.path}: ${f.expression}`)).toEqual([]);
  });

  test("every allowlist entry still matches something, so a fixed writer's exemption is noticed", () => {
    // Without this, an entry outlives the writer it excused and silently widens the hole. It is
    // also how mt#4755's TRACKED entry announces that it is ready to be removed.
    expect(findStaleAllowlistEntries(realTree())).toEqual([]);
  });

  test("every allowlist entry carries a non-empty reason", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `${path} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe("SC5 — the check can fail, and on the right shape", () => {
  /** Stand-in path for synthetic sources; the path is irrelevant to what these cases assert. */
  const SYNTHETIC_HOOK = ".minsky/hooks/some-detector.ts";

  test("AT2 control: it flags the historical ask-form-lint writer, which lived OUTSIDE .minsky/hooks", () => {
    // This is the case that motivates the whole design. Three directory-scoped sweeps ran before
    // mt#4811 and none could see this file, because it sits in src/adapters/shared/commands/.
    // The source below is the pre-mt#4811 shape, verbatim in the parts that matter.
    const preFix: ScannedFile = {
      path: "src/adapters/shared/commands/ask-form-lint-calibration.ts",
      source: `
        const ASK_FORM_LINT_CALIBRATION_LOG = ".minsky/ask-form-lint-calibration.jsonl";
        export async function appendAskFormLintCalibrationRecord(workspacePath: string, r: R) {
          const logPath = resolve(workspacePath, ASK_FORM_LINT_CALIBRATION_LOG);
          appendFileSync(logPath, JSON.stringify(r) + "\\n", "utf-8");
        }
      `,
    };
    const findings = findRepoRootedTelemetryPaths([preFix]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("src/adapters/shared/commands/ask-form-lint-calibration.ts");
  });

  test("AT2 control: it flags a writer whose path never reaches an fs call in the same file", () => {
    // Keying on appendFileSync/writeFileSync would miss this, and that is not hypothetical: both
    // real allowlisted files write through a one-hop helper and a write-keyed scan found neither.
    const viaHelper: ScannedFile = {
      path: SYNTHETIC_HOOK,
      source: `
        const watermarkPath = join(repoRoot, WATERMARK_STORE_PATH);
        writeStore(watermarkPath, updated);
      `,
    };
    expect(findRepoRootedTelemetryPaths([viaHelper])).toHaveLength(1);
  });

  test("it does NOT flag the state-dir shape this family is migrating TO", () => {
    const fixed: ScannedFile = {
      path: ".minsky/hooks/verify-subagent-model.ts",
      source: `const logPath = join(getSubagentModelStateDir(env), MISMATCH_LOG);`,
    };
    expect(findRepoRootedTelemetryPaths([fixed])).toEqual([]);
  });

  test("it does NOT flag repo-rooted paths that are config, build output, or a requested artifact", () => {
    // All three are real measurements from a coarser draft of this scan, kept as regression pins.
    const notTelemetry: ScannedFile[] = [
      {
        path: "packages/domain/src/rules/operations/config-operations.ts",
        source: `const configPath = join(workspacePath, ".minsky", "config.yaml");`,
      },
      {
        path: "scripts/generate-dockerfile-bun-build.ts",
        source: `const dockerfilePath = join(repoRoot, "Dockerfile");`,
      },
      {
        path: "src/adapters/shared/commands/tasks/deps-rendering-graphviz.ts",
        source: `const finalOutputPath = outputPath || join(process.cwd(), defaultFilename);`,
      },
    ];
    expect(findRepoRootedTelemetryPaths(notTelemetry)).toEqual([]);
  });

  // PR #3528 R1 — two shapes the first draft of this scan missed, both routine in this tree.
  test("R1: it flags a NAMESPACED join (`path.join`), not only a bare one", () => {
    const namespaced: ScannedFile = {
      path: SYNTHETIC_HOOK,
      source: `const logPath = path.join(repoRoot, ".minsky", "thing-calibration.jsonl");`,
    };
    expect(findRepoRootedTelemetryPaths([namespaced])).toHaveLength(1);
  });

  test("R1: it flags a MULTI-LINE argument list", () => {
    const multiline: ScannedFile = {
      path: SYNTHETIC_HOOK,
      source: `
        const calibrationPath = join(
          repoRoot,
          ".minsky",
          "thing-calibration.jsonl"
        );
      `,
    };
    expect(findRepoRootedTelemetryPaths([multiline])).toHaveLength(1);
  });

  test("R1: `catalogPath` and `loggerConfig` do NOT match on the `log` substring", () => {
    // The first draft used /log/i against the raw text, so `cataLOGPath` matched. Segmenting on
    // case boundaries fixes it without losing the camelCase names that MUST match.
    const substringTraps: ScannedFile[] = [
      { path: "a.ts", source: `const catalogPath = join(repoRoot, "catalog.json");` },
      { path: "b.ts", source: `const loggerConfigPath = join(repoRoot, "logger.json");` },
    ];
    expect(findRepoRootedTelemetryPaths(substringTraps)).toEqual([]);

    // …and the camelCase names it must still catch, in the same test so the pair cannot drift.
    const mustMatch: ScannedFile[] = [
      { path: "c.ts", source: `const logPath = join(repoRoot, "x.jsonl");` },
      { path: "d.ts", source: `const mainLog = join(repoRoot, "x.jsonl");` },
    ];
    expect(findRepoRootedTelemetryPaths(mustMatch)).toHaveLength(2);
  });

  test("it does NOT flag a state-dir path that merely mentions the repo root elsewhere", () => {
    // The project-keyed calibration shape: repoRoot appears, but only as the KEY's input.
    const projectKeyed: ScannedFile = {
      path: ".minsky/hooks/dispatcher.ts",
      source: `const logPath = join(getMinskyStateDir(), "projects", projectStateKey(repoRoot), name);`,
    };
    expect(findRepoRootedTelemetryPaths([projectKeyed])).toEqual([]);
  });
});
