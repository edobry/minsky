/**
 * `createAskWithFormLint` — external-reference linkification at the seam (mt#2918).
 *
 * Split out of `./asks.test.ts`, which sits at its 1500-line max-lines ceiling
 * (the same reason `./asks.form-lint-options.test.ts` exists).
 *
 * The transform's RULES are unit-tested in
 * `packages/domain/src/ask/external-refs.test.ts`. What this file covers is the
 * production wiring: that the transform runs on the path that actually
 * persists an ask, so a later reader of the stored body sees a URL rather than
 * a bare page id. That distinction is the whole defect — a correct transform
 * nothing calls would leave asks 827117cc and 755ddc6a exactly as they were.
 *
 * So these assertions read the row back OUT of the repository rather than
 * inspecting the return value.
 */
import { describe, expect, test } from "bun:test";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import {
  createAskWithFormLint,
  filterBlockingFormLintMatches,
  normalizeQuestionForLint,
  validateFormLintNotViolated,
} from "./asks";

const NONEXISTENT_WORKSPACE_ROOT = "/__nonexistent_test_dir_for_asks_create__";
const KIND_AUTHORIZATION_APPROVE = "authorization.approve" as const;

/** The RFC page id from ask 755ddc6a — the originating incident (mem#623 R2). */
const INCIDENT_ID = "3a0937f0-3cb4-81a6-8699-e419a5ce4da0";
const INCIDENT_URL = "https://app.notion.com/p/3a0937f03cb481a68699e419a5ce4da0";
const UNLINKIFIED = "unlinkified-reference";

describe("createAskWithFormLint — external references (mt#2918)", () => {
  test("a cued Notion page id is reachable in the PERSISTED question", async () => {
    const repo = new FakeAskRepository();

    const { ask, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Accept the RFC",
        question: `Accept the communication-altitude RFC (Notion ${INCIDENT_ID}) so Phase 1 can start.`,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    const persisted = await repo.getById(ask.id);
    expect(persisted?.question).toContain(INCIDENT_URL);
    // A reference the transform just resolved must not ALSO be reported as a
    // defect — the lint reads the persisted text, not the caller's input.
    expect(formLintMatches.map((m) => m.check)).not.toContain(UNLINKIFIED);
  });

  test("an unresolvable artifact reference warns and still creates the ask", async () => {
    const repo = new FakeAskRepository();

    const { ask, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: "Accept the RFC",
        question: "Accept the RFC (Notion 3a0937f0-3cb4) before the next window.",
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(formLintMatches.map((m) => m.check)).toContain(UNLINKIFIED);
    // Fail-open: the ask exists. Withholding a decision over a formatting gap
    // costs more than the gap does.
    expect(await repo.getById(ask.id)).not.toBeNull();
  });

  test("an ask with no external reference is persisted byte-identical", async () => {
    const repo = new FakeAskRepository();
    const question = "Approve the deploy to staging once CI is green.";

    const { ask, formLintMatches } = await createAskWithFormLint(
      repo,
      { kind: KIND_AUTHORIZATION_APPROVE, title: "Approve a deploy", question },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect((await repo.getById(ask.id))?.question).toBe(question);
    expect(formLintMatches.map((m) => m.check)).not.toContain(UNLINKIFIED);
  });

  // PR #2755 R1 — validate ran on the caller's raw text while execute
  // persisted the transformed text, so the hard-reject judged a body that
  // never existed. `portal-no-link` is the check that made it bite.
  test("a portal ask whose only link is a Notion citation is not falsely rejected", () => {
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_AUTHORIZATION_APPROVE,
        // Names a portal action ("grant") and carries no URL of its own — the
        // exact state of a body whose citation the transform is about to
        // resolve into one.
        question: `Grant the reviewer App the checks:write permission, per the RFC (Notion ${INCIDENT_ID}).`,
      })
    ).not.toThrow();
  });

  test("a portal ask with NO resolvable citation is still rejected", () => {
    // The negative control for the case above: the fix must not have turned
    // `portal-no-link` off, only taught it to read the persisted text.
    expect(() =>
      validateFormLintNotViolated({
        kind: KIND_AUTHORIZATION_APPROVE,
        question: "Grant the reviewer App the checks:write permission in the app settings.",
      })
    ).toThrow(/portal-no-link/);
  });

  test("the shared normalization seam is idempotent and leaves clean params untouched", () => {
    const withRef = { question: `See Notion ${INCIDENT_ID}.` };
    const once = normalizeQuestionForLint(withRef);
    expect(once.question).toContain(INCIDENT_URL);
    expect(normalizeQuestionForLint(once).question).toBe(once.question);

    // No reference to resolve → the SAME object back, not a copy, so the seam
    // is free on the overwhelmingly common path.
    const clean = { question: "Approve the deploy." };
    expect(normalizeQuestionForLint(clean)).toBe(clean);
  });

  test("the check is excluded from the hard-reject set, so it can never block a create", () => {
    const blocking = filterBlockingFormLintMatches([
      { check: UNLINKIFIED, message: "…" },
      { check: "over-word-budget", message: "…" },
    ]);
    expect(blocking.map((m) => m.check)).toEqual(["over-word-budget"]);
  });
});

/**
 * mt#4901 — the ask's own contextRefs are a resolution source.
 *
 * ask#10647 cited `Notion 34f937f0` in its body (8 hex — the malformed branch;
 * a valid id is 32) while carrying the full page URL in contextRefs. The
 * reference was reachable and the lint reported it unreachable.
 *
 * These assertions read the PERSISTED question, not the return value: the point
 * is that a downstream reader — the cockpit inbox, the CLI, a notification
 * payload — gets the URL. The warning falling silent is the consequence, not
 * the deliverable (mt#2918's stated goal, and why the fix is at the text rather
 * than at the check).
 */
describe("createAskWithFormLint — contextRefs as a resolution source (mt#4901)", () => {
  const PREFIX = "34f937f0";
  const FULL_URL = "https://app.notion.com/p/34f937f03cb48108a95bdf3813f5ca84";
  const TITLE = "Re-decide the ask-routing split";
  const BODY = `That record — Notion ${PREFIX}, locked by you 2026-04-26 — settles this.`;

  test("a short id prefix in the body resolves against a contextRefs URL", async () => {
    const repo = new FakeAskRepository();

    const { ask, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: TITLE,
        question: BODY,
        contextRefs: [
          { kind: "url", ref: FULL_URL, description: "The locked doc whose table settles this" },
        ],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect((await repo.getById(ask.id))?.question).toContain(FULL_URL);
    expect(formLintMatches.map((m) => m.check)).not.toContain(UNLINKIFIED);
  });

  test("negative control: the same body with NO contextRefs still warns", async () => {
    const repo = new FakeAskRepository();

    const { ask, formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: TITLE,
        question: BODY,
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect((await repo.getById(ask.id))?.question).not.toContain(FULL_URL);
    expect(formLintMatches.map((m) => m.check)).toContain(UNLINKIFIED);
  });

  test("a contextRef that is not a Notion URL is not a resolution source", async () => {
    const repo = new FakeAskRepository();

    const { formLintMatches } = await createAskWithFormLint(
      repo,
      {
        kind: KIND_AUTHORIZATION_APPROVE,
        title: TITLE,
        question: BODY,
        contextRefs: [{ kind: "task", ref: "mt#4656", description: "The re-bind task" }],
      },
      { workspaceRoot: NONEXISTENT_WORKSPACE_ROOT }
    );

    expect(formLintMatches.map((m) => m.check)).toContain(UNLINKIFIED);
  });
});
