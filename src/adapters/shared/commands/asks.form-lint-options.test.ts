/**
 * `createAskWithFormLint` — option-label checks at the seam (mt#3253).
 *
 * Split out of `./asks.test.ts`, which sits at its 1500-line max-lines ceiling.
 *
 * The label RULES are unit-tested in `packages/shared/src/ask-option-label.test.ts`
 * and their lint wiring in `packages/domain/src/ask/form-lint.test.ts`. What this
 * file covers is the seam itself: that `createAskWithFormLint` passes `options`
 * into the lint at all (it did not before mt#3253 — the two option checks could
 * never fire in production no matter how the rules behaved), and that a firing
 * option check leaves Ask creation completely untouched at THIS layer, exactly
 * like the three v1 checks (mt#2798's warn-only posture for
 * `createAskWithFormLint` itself).
 *
 * `createAskWithFormLint` stays unconditionally non-blocking even after
 * mt#3326 — the hard-reject that task adds lives one layer up, in
 * `asks.create`'s command `validate` hook (`validateFormLintNotViolated`),
 * which runs and can throw BEFORE `createAskWithFormLint` is ever called.
 * See `asks.test.ts`'s `validateFormLintNotViolated` describe block for the
 * blocking-boundary tests.
 */
import { describe, expect, test } from "bun:test";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import { createAskWithFormLint } from "./asks";

const KIND_DIRECTION_DECIDE = "direction.decide" as const;
const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;

/** Skips the calibration-log write — see `asks.test.ts`'s use of the same path. */
const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_asks_create__";

const QUESTION = "Pick the replacement mechanism for boot-time auto-migrate.";
const TITLE = "Which deploy-keyed migration mechanism?";

/** The corpus worst case (2026-07-26): 167 chars AND letter-prefixed. */
const CORPUS_WORST_LABEL =
  "B — boundary fix + Stop-event ADVISORY guard (recommended): agent self-addresses admissions at turn end; dedup vs prompt-time scanner; first Stop dispatcher entrypoint";

describe("createAskWithFormLint — option-label checks (mt#3253)", () => {
  test("a long, letter-prefixed label surfaces both option warnings; the ask is still created", async () => {
    const repo = new FakeAskRepository();
    const { ask, formWarnings, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: TITLE,
        question: QUESTION,
        options: [
          { label: CORPUS_WORST_LABEL, value: "b" },
          { label: "Keep the current mechanism", value: "keep" },
        ],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // Creation is untouched — these checks are advisory, exactly like v1's.
    expect(ask.id).toBeTruthy();
    expect(await repo.getById(ask.id)).not.toBeNull();

    const expected: Array<"letter-prefixed-option-label" | "long-option-label"> = [
      "letter-prefixed-option-label",
      "long-option-label",
    ];
    expect(formLintMatches.map((m) => m.check).sort()).toEqual(expected.sort());
    expect(formWarnings.join(" ")).toContain("description");
  });

  test("the persisted option label is NOT rewritten by the lint", async () => {
    const repo = new FakeAskRepository();
    const { ask } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: TITLE,
        question: QUESTION,
        options: [{ label: CORPUS_WORST_LABEL, value: "b" }],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    // The lint warns the producer; normalization is a DISPLAY concern
    // (`stripOptionLetterPrefix`). Nothing mutates the stored label.
    const persisted = await repo.getById(ask.id);
    expect(persisted?.options?.[0]?.label).toBe(CORPUS_WORST_LABEL);
  });

  test("well-formed option labels surface no warnings", async () => {
    const repo = new FakeAskRepository();
    const { ask, formWarnings } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_DIRECTION_DECIDE,
        title: TITLE,
        question: QUESTION,
        options: [
          { label: "GitHub Actions migrate-on-merge", value: "gha" },
          { label: "Railway pre-deploy command", value: "railway" },
        ],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(ask.id).toBeTruthy();
    expect(formWarnings).toEqual([]);
  });

  test("an optionless ask is unaffected by the option checks", async () => {
    const repo = new FakeAskRepository();
    const { formWarnings } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Approve the deploy",
        question: "Approve deploying the current main to production.",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );
    expect(formWarnings).toEqual([]);
  });
});
