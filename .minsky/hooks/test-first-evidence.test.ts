import { describe, expect, it } from "bun:test";

// `extractExecutionEvidenceText` is no longer imported: as of mt#3584 this surface
// matches the negative-control label anywhere in the PR body, so these tests pass the
// full body — the same text production passes — rather than an extracted block.
import { checkExecutionEvidence, type PrFile } from "./require-execution-evidence-before-merge";
import {
  checkTestFirstEvidence,
  findModifiedTestFiles,
  hasNegativeControlEvidence,
  mentionsNegativeControl,
  isBugfixShapedTitle,
  isNegativeControlDeferred,
  isTestFirstSkipped,
  runTestFirstCalibration,
  specDescribesDefect,
  TEST_FIRST_SKIP_ENV_VAR,
} from "./test-first-evidence";

// ---------------------------------------------------------------------------
// Shared fixtures — hoisted to named constants per the sibling suite's
// convention (and to satisfy custom/no-magic-string-duplication).
//
// PR #2329 (mt#3234) and PR #2330 (mt#3238) are the two real bugfix PRs the
// mt#3244 spec replays; their file lists and titles are the ones recorded in the
// spec's 2026-07-30 diagnosis section.
// ---------------------------------------------------------------------------

/** PR #2329's modified test file — the artifact the blocking floor ignores. */
const ACTUATOR_TEST_TS = "src/cockpit/principal-channel-actuator.test.ts";
/** PR #2330's modified test file. */
const POLLER_TEST_TS = "src/cockpit/principal-channel-poller.test.ts";
/** Generic source-file fixture. */
const FOO_TS = "src/domain/foo.ts";
/** Generic test-file fixture. */
const FOO_TEST_TS = "src/domain/foo.test.ts";
/** The evidence-block marker the gate scans for. */
const EVIDENCE_MARKER = "Execution evidence:";
/** The negative-control label line, in its plain-label (colon-required) form. */
const NC_MARKER = "Negative control:";

const PR_2329_FILES: PrFile[] = [
  { filename: ACTUATOR_TEST_TS, status: "modified" },
  { filename: "src/cockpit/principal-channel-actuator.ts", status: "modified" },
  { filename: "src/cockpit/principal-channel-poller.ts", status: "modified" },
];

const PR_2329_TITLE = "fix(mt#3234): never-init child swallowed messages";

/** PR #2329's real body shape: an evidence block recording only a passing run. */
const PR_2329_BODY = [
  "## Summary",
  "",
  "Fixes the never-init child that swallowed messages.",
  "",
  EVIDENCE_MARKER,
  "",
  "```",
  `$ bun test ${ACTUATOR_TEST_TS}`,
  " 12 pass",
  " 0 fail",
  "```",
].join("\n");

const NON_BUGFIX_TITLE = "feat(mt#3244): add a test-first evidence surface";

/**
 * Calls the pure core the way the hook does — the FULL body, no extracted block (mt#3584).
 * The negative-control label is matched anywhere in the PR body, so passing the extracted
 * `Execution evidence:` section would test a narrower window than production uses.
 */
function check(files: PrFile[], title: string, body: string, spec: string | null = null) {
  return checkTestFirstEvidence(files, title, body, spec);
}

describe("findModifiedTestFiles (hole 2 — the set findNewTestFiles excludes)", () => {
  it("returns test files whose status is `modified`", () => {
    expect(findModifiedTestFiles(PR_2329_FILES)).toEqual([ACTUATOR_TEST_TS]);
  });

  it("ignores non-test files and added test files", () => {
    const files: PrFile[] = [
      { filename: FOO_TS, status: "modified" },
      { filename: "src/domain/new.test.ts", status: "added" },
    ];
    expect(findModifiedTestFiles(files)).toEqual([]);
  });
});

describe("isBugfixShapedTitle", () => {
  it("recognizes a `fix(` conventional-commit type", () => {
    expect(isBugfixShapedTitle(PR_2329_TITLE)).toBe(true);
  });

  it("does not treat a feat title as bugfix-shaped", () => {
    expect(isBugfixShapedTitle(NON_BUGFIX_TITLE)).toBe(false);
  });

  it("does not fire on the word `fix` appearing mid-title", () => {
    expect(isBugfixShapedTitle("feat(mt#1): add a fix-it button")).toBe(false);
  });
});

describe("specDescribesDefect", () => {
  it("recognizes a defect-shaped spec summary", () => {
    expect(specDescribesDefect("## Summary\n\nThe poller drops every message.")).toBe(true);
  });

  it("stays conservative on a feature-shaped spec", () => {
    expect(specDescribesDefect("## Summary\n\nAdd a new widget to the cockpit home page.")).toBe(
      false
    );
  });
});

describe("prefixed label forms (mt#3778)", () => {
  // Every one of these is a shape a writer actually produced. The gate logged 42
  // consecutive fires with zero passes, and 4 of the 16 records carrying the
  // discriminator were "mentioned but unmatched" — this is that class.
  const PREFIXED_RECORDS: ReadonlyArray<readonly [string, string]> = [
    [
      "dash prefix, bold, terminal period (PR #2565)",
      "**sc3 — negative control.**\nreverted; 3 red",
    ],
    ["colon prefix with trailing subject", "AT4: negative control — reverted the guard\nred"],
    ["bullet + slash-joined criteria", "- sc2/sc3 negative control: the fixture failed first"],
    ["step prefix, failing-first wording", "Step 2 — failing-first run: observed red"],
    ["colon prefix, terminates at EOL", "AT4: failing-first run\nobserved red"],
  ];

  for (const [label, body] of PREFIXED_RECORDS) {
    it(`counts a prefixed label: ${label}`, () => {
      expect(hasNegativeControlEvidence(body)).toBe(true);
    });
  }

  // The prefix allowance widens what counts as a record, so these pin the side
  // that must NOT widen. A false POSITIVE here is worse than the false negatives
  // this task fixes: it records a control that does not exist, and a test that
  // cannot fail is indistinguishable from one that can.
  const MUST_NOT_COUNT: ReadonlyArray<readonly [string, string]> = [
    ["a prefixed label with nothing beneath it", "**sc3 — negative control.**"],
    ["prose merely proposing one", "we should add a negative control here"],
    ["a prefixed NEGATION", "sc3 — no negative control: n/a"],
    ["an absence stated another way", "Missing negative control: none recorded"],
    [
      "a long prose sentence that happens to contain the phrase",
      "The reviewer asked whether we had ever considered a negative control: no",
    ],
    ["a fenced example", "```\nNegative control: example\n```"],
  ];

  for (const [label, body] of MUST_NOT_COUNT) {
    it(`does not count ${label}`, () => {
      expect(hasNegativeControlEvidence(body)).toBe(false);
    });
  }

  it("strips trailing emphasis, not just leading", () => {
    // The closing `**` sat exactly where the end-of-line form looks for the end.
    expect(hasNegativeControlEvidence("**sc3 — negative control.**\nred")).toBe(true);
    expect(hasNegativeControlEvidence("__AT1 — failing-first run__\nred")).toBe(true);
  });
});

describe("hasNegativeControlEvidence (hole 3 — the failing-first record)", () => {
  it("accepts a `Negative control:` label line with content", () => {
    const text = [NC_MARKER, "", "$ bun test foo.test.ts  # fix reverted", " 1 fail"].join("\n");
    expect(hasNegativeControlEvidence(text)).toBe(true);
  });

  it("accepts a `## Negative control` heading with content", () => {
    expect(hasNegativeControlEvidence("## Negative control\n\n 1 fail (pre-fix)")).toBe(true);
  });

  it("accepts a `Failing-first:` label", () => {
    expect(hasNegativeControlEvidence("Failing-first: 1 fail before the fix")).toBe(true);
  });

  it("rejects a marker with no content after it", () => {
    expect(hasNegativeControlEvidence("Negative control:\n")).toBe(false);
  });

  it("rejects an evidence block that only records passing runs", () => {
    expect(hasNegativeControlEvidence("$ bun test foo.test.ts\n 12 pass\n 0 fail")).toBe(false);
  });

  it("rejects a negated mention", () => {
    expect(hasNegativeControlEvidence("No negative control: not applicable here")).toBe(false);
  });

  // PR #2462 R1 — the mt#3277/mt#3316 fence class, both directions.
  it("does not count a marker that only appears inside a fenced block", () => {
    const text = ["```", NC_MARKER, " 1 fail", "```"].join("\n");
    expect(hasNegativeControlEvidence(text)).toBe(false);
  });

  it("does not stop at a `#` comment inside a fenced transcript", () => {
    const text = [NC_MARKER, "", "```bash", "# revert the fix first", " 1 fail", "```"].join("\n");
    expect(hasNegativeControlEvidence(text)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // mt#3511 — the label-shape widening. Every case here is a REAL record that
  // the pre-mt#3511 matcher reported as absent.
  // -------------------------------------------------------------------------
  describe("mt#3511: label shapes a writer actually uses", () => {
    it("accepts an em-dash-delimited label (PR #2508's shape)", () => {
      const text = [
        "**Negative control — telegram-transport.ts (3 poller tests)**",
        "",
        "```",
        " 3 fail",
        "```",
      ].join("\n");
      expect(hasNegativeControlEvidence(text)).toBe(true);
    });

    // The criterion this test exists for: "following the message must produce a
    // match." Before mt#3511 the message said accepted forms go "inside the
    // `Execution evidence:` block", and an author who did exactly that got told
    // no negative control was recorded (mt#3506 / PR #2499). This constructs the
    // shape the CURRENT message documents — label on its own line outside the
    // fence, run output fenced beneath it — and asserts it matches.
    it("accepts the exact shape the gate's own message documents", () => {
      const text = [
        "## Testing",
        "",
        "Execution evidence:",
        "",
        "```",
        "bun test ./x.test.ts -> 12 pass, 0 fail",
        "```",
        "",
        "Negative control: reverted the fix; the changed test observed FAILING.",
        "",
        "```",
        " 1 fail",
        "```",
      ].join("\n");
      expect(hasNegativeControlEvidence(text)).toBe(true);
    });

    it("accepts an en dash as well as an em dash", () => {
      expect(hasNegativeControlEvidence("Negative control – reverted the guard; 1 fail")).toBe(
        true
      );
    });

    it("accepts N distinct controls, each with its own subject", () => {
      const text = [
        "**Negative control — a.test.ts**",
        " 1 fail",
        "",
        "**Negative control — b.test.ts**",
        " 2 fail",
      ].join("\n");
      expect(hasNegativeControlEvidence(text)).toBe(true);
    });

    it("accepts a bulleted and bolded label", () => {
      expect(hasNegativeControlEvidence("- **Negative control:** reverted; 1 fail")).toBe(true);
    });

    it("still accepts the plain colon form unchanged", () => {
      expect(hasNegativeControlEvidence("Negative control: reverted the fix; 1 fail")).toBe(true);
    });

    it("still accepts a parenthetical before the colon", () => {
      expect(hasNegativeControlEvidence("Negative control (fix reverted): 1 fail")).toBe(true);
    });

    // The load-bearing half: a matcher loosened until everything matches has the
    // same information content as no gate at all.
    it("still rejects bare prose with no delimiter", () => {
      expect(hasNegativeControlEvidence("we should add a negative control here someday")).toBe(
        false
      );
    });

    it("still rejects a negated mention in the dash form", () => {
      expect(hasNegativeControlEvidence("No negative control — not applicable here")).toBe(false);
    });

    it("still rejects a marker that only appears inside a fence, dash form included", () => {
      const text = ["```", "**Negative control — example.ts**", " 1 fail", "```"].join("\n");
      expect(hasNegativeControlEvidence(text)).toBe(false);
    });

    it("rejects a hyphen, which is ordinary prose punctuation, not a label delimiter", () => {
      // `Negative control - foo` is how a sentence continues; only the em/en dash
      // reads as a heading, so widening to `-` would take prose with it.
      expect(hasNegativeControlEvidence("Negative control - style records are useful")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // mt#3511 — absent vs. present-but-unmatched. This is what makes the gate's
  // own false-negative rate countable instead of anecdotal.
  // -------------------------------------------------------------------------
  describe("mt#3511: mentionsNegativeControl", () => {
    it("is true for a mention the matcher rejects", () => {
      expect(mentionsNegativeControl("we should add a negative control here")).toBe(true);
    });

    it("is true even inside a fence, where the matcher deliberately will not look", () => {
      expect(mentionsNegativeControl(["```", "Negative control: x", "```"].join("\n"))).toBe(true);
    });

    it("is false when the evidence genuinely says nothing about one", () => {
      expect(mentionsNegativeControl("bun test ./src -> 12 pass, 0 fail")).toBe(false);
    });
  });
});

describe("isNegativeControlDeferred", () => {
  it("recognizes the numbered deferral marker", () => {
    expect(isNegativeControlDeferred("[negative-control-deferred: mt#3999]")).toBe(true);
  });

  it("requires a task id, not bare prose", () => {
    expect(isNegativeControlDeferred("negative control deferred, will do later")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT1 + AT5 — the widening demands evidence where the blocking floor demanded
// nothing, WITHOUT altering the blocking floor itself.
// ---------------------------------------------------------------------------

describe("AT1/AT5: PR #2329 replay (modified-only bugfix)", () => {
  it("AT5: checkExecutionEvidence still returns blocked:false — regression floor unchanged", () => {
    const result = checkExecutionEvidence(PR_2329_FILES, PR_2329_TITLE, PR_2329_BODY);
    expect(result.blocked).toBe(false);
    expect(result.newTestFiles).toEqual([]);
    expect(result.newScripts).toEqual([]);
  });

  it("AT1: the new surface now requires evidence for the same PR", () => {
    const result = check(PR_2329_FILES, PR_2329_TITLE, PR_2329_BODY);
    expect(result.bugfixShaped).toBe(true);
    expect(result.modifiedTestFiles).toEqual([ACTUATOR_TEST_TS]);
    expect(result.requiresNegativeControl).toBe(true);
    expect(result.negativeControlPresent).toBe(false);
    expect(result.flagged).toBe(true);
  });

  it("AT4: the pure core carries no blocking verdict at all", () => {
    const result = check(PR_2329_FILES, PR_2329_TITLE, PR_2329_BODY);
    expect("blocked" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT2 — PR #2330: evidence block records only passing runs.
// ---------------------------------------------------------------------------

describe("AT2: PR #2330 replay (passing runs only)", () => {
  it("flags a bugfix whose evidence block has no failing-first record", () => {
    const files: PrFile[] = [
      { filename: POLLER_TEST_TS, status: "modified" },
      { filename: "src/cockpit/principal-channel-poller.ts", status: "modified" },
    ];
    const body = [
      EVIDENCE_MARKER,
      "",
      "```",
      `$ bun test ${POLLER_TEST_TS}`,
      " 8 pass",
      "```",
    ].join("\n");
    const result = check(files, "fix(mt#3238): readiness gate deadlock", body);
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain("negative control");
  });
});

// ---------------------------------------------------------------------------
// AT3 — THE NEGATIVE CONTROL ON THE DETECTOR ITSELF.
//
// Per the mt#3244 spec, this test must be observed FAILING before the detector
// is written. A detector that cannot distinguish a compliant PR from a
// non-compliant one is exactly the non-discriminating probe mem#704 names.
// ---------------------------------------------------------------------------

describe("AT3: negative control — a compliant bugfix is NOT flagged", () => {
  it("does not flag a bugfix whose evidence block records a failing-first run", () => {
    const files: PrFile[] = [
      { filename: FOO_TEST_TS, status: "modified" },
      { filename: FOO_TS, status: "modified" },
    ];
    const body = [
      EVIDENCE_MARKER,
      "",
      "Negative control (fix reverted, test run against the un-fixed tree):",
      "",
      "```",
      `$ git stash && bun test ${FOO_TEST_TS}`,
      " 0 pass",
      " 1 fail",
      "```",
      "",
      "After the fix:",
      "",
      "```",
      `$ bun test ${FOO_TEST_TS}`,
      " 1 pass",
      " 0 fail",
      "```",
    ].join("\n");
    const result = check(files, "fix(mt#1234): correct the off-by-one", body);
    expect(result.requiresNegativeControl).toBe(true);
    expect(result.negativeControlPresent).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a bugfix carrying an explicit deferral marker", () => {
    const files: PrFile[] = [{ filename: FOO_TEST_TS, status: "modified" }];
    const body = `${EVIDENCE_MARKER}\n\n 1 pass\n\n[negative-control-deferred: mt#3999]`;
    const result = check(files, "fix(mt#1234): something", body);
    expect(result.flagged).toBe(false);
    expect(result.deferralMarker).toBe("mt#3999");
  });

  it("does not flag a non-bugfix PR that modifies a test file", () => {
    const files: PrFile[] = [{ filename: FOO_TEST_TS, status: "modified" }];
    const result = check(files, NON_BUGFIX_TITLE, `${EVIDENCE_MARKER}\n\n ok`);
    expect(result.bugfixShaped).toBe(false);
    expect(result.requiresNegativeControl).toBe(false);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a bugfix that modifies no test file", () => {
    const files: PrFile[] = [{ filename: FOO_TS, status: "modified" }];
    const result = check(files, PR_2329_TITLE, `${EVIDENCE_MARKER}\n\n ok`);
    expect(result.requiresNegativeControl).toBe(false);
    expect(result.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT4 — calibration surface is log-only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mt#3584 — the label is matched anywhere in the PR body, and the accepted-forms
// message says so. Before this, the matcher scanned only the extracted
// `Execution evidence:` block while the message stated only the fence rule, so a
// well-formed label placed just above the block was warned on anyway (PR #2531,
// PR #2553).
// ---------------------------------------------------------------------------

describe("mt#3584: negative-control label placement", () => {
  const BUGFIX_FILES: PrFile[] = [{ filename: FOO_TEST_TS, status: "modified" }];
  const BUGFIX_TITLE = "fix(mt#1234): x";

  // AT1 — the regression. Label ABOVE the heading, outside the block entirely.
  it("accepts a label placed above the Execution evidence heading", () => {
    const body = [
      "## Testing",
      "",
      "Negative control: reverted the fix and ran the suite — 3 tests failed.",
      "",
      "```",
      " 3 fail (pre-fix)",
      "```",
      "",
      EVIDENCE_MARKER,
      "",
      "```",
      " 12 pass",
      "```",
    ].join("\n");

    expect(check(BUGFIX_FILES, BUGFIX_TITLE, body).flagged).toBe(false);
  });

  // AT2 — no regression to the placement that already worked.
  it("still accepts a label inside the evidence block", () => {
    const body = `${EVIDENCE_MARKER}\n\nNegative control: reverted the fix.\n\n 1 fail (pre-fix)\n`;
    expect(check(BUGFIX_FILES, BUGFIX_TITLE, body).flagged).toBe(false);
  });

  // AT3 — mt#3506's fence rule is preserved. A fenced marker is quoted text.
  it("still rejects a label inside a code fence", () => {
    const body = [
      EVIDENCE_MARKER,
      "",
      "```",
      "Negative control: reverted the fix and ran the suite.",
      "```",
    ].join("\n");

    expect(check(BUGFIX_FILES, BUGFIX_TITLE, body).flagged).toBe(true);
  });

  // AT4 — message and matcher checked against each other, not read separately.
  // The paragraph must state the fence rule and must NOT re-impose a block
  // requirement the matcher no longer enforces.
  it("emits a message whose stated placement rule the matcher actually accepts", () => {
    const flagged = check(BUGFIX_FILES, BUGFIX_TITLE, `${EVIDENCE_MARKER}\n\n 12 pass\n`);
    expect(flagged.flagged).toBe(true);

    const run = runTestFirstCalibration(
      "mt#1234",
      1,
      BUGFIX_FILES,
      BUGFIX_TITLE,
      `${EVIDENCE_MARKER}\n\n 12 pass\n`,
      null
    );
    const warning = run.warning ?? "";
    expect(warning).toContain("NOT inside a code fence");
    expect(warning).toContain("anywhere in the PR body");
    // The removed constraint must not creep back into the prose while the
    // matcher stays wide — that mismatch IS the defect this task fixed.
    expect(warning).not.toContain("inside the `Execution evidence:` block");
  });
});

describe("AT4: calibration surface never denies", () => {
  it("produces a warn-shaped result with a calibration record when flagged", () => {
    const run = runTestFirstCalibration(
      "mt#3234",
      2329,
      PR_2329_FILES,
      PR_2329_TITLE,
      PR_2329_BODY,
      null
    );
    expect(run.ranCheck).toBe(true);
    expect(run.warning).toContain("CALIBRATION");
    expect(run.calibrationRecord).not.toBeNull();
    expect(run.calibrationRecord?.decision).toBe("warn");
  });

  it("emits no warning for a compliant PR", () => {
    const body = `${EVIDENCE_MARKER}\n\nNegative control:\n\n 1 fail (pre-fix)\n`;
    const run = runTestFirstCalibration(
      "mt#1234",
      1,
      [{ filename: FOO_TEST_TS, status: "modified" }],
      "fix(mt#1234): x",
      body,
      null
    );
    expect(run.warning).toBeNull();
    expect(run.calibrationRecord).toBeNull();
  });

  it("honors the documented override env var", () => {
    expect(isTestFirstSkipped({ [TEST_FIRST_SKIP_ENV_VAR]: "1" })).toBe(true);
    expect(isTestFirstSkipped({})).toBe(false);
  });
});
