import { describe, expect, it } from "bun:test";

import { checkExecutionEvidence, type PrFile } from "./require-execution-evidence-before-merge";
import {
  checkRenderPathEvidence,
  findRenderPathFiles,
  hasOpenableArtifact,
  isRenderPathFile,
  isRenderPathSkipped,
  runRenderPathCalibration,
  RENDER_PATH_SKIP_ENV_VAR,
} from "./render-path-evidence";

// ---------------------------------------------------------------------------
// Shared fixtures — hoisted per the sibling suite's convention (and to satisfy
// custom/no-magic-string-duplication).
//
// The two render-path files are the real surfaces from the incidents mt#2421
// replays: mt#2398 (the conversation route that 404'd) and mt#3810 (the image
// renderer that shipped unlooked-at).
// ---------------------------------------------------------------------------

/** mt#3810's renderer — a real `.tsx` under the cockpit web tree. */
const RENDERERS_TSX = "src/cockpit/web/components/ConversationElementRenderers.tsx";
/** mt#3810's own test file, which must NOT itself trigger the check. */
const RENDERERS_TEST_TSX = "src/cockpit/web/components/ConversationElementRenderers.image.test.tsx";
/** A non-render `.ts` under the same tree — hooks/lib code a unit test can settle. */
const LINKIFIER_TS = "src/cockpit/web/lib/entity-linkifier.ts";
/** A file well outside any render path. */
const DOMAIN_TS = "src/domain/foo.ts";
/** A generic test file outside the cockpit tree. */
const DOMAIN_TEST_TS = "src/domain/foo.test.ts";

const TASK = "mt#2421";
const PR_NUMBER = 9999;

/** The evidence-block marker the parent gate scans for. */
const EVIDENCE_MARKER = "Execution evidence:";

/** A body carrying only the inward-pointing evidence mt#3810 actually shipped. */
const BODY_NO_ARTIFACT = [
  "## Summary",
  "Render Anthropic image content blocks in the conversation view.",
  "",
  EVIDENCE_MARKER,
  "```",
  "bun test src/cockpit/web/components/ConversationElementRenderers.image.test.tsx",
  " 6 pass, 0 fail",
  "```",
  "",
  "Bundle grep confirms the deployed chunk carries the new element kind.",
].join("\n");

/** The same body plus a link to the deployed surface. */
const BODY_WITH_URL = `${BODY_NO_ARTIFACT}

## Live verification
https://cockpit-preview-production.up.railway.app/conversation/03d2e32d-a86e-4c18-bf7b-333327c720f6`;

function file(filename: string, status: PrFile["status"] = "modified"): PrFile {
  return { filename, status };
}

describe("isRenderPathFile", () => {
  it("matches a .tsx under the cockpit web tree", () => {
    expect(isRenderPathFile(RENDERERS_TSX)).toBe(true);
  });

  it("does NOT match that file's own test — a test file changes no rendered surface", () => {
    expect(isRenderPathFile(RENDERERS_TEST_TSX)).toBe(false);
  });

  it("does NOT match a .ts under the same tree — the distinguishing property is producing pixels", () => {
    expect(isRenderPathFile(LINKIFIER_TS)).toBe(false);
  });

  it("does NOT match a file outside the render paths", () => {
    expect(isRenderPathFile(DOMAIN_TS)).toBe(false);
  });
});

describe("findRenderPathFiles", () => {
  it("excludes a removed file — a deleted component renders nothing to show", () => {
    expect(findRenderPathFiles([file(RENDERERS_TSX, "removed")])).toEqual([]);
  });

  it("includes an added file", () => {
    expect(findRenderPathFiles([file(RENDERERS_TSX, "added")])).toEqual([RENDERERS_TSX]);
  });
});

describe("hasOpenableArtifact", () => {
  it("is false for a body carrying only test output and a bundle grep", () => {
    expect(hasOpenableArtifact(BODY_NO_ARTIFACT)).toBe(false);
  });

  it("is true for a deployed-surface URL", () => {
    expect(hasOpenableArtifact(BODY_WITH_URL)).toBe(true);
  });

  it("is true for a localhost URL — the principal running the cockpit can open it", () => {
    expect(hasOpenableArtifact("Verified at http://localhost:3737/conversation/abc")).toBe(true);
  });

  it("is true for a markdown image — a pasted screenshot IS the render", () => {
    expect(hasOpenableArtifact("![the rendered turn](./shot.png)")).toBe(true);
  });

  it("is true for a github user-attachments URL, where PR screenshots live", () => {
    expect(hasOpenableArtifact("https://github.com/user-attachments/assets/0f3a-4b21-shot")).toBe(
      true
    );
  });

  it("is false for repo-internal navigation alone — the probe must be able to fail", () => {
    const body = [
      "Supersedes https://github.com/edobry/minsky/pull/2711",
      "Fixes https://github.com/edobry/minsky/issues/2420",
      "See https://github.com/edobry/minsky/commit/eb2c4220c",
    ].join("\n");
    expect(hasOpenableArtifact(body)).toBe(false);
  });

  it("counts a URL inside a fence — a fenced curl IS the check, not a quoted claim", () => {
    const body = ["```bash", "curl -s http://127.0.0.1:3737/api/health", "```"].join("\n");
    expect(hasOpenableArtifact(body)).toBe(true);
  });

  it("ignores a URL that appears only in an HTML comment", () => {
    expect(hasOpenableArtifact("<!-- https://example.com/preview -->")).toBe(false);
  });
});

describe("checkRenderPathEvidence", () => {
  it("does not apply when the PR touches no render-path file", () => {
    const result = checkRenderPathEvidence([file(DOMAIN_TS)], BODY_NO_ARTIFACT);
    expect(result.applicable).toBe(false);
  });

  it("applies to a no-test render-path PR with no artifact (the mt#2398 shape)", () => {
    const result = checkRenderPathEvidence([file(RENDERERS_TSX)], BODY_NO_ARTIFACT);
    expect(result.applicable).toBe(true);
    expect(result.hasArtifact).toBe(false);
    expect(result.hasTests).toBe(false);
  });

  it("STILL applies when the PR carries tests (the mt#3810 shape the old trigger missed)", () => {
    const result = checkRenderPathEvidence(
      [file(RENDERERS_TSX), file(RENDERERS_TEST_TSX, "added")],
      BODY_NO_ARTIFACT
    );
    expect(result.applicable).toBe(true);
    expect(result.hasArtifact).toBe(false);
    expect(result.hasTests).toBe(true);
  });
});

describe("runRenderPathCalibration", () => {
  it("warns and records for a no-test render-path PR with no artifact", () => {
    const run = runRenderPathCalibration(
      TASK,
      PR_NUMBER,
      [file(RENDERERS_TSX)],
      BODY_NO_ARTIFACT,
      {}
    );
    expect(run.ranCheck).toBe(true);
    expect(run.warning).toContain("render-path");
    expect(run.calibrationRecord).toBeDefined();
    expect(run.calibrationRecord?.renderPathFiles).toEqual([RENDERERS_TSX]);
  });

  it("warns and records when the PR carries tests, and says why they do not substitute", () => {
    const run = runRenderPathCalibration(
      TASK,
      PR_NUMBER,
      [file(RENDERERS_TSX), file(RENDERERS_TEST_TSX, "added")],
      BODY_NO_ARTIFACT,
      {}
    );
    expect(run.warning).toContain("happy-dom");
    expect(run.calibrationRecord?.hasTests).toBe(true);
  });

  it("stays silent once the body carries an openable URL", () => {
    const run = runRenderPathCalibration(TASK, PR_NUMBER, [file(RENDERERS_TSX)], BODY_WITH_URL, {});
    expect(run.ranCheck).toBe(true);
    expect(run.warning).toBeUndefined();
    expect(run.calibrationRecord).toBeUndefined();
  });

  it("stays silent for a PR touching no render-path file", () => {
    const run = runRenderPathCalibration(TASK, PR_NUMBER, [file(DOMAIN_TS)], BODY_NO_ARTIFACT, {});
    expect(run.warning).toBeUndefined();
  });

  it("captures the judged PR body so a later re-check cannot silently re-derive a verdict", () => {
    const run = runRenderPathCalibration(
      TASK,
      PR_NUMBER,
      [file(RENDERERS_TSX)],
      BODY_NO_ARTIFACT,
      {}
    );
    const captured = run.calibrationRecord?.judgedPrBody as { hash?: string } | undefined;
    expect(typeof captured?.hash).toBe("string");
    expect(run.calibrationRecord?.captureSchema).toBe(1);
  });

  it("is skipped by its override env var", () => {
    const env = { [RENDER_PATH_SKIP_ENV_VAR]: "1" };
    expect(isRenderPathSkipped(env)).toBe(true);
    const run = runRenderPathCalibration(
      TASK,
      PR_NUMBER,
      [file(RENDERERS_TSX)],
      BODY_NO_ARTIFACT,
      env
    );
    expect(run.ranCheck).toBe(false);
    expect(run.warning).toBeUndefined();
  });
});

describe("log-only posture", () => {
  // The load-bearing invariant: this surface must never turn an allow into a deny.
  // A render-path PR that adds no test file and no operational script sits below the
  // parent gate's blocking floor, and adding this check must not change that.
  it("a render-path-only PR with no artifact is still NOT blocked by the parent gate", () => {
    const result = checkExecutionEvidence(
      [file(RENDERERS_TSX)],
      "feat: render image content blocks",
      BODY_NO_ARTIFACT
    );
    expect(result.blocked).toBe(false);
  });

  it("stays unblocked even when the render-path PR also carries a MODIFIED test file", () => {
    const result = checkExecutionEvidence(
      [file(RENDERERS_TSX), file(DOMAIN_TEST_TS, "modified")],
      "fix: correct the image media type",
      BODY_NO_ARTIFACT
    );
    expect(result.blocked).toBe(false);
  });
});
