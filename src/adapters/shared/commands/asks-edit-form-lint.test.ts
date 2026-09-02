/**
 * `asks.edit` form-lint enforcement — mt#3929.
 *
 * mt#3326 made the form-lint checks consequential at the `asks.create` boundary and explicitly
 * left `asks.edit` alone ("does not compute form-lint at all"). But `asks_edit` is the repair
 * path the corpus recommends for a rejected create (mem#760 rule 4), so every fix-up landed on
 * the unenforced surface: ask#7591 (2026-08-10) was hard-rejected at create for
 * `over-word-budget` + `long-option-label`, trimmed to pass, then edited back over budget with
 * no warning at all.
 *
 * Lives in its own file rather than in `asks.test.ts` because that file is at its 1500-line
 * ceiling.
 */

/* eslint-disable custom/no-real-fs-in-tests -- reading the shipped source IS the point of the call-site drift check below */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import {
  asksEditParams,
  editRequiresFormLintGuard,
  mergeEditForFormLint,
  validateEditFormLintAgainstExistingAsk,
} from "./asks";

const KIND_DIRECTION_DECIDE = "direction.decide" as const;

/** Over the 60-char ceiling `long-option-label` enforces — the check ask#7591's create hit. */
const LONG_LABEL = `Expand scope: ${"x".repeat(60)}`;

/** A suspended Ask, walked through the real state machine so it has real timestamps. */
async function seedSuspendedAsk(repo: FakeAskRepository) {
  const ask = await repo.create({
    kind: KIND_DIRECTION_DECIDE,
    classifierVersion: "v1.0.0",
    requestor: "minsky.agent:test",
    title: "T",
    question: "Q",
    metadata: {},
  });
  await repo.transition(ask.id, "classified");
  await repo.transition(ask.id, "routed");
  await repo.transition(ask.id, "suspended");
  return ask;
}

describe("editRequiresFormLintGuard", () => {
  test("fires only on edits that can change what form-lint reads", () => {
    // The skip is the point: a title-only edit must not pay a repository fetch.
    expect(editRequiresFormLintGuard({ question: "new" })).toBe(true);
    expect(editRequiresFormLintGuard({ options: [{ label: "a", value: "a" }] })).toBe(true);
    expect(editRequiresFormLintGuard({ title: "new" })).toBe(false);
    expect(editRequiresFormLintGuard({ metadata: { a: 1 } })).toBe(false);
    expect(editRequiresFormLintGuard({ contextRefs: [] })).toBe(false);
  });
});

describe("mergeEditForFormLint", () => {
  const existing = {
    kind: KIND_DIRECTION_DECIDE,
    question: "existing question",
    options: [{ label: "existing", value: "existing" }],
  };

  test("an absent field comes from the existing ask, so the RESULT is what gets linted", () => {
    // Linting the payload alone would let either half slip past by being omitted: an
    // options-only edit is still bounded by the existing question's word count, and vice versa.
    expect(mergeEditForFormLint(existing, { question: "replaced" })).toEqual({
      kind: KIND_DIRECTION_DECIDE,
      question: "replaced",
      options: [{ label: "existing", value: "existing" }],
    });
  });

  test("a provided field wins over the existing one", () => {
    expect(mergeEditForFormLint(existing, { options: [{ label: "replaced" }] })).toEqual({
      kind: KIND_DIRECTION_DECIDE,
      question: "existing question",
      options: [{ label: "replaced" }],
    });
  });
});

describe("validateEditFormLintAgainstExistingAsk", () => {
  test("rejects an edit whose resulting options violate — the gap mt#3326 left open", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo);

    await expect(
      validateEditFormLintAgainstExistingAsk(repo, ask.id, {
        options: [{ label: LONG_LABEL, value: "v" }],
      })
    ).rejects.toThrow(/asks\.edit: .*form-lint violation/);
  });

  test("names the edit surface, so the message matches the boundary that rejected", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo);

    await expect(
      validateEditFormLintAgainstExistingAsk(repo, ask.id, {
        options: [{ label: LONG_LABEL, value: "v" }],
      })
    ).rejects.toThrow(/asks_edit boundary/);
  });

  test("acknowledgeFormWarnings is the same escape the create path offers", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo);

    await validateEditFormLintAgainstExistingAsk(repo, ask.id, {
      options: [{ label: LONG_LABEL, value: "v" }],
      acknowledgeFormWarnings: true,
    });
  });

  test("a clean edit passes", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedAsk(repo);

    await validateEditFormLintAgainstExistingAsk(repo, ask.id, {
      options: [{ label: "Short label", value: "v" }],
    });
  });

  test("fails OPEN when the ask cannot be fetched — a DB blip must not block a repair", async () => {
    const throwingRepo = {
      getById: async () => {
        throw new Error("transient");
      },
    } as unknown as Parameters<typeof validateEditFormLintAgainstExistingAsk>[0];

    await validateEditFormLintAgainstExistingAsk(throwingRepo, "any-id", {
      options: [{ label: LONG_LABEL, value: "v" }],
    });
    // A null repo is the same posture — execute() surfaces its own error.
    await validateEditFormLintAgainstExistingAsk(null, "any-id", {
      options: [{ label: LONG_LABEL, value: "v" }],
    });
  });
});

describe("asks.edit parameter surface", () => {
  test("exposes the override param, so the escape is reachable from the tool", () => {
    expect(asksEditParams.acknowledgeFormWarnings).toBeDefined();
    expect(asksEditParams.acknowledgeFormWarnings.required).toBe(false);
  });
});

describe("both edit guards run adjacent to the write (PR #2779 R1)", () => {
  // A validate-time read deciding a write that happens later is a TOCTOU window: a concurrent
  // edit landing in between persists a body nothing checked. Both guards therefore run again
  // inside `execute`, against a fresh read.
  //
  // Asserted against the source rather than by driving the command, because what regressed
  // would be the CALL SITE — a future edit moving either guard back to validate-only restores
  // the window while every behavioral test on the guard functions keeps passing.
  const FORM_LINT_GUARD = "validateEditFormLintAgainstExistingAsk";
  const APPROVE_OPTIONS_GUARD = "validateEditOptionsAgainstExistingAsk";
  const source = readFileSync(join(import.meta.dir, "asks.ts")).toString();
  const executeBody = source.slice(
    source.indexOf("execute: async (params): Promise<{ ask: Ask }>")
  );

  test("the form-lint guard is re-run in execute, not only in validate", () => {
    expect(executeBody).toContain(FORM_LINT_GUARD);
  });

  test("the approve-options guard is re-run in execute too — same class, same window", () => {
    expect(executeBody).toContain(APPROVE_OPTIONS_GUARD);
  });

  test("both re-runs sit BEFORE the write they protect", () => {
    const write = executeBody.indexOf("editAskContent(repo");
    expect(write).toBeGreaterThan(executeBody.indexOf(FORM_LINT_GUARD));
    expect(write).toBeGreaterThan(executeBody.indexOf(APPROVE_OPTIONS_GUARD));
  });
});

/**
 * mt#4901 (PR #3571 R1) — the edit surface must normalize with the ask's own
 * contextRefs, exactly as the create surface does.
 *
 * Reviewer-caught. `validateFormLintNotViolated` called `linkifyExternalRefs`
 * bare, so it resolved nothing; the create path masked that because its caller
 * normalizes first, and the EDIT path did not.
 *
 * These assert BLOCKING behavior rather than a warning count, because that is
 * where the gap actually bit. `unlinkified-reference` is advisory and only ever
 * over-reports — but `portal-no-link` HARD-REJECTS an `authorization.approve`
 * question that names a portal action and carries no URL, which is precisely
 * the state of a question whose only citation is a page id the transform was
 * about to resolve. That is mt#2918's originating case, reintroduced on the
 * one surface it had not been checked on.
 */
describe("validateEditFormLintAgainstExistingAsk — contextRefs resolution (mt#4901)", () => {
  const PREFIX = "34f937f0";
  const FULL_URL = "https://app.notion.com/p/34f937f03cb48108a95bdf3813f5ca84";
  const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;
  /** Portal keyword + a truncated citation + no URL — the blocking shape. */
  const PORTAL_QUESTION = `Grant the permission described in Notion ${PREFIX}.`;

  async function seedApprovalAsk(
    repo: FakeAskRepository,
    contextRefs?: Array<{ kind: string; ref: string }>
  ) {
    const ask = await repo.create({
      kind: KIND_AUTHORIZATION_APPROVE,
      classifierVersion: "v1.0.0",
      requestor: "minsky.agent:test",
      title: "T",
      question: "Q",
      ...(contextRefs ? { contextRefs } : {}),
      metadata: {},
    });
    await repo.transition(ask.id, "classified");
    await repo.transition(ask.id, "routed");
    await repo.transition(ask.id, "suspended");
    return ask;
  }

  test("an edit citing a truncated id does NOT hard-reject when the ask carries the URL", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedApprovalAsk(repo, [{ kind: "url", ref: FULL_URL }]);

    await validateEditFormLintAgainstExistingAsk(repo, ask.id, { question: PORTAL_QUESTION });
  });

  test("negative control: the same edit on an ask with NO contextRefs is rejected", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedApprovalAsk(repo);

    await expect(
      validateEditFormLintAgainstExistingAsk(repo, ask.id, { question: PORTAL_QUESTION })
    ).rejects.toThrow(/portal-no-link/);
  });
});
