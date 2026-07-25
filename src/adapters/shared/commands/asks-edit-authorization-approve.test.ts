/**
 * Tests for the mt#3209 fix: `asks.edit` can reintroduce the mt#3203
 * unverifiable-approve-option footgun on an EXISTING `authorization.approve`
 * Ask.
 *
 * mt#3203 taught `asks.create` to reject an `authorization.approve` Ask whose
 * options carry no approve-shaped `value` — but that guard only fires at
 * create time, keyed off the caller-supplied `kind` param. `asks.edit` has no
 * `kind` field of its own (the edit payload alone doesn't say what kind the
 * target Ask is), so a wholesale `options` replacement on an ask that already
 * exists — including one already `kind: "authorization.approve"` — could
 * silently strip the last approve-shaped option and reproduce the same
 * footgun on a live Ask.
 *
 * This file exercises the two functions the fix adds to
 * `src/adapters/shared/commands/asks.ts`:
 *   - `validateEditOptionsAgainstExistingAsk` — fetches the target Ask's
 *     PERSISTED kind and re-runs it through `validateAuthorizationApproveOptions`
 *     (the SAME function mt#3203 wired into `asks.create`, so both surfaces
 *     resolve to the same `@minsky/shared/ask-approval` vocabulary — no
 *     second copy of the approve-token regex).
 *   - `editRequiresApproveOptionsGuard` — the pure gate that decides whether
 *     an edit needs the check at all, proving the "unaffected" success
 *     criteria are not merely inferred from code inspection.
 *
 * Split into its own file (rather than growing `asks.test.ts` further)
 * because `asks.test.ts` is already within a few hundred lines of the
 * project's 1500-line ESLint `max-lines` ceiling (`eslint-custom-rules.mdc`
 * / CLAUDE.md `§Code Style`) — see the precedent of `asks-github-client.test.ts`
 * for co-located-but-split test files in this directory.
 */

import { describe, expect, test } from "bun:test";

import {
  validateAsksEditParams,
  validateAuthorizationApproveOptions,
  validateEditOptionsAgainstExistingAsk,
  editRequiresApproveOptionsGuard,
} from "./asks";
import { APPROVAL_TOKEN, isApproveShapedToken } from "@minsky/shared/ask-approval";
// Cross-boundary parity import (mirrors asks.test.ts's mt#3203 usage): the
// redemption-time verifier this authoring/edit-time guard must agree with.
import { isApprovingPayload } from "../../../../.minsky/hooks/ask-verification";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { Ask, AskKind } from "@minsky/domain/ask/types";
import { ValidationError } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KIND_AUTHORIZATION_APPROVE: AskKind = "authorization.approve";
const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";

const FIXTURE_RESPONDER_ID = "com.anthropic.claude-code:proc:abc123";
const FIXTURE_QUESTION = "Which approach should we ship?";

// mt#3203's originating-incident labels, reused here for continuity with
// asks.test.ts's `validateAuthorizationApproveOptions` fixtures.
const FIXTURE_APPROVE_LABEL = "Approve the override and merge";
const FIXTURE_DECLINE_LABEL = "Leave it blocked — I'll look at the PR myself";

/** Seed a FakeAskRepository with one Ask of the given kind, return {repo, id}. */
async function seedAsk(kind: AskKind) {
  const repo = new FakeAskRepository();
  const ask = await repo.create({
    kind,
    classifierVersion: "v1.0.0",
    requestor: FIXTURE_RESPONDER_ID,
    title: "Existing ask",
    question: FIXTURE_QUESTION,
  });
  return { repo, id: ask.id };
}

// ---------------------------------------------------------------------------
// validateEditOptionsAgainstExistingAsk
// ---------------------------------------------------------------------------

describe("validateEditOptionsAgainstExistingAsk (mt#3209)", () => {
  test("rejects replacing options on an existing authorization.approve Ask with all-descriptive-label options", async () => {
    const { repo, id } = await seedAsk(KIND_AUTHORIZATION_APPROVE);

    await expect(
      validateEditOptionsAgainstExistingAsk(repo, id, [
        { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
        { label: FIXTURE_DECLINE_LABEL, value: FIXTURE_DECLINE_LABEL },
      ])
    ).rejects.toThrow(ValidationError);
  });

  test("rejects replacing options on an existing authorization.approve Ask with an empty array (mt#3209 review R1)", async () => {
    // validateAuthorizationApproveOptions (mt#3203, create-time) treats
    // empty/absent options as out of scope — a legitimate "free-text ask"
    // case AT CREATE TIME. That carve-out must NOT extend to an EDIT that
    // empties out options: doing so vacuously satisfies "no option carries
    // an approve-shaped value" and would let the mt#3203 footgun back in
    // through a one-character `options: []` edit that strips a previously
    // valid approve-shaped option.
    const { repo, id } = await seedAsk(KIND_AUTHORIZATION_APPROVE);

    await expect(validateEditOptionsAgainstExistingAsk(repo, id, [])).rejects.toThrow(
      ValidationError
    );
  });

  test("is unaffected replacing options with an empty array on a non-authorization.approve Ask", async () => {
    const { repo, id } = await seedAsk(KIND_DIRECTION_DECIDE);

    await expect(validateEditOptionsAgainstExistingAsk(repo, id, [])).resolves.toBeUndefined();
  });

  test("passes replacing options on an existing authorization.approve Ask when one option carries an approve-shaped value", async () => {
    const { repo, id } = await seedAsk(KIND_AUTHORIZATION_APPROVE);

    await expect(
      validateEditOptionsAgainstExistingAsk(repo, id, [
        { label: FIXTURE_APPROVE_LABEL, value: "approve" },
        { label: FIXTURE_DECLINE_LABEL, value: "decline" },
      ])
    ).resolves.toBeUndefined();
  });

  test("is unaffected for a non-authorization.approve Ask, even with the same all-descriptive-label options", async () => {
    const { repo, id } = await seedAsk(KIND_DIRECTION_DECIDE);

    await expect(
      validateEditOptionsAgainstExistingAsk(repo, id, [
        { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
        { label: FIXTURE_DECLINE_LABEL, value: FIXTURE_DECLINE_LABEL },
      ])
    ).resolves.toBeUndefined();
  });

  test("fail-open: no repository available (persistence unreachable at validate time)", async () => {
    // Mirrors buildAskRepository's own "no SQL-capable provider" contract:
    // it returns null rather than throwing. The guard degrades gracefully
    // here because execute() performs its own repository resolution and
    // will surface a clear "AskRepository unavailable" error on its own —
    // no edit reaches persistence either way.
    await expect(
      validateEditOptionsAgainstExistingAsk(null, "some-id", [
        { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
      ])
    ).resolves.toBeUndefined();
  });

  test("fail-open: the target Ask does not resolve (not-found surfaces from execute() instead)", async () => {
    const repo = new FakeAskRepository();

    await expect(
      validateEditOptionsAgainstExistingAsk(repo, "no-such-ask-id", [
        { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
      ])
    ).resolves.toBeUndefined();
  });

  test("fail-open: repository.getById throws (transient persistence failure at validate time)", async () => {
    class ThrowingGetByIdRepository extends FakeAskRepository {
      override async getById(): Promise<Ask | null> {
        throw new Error("simulated transient DB failure");
      }
    }
    const repo = new ThrowingGetByIdRepository();

    await expect(
      validateEditOptionsAgainstExistingAsk(repo, "irrelevant-id", [
        { label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL },
      ])
    ).resolves.toBeUndefined();
  });

  test("vocabulary parity: the edit-time check, validateAuthorizationApproveOptions (mt#3203, create-time), and the redemption-time verifier agree on every accepted/rejected token", async () => {
    // Proves THREE surfaces resolve to the SAME @minsky/shared/ask-approval
    // vocabulary — not independently-maintained copies: the edit-time path
    // (this function), the create-time path (validateAuthorizationApproveOptions,
    // imported directly here too), and .minsky/hooks/ask-verification.ts's
    // isApprovingPayload — the ACTUAL redemption-time verifier an operator's
    // response is checked against (mt#3209 review R1: don't just assert
    // APPROVAL_TOKEN.test() accepts a case-variant like "Approve"/"YES" —
    // confirm the real verifier does too).
    const acceptedTokens = ["approve", "approved", "yes", "Approve", "YES"];
    const rejectedTokens = ["ok", "sure", "affirmative", FIXTURE_APPROVE_LABEL];

    for (const value of [...acceptedTokens, ...rejectedTokens]) {
      const expectAccept = isApproveShapedToken(value);
      expect(APPROVAL_TOKEN.test(value)).toBe(expectAccept);

      // redemption-time path: simulates the inbox response shape (mt#3007)
      // an operator's selection would produce — {chosen, option} carrying
      // the SELECTED option's value.
      expect(isApprovingPayload({ chosen: value, option: value })).toBe(expectAccept);

      // create-time path (mt#3203)
      const createTimeCheck = () =>
        validateAuthorizationApproveOptions({
          kind: KIND_AUTHORIZATION_APPROVE,
          options: [{ label: "whatever label", value }],
        });

      // edit-time path (mt#3209) — fresh seeded ask per iteration
      const { repo, id } = await seedAsk(KIND_AUTHORIZATION_APPROVE);
      const editTimeCheck = () =>
        validateEditOptionsAgainstExistingAsk(repo, id, [{ label: "whatever label", value }]);

      if (expectAccept) {
        expect(createTimeCheck).not.toThrow();
        await expect(editTimeCheck()).resolves.toBeUndefined();
      } else {
        expect(createTimeCheck).toThrow(ValidationError);
        await expect(editTimeCheck()).rejects.toThrow(ValidationError);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// editRequiresApproveOptionsGuard — the wiring gate that keeps non-options
// edits unaffected, per the spec's third (equally load-bearing) success
// criterion.
// ---------------------------------------------------------------------------

describe("editRequiresApproveOptionsGuard (mt#3209)", () => {
  test("is false when the edit does not touch options at all", () => {
    expect(editRequiresApproveOptionsGuard({ title: "New title" })).toBe(false);
    expect(editRequiresApproveOptionsGuard({ question: "New question" })).toBe(false);
    expect(
      editRequiresApproveOptionsGuard({ contextRefs: [{ kind: "task", ref: "mt#3209" }] })
    ).toBe(false);
    expect(editRequiresApproveOptionsGuard({ metadata: { note: "x" } })).toBe(false);
    // Multiple non-options fields at once — still false.
    expect(
      editRequiresApproveOptionsGuard({
        title: "New title",
        question: "New question",
        metadata: { note: "x" },
      })
    ).toBe(false);
  });

  test("is true whenever options is part of the edit, including an explicit empty array", () => {
    expect(
      editRequiresApproveOptionsGuard({
        options: [{ label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL }],
      })
    ).toBe(true);
    expect(editRequiresApproveOptionsGuard({ options: [] })).toBe(true);
  });

  test("editing title/question/contextRefs/metadata on an authorization.approve Ask never reaches the guard, even when its existing options already lack an approve-shaped value", async () => {
    // Direct proof of the spec's third success criterion: seed an
    // authorization.approve Ask whose CURRENT options are already
    // unverifiable (pre-existing state from before this fix), then confirm
    // the gate says "skip the guard" for every non-options field — the
    // (persistence-touching) validateEditOptionsAgainstExistingAsk check is
    // never invoked, so this pre-existing state is never retroactively
    // enforced.
    const repo = new FakeAskRepository();
    const ask = await repo.create({
      kind: KIND_AUTHORIZATION_APPROVE,
      classifierVersion: "v1.0.0",
      requestor: FIXTURE_RESPONDER_ID,
      title: "Existing ask with unverifiable options",
      question: FIXTURE_QUESTION,
      options: [{ label: FIXTURE_APPROVE_LABEL, value: FIXTURE_APPROVE_LABEL }],
    });
    expect(ask.options?.[0]?.value).toBe(FIXTURE_APPROVE_LABEL); // pre-existing unverifiable state

    const editParams = [
      { title: "Refreshed title" },
      { question: "Refreshed question" },
      { contextRefs: [{ kind: "task", ref: "mt#3209" }] },
      { metadata: { refreshedFrom: "docs/research/x.md" } },
    ];
    for (const params of editParams) {
      expect(editRequiresApproveOptionsGuard(params)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// validateAsksEditParams — sanity check that the pre-existing gate is
// unaffected by this file's additions (imported here only to keep the
// import list honest about what this file actually exercises).
// ---------------------------------------------------------------------------

describe("validateAsksEditParams (regression sanity check)", () => {
  test("still passes for a plain options-only edit", () => {
    expect(() => validateAsksEditParams({ options: [{ label: "A", value: "a" }] })).not.toThrow();
  });
});
