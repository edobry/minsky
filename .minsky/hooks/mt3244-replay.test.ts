#!/usr/bin/env bun
/**
 * Replay of the three mt#3244 defect merges through the execution-evidence gate — mt#3355
 * Success Criterion 5 / Acceptance Test 3.
 *
 * PRs #2324, #2329 and #2330 all merged 2026-07-26, and all three are inside the set of 36
 * merges that no gate evaluated (see `docs/architecture/hooks/merge-gate-task-resolution.md`).
 * The question this file answers is what the gate WOULD have decided had it run — which is the
 * difference between "the gate was satisfied on these PRs" and "the gate never ran," a
 * distinction mt#3244's spec originally got wrong.
 *
 * ## Scope of the claim (read this before trusting the result)
 *
 * The file lists and titles in `fixtures/mt3244-replay-prs.json` are CAPTURED verbatim from
 * the live GitHub API. The bodies are NOT: what the gate reads a body for is one boolean —
 * does `hasExecutionEvidence` find an `Execution evidence:` marker — and that boolean was
 * checked against the real bodies at capture time and recorded per PR.
 *
 * So rather than replay a transcribed body and quietly depend on the transcription, each PR is
 * replayed under BOTH a marker-free and a marker-bearing body. That is strictly more
 * informative: it shows which of the two inputs actually drives each verdict, and it means the
 * only thing taken on faith is a recorded boolean rather than several kilobytes of prose.
 * The stand-in bodies are not, and do not claim to be, the real ones.
 */

import { describe, test, expect } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the captured fixture is a real checked-in file; reading a mock of it would defeat the point of capturing it (mem#705)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkExecutionEvidence } from "./require-execution-evidence-before-merge";
import type { PrFile } from "./pr-context";

interface ReplayPr {
  number: number;
  task: string;
  title: string;
  realBodyHasEvidenceMarker: boolean;
  expectedBlocked: boolean;
  expectedReason: string;
  files: PrFile[];
}

const FIXTURE: { prs: ReplayPr[] } = JSON.parse(
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see above
  readFileSync(join(import.meta.dir, "fixtures", "mt3244-replay-prs.json"), "utf-8")
) as { prs: ReplayPr[] };

/** A body with no `Execution evidence:` marker — the property all three real bodies had. */
const BODY_WITHOUT_MARKER = "## Verification\n\n21 actuator tests pass. Typecheck and lint clean.";

/** The same body plus the literal marker the mt#1459 gate matches. */
const BODY_WITH_MARKER = `${BODY_WITHOUT_MARKER}\n\nExecution evidence:\n\n\`\`\`\n$ bun test\n66 pass, 0 fail\n\`\`\``;

describe("mt#3244 defect merges replayed through the execution-evidence gate", () => {
  test("every fixture PR records the marker-absent property the replay assumes", () => {
    // Guards the one input taken on faith: if a recapture ever finds a real body that DID
    // carry the marker, the marker-free replay below stops being the right question for it.
    for (const pr of FIXTURE.prs) {
      expect(pr.realBodyHasEvidenceMarker).toBe(false);
    }
  });

  test.each(FIXTURE.prs.map((pr) => [pr.number, pr] as const))(
    "PR #%s: marker-free body reproduces the recorded verdict",
    (_number, pr) => {
      const result = checkExecutionEvidence(pr.files, pr.title, BODY_WITHOUT_MARKER);
      expect(result.blocked).toBe(pr.expectedBlocked);
    }
  );

  test("PR #2324 would have been DENIED — 7 new test files and 2 new operational scripts", () => {
    const pr = FIXTURE.prs.find((p) => p.number === 2324) as ReplayPr;
    const result = checkExecutionEvidence(pr.files, pr.title, BODY_WITHOUT_MARKER);

    expect(result.blocked).toBe(true);
    // Adding the marker is what unblocks it — so for this PR the missing evidence, not the
    // file list alone, is the operative cause.
    expect(checkExecutionEvidence(pr.files, pr.title, BODY_WITH_MARKER).blocked).toBe(false);
  });

  test("PR #2330 would have been DENIED — 1 new operational script", () => {
    const pr = FIXTURE.prs.find((p) => p.number === 2330) as ReplayPr;
    const result = checkExecutionEvidence(pr.files, pr.title, BODY_WITHOUT_MARKER);

    expect(result.blocked).toBe(true);
    expect(checkExecutionEvidence(pr.files, pr.title, BODY_WITH_MARKER).blocked).toBe(false);
  });

  test("PR #2329 would have been ALLOWED, and its verdict does not depend on the body", () => {
    // The recorded expectation from mt#3355 Success Criterion 5. All three of its files are
    // `modified`; both triggers filter on status === "added", so neither fires and the body is
    // never consulted. Asserting the SAME verdict under both bodies is what proves
    // body-independence instead of assuming it — and it pins the gap precisely: a bugfix that
    // only modifies an existing test file is invisible to this gate. That gap is mt#3244's
    // scope, explicitly out of scope for mt#3355.
    const pr = FIXTURE.prs.find((p) => p.number === 2329) as ReplayPr;

    expect(checkExecutionEvidence(pr.files, pr.title, BODY_WITHOUT_MARKER).blocked).toBe(false);
    expect(checkExecutionEvidence(pr.files, pr.title, BODY_WITH_MARKER).blocked).toBe(false);
    expect(pr.files.every((f) => f.status === "modified")).toBe(true);
  });

  test("a [unverified-tests] title prefix is what the deny path tells authors to use", () => {
    // Completes the picture for the two denied PRs: neither carried the documented escape
    // hatch, so the deny would have been actionable rather than a dead end.
    const pr = FIXTURE.prs.find((p) => p.number === 2324) as ReplayPr;
    expect(pr.title).not.toContain("[unverified-tests]");

    const bypassed = checkExecutionEvidence(
      pr.files,
      `[unverified-tests] ${pr.title}`,
      BODY_WITHOUT_MARKER
    );
    expect(bypassed.blocked).toBe(false);
  });
});
