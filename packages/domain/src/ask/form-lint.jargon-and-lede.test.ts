/**
 * The domain-jargon and meta-lede checks (mt#4516).
 *
 * Escalation-packaging form-family R4: ask#9864 was rewritten via `asks_edit`
 * with `/escalation-packaging` already in context, and shipped unreadable. Two
 * mechanisms ran and neither could see it — the word budget fired and was
 * satisfied by trimming, and `internal-tool-id` matches `mcp__` only, so the
 * vocabulary that actually reached the principal was invisible.
 *
 * The fixtures below are that ask's REAL bodies, verbatim from its own record:
 * `metadata.originalContent.question` (the body it was filed with) and the two
 * `editHistory` states. Using the real text rather than a synthetic string is
 * the point — a fixture written to match the pattern proves only that the
 * pattern matches itself.
 */
import { describe, test, expect } from "bun:test";
import {
  computeFormLintMatches,
  ASK_KIND_JARGON_PATTERN,
  META_LEDE_PATTERN,
  DATE_LEDE_PATTERN,
  firstSentenceOf,
} from "./form-lint";
import type { AskKind } from "./types";
import type { FormLintInput } from "./form-lint";

const CHECK_DOMAIN_JARGON = "domain-jargon";
const CHECK_META_LEDE = "meta-lede";

/** Options present so `missing-decision-options` cannot fire and muddy the assertions. */
function askWith(question: string): FormLintInput {
  return {
    kind: "direction.decide",
    question,
    options: [{ label: "Do the thing" }, { label: "Do the other thing" }],
  };
}

function checksFor(question: string): string[] {
  return computeFormLintMatches(askWith(question)).map((m) => m.check);
}

/**
 * ask#9864 as originally filed (2026-08-23). Carries two jargon classes —
 * ask-kind names and an ADR number — and opens with the question, so it is a
 * jargon hit and a meta-lede miss.
 *
 * Note `isSyncKind` appears here WITHOUT backticks, so the code-symbol pattern
 * correctly does not fire on it. That is a real property of the fixture, not an
 * oversight: the pattern keys on backticks precisely so bare prose words that
 * happen to be camelCase do not match.
 */
const ASK_9864_AS_FILED =
  'Your locked record classifies direction.decide as ASYNC ("Inbox primary") and stuck.unblock as "elicitation primary". The shipped code is the inverse on exactly those two: isSyncKind returns true for direction.decide ALONE, and false for stuck.unblock.\n\nNothing is blocked. What your answer decides is whether a future piece of work exists: teaching the shim to carry server-initiated requests (a GET/SSE stream plus request correlation, in a component ADR-038 keeps deliberately thin). Since mt#4450 merged, elicitation is unreachable on the local path regardless of kind.';

/**
 * ask#9864 after the first `asks_edit` — the rewrite the principal could not
 * read. This is the R4 body: it opens with a correction about the ask itself
 * AND still carries ask-kind names.
 */
const ASK_9864_FIRST_REWRITE =
  'Correction, 2026-08-24: this ask was filed on a misquote. Its original text is preserved in the record; the options below still hold.\n\nYour locked record\'s verdict for direction.decide reads, in full, "Inbox primary; elicitation if user is present." The earlier version quoted only the first clause and called the shipped code "the inverse." It isn\'t. What is real is narrower: stuck.unblock — which that same record calls "elicitation primary" — was never wired in, nor were three other kinds.';

/**
 * ask#9864 after the second rewrite — the readable one. The negative control:
 * same decision, same options, no jargon and no meta-lede.
 */
const ASK_9864_READABLE =
  'An agent can reach you two ways: a dialog in your Claude Code session that blocks it until you answer, or a row in your cockpit inbox it does not wait on.\n\nToday exactly one kind is wired for the dialog — architectural/preference choices — and it is the worst fit, since those take you hours or days. Your April design doc picked four different ones, led by "agent is stuck, needs fresh eyes" (seconds to minutes). Those were never built.';

describe("domain-jargon (mt#4516)", () => {
  test("fires on ask#9864 as filed, naming the classes it found", () => {
    const matches = computeFormLintMatches(askWith(ASK_9864_AS_FILED));
    const jargon = matches.find((m) => m.check === CHECK_DOMAIN_JARGON);

    expect(jargon).toBeDefined();
    expect(jargon?.message).toContain("ask-kind name");
    expect(jargon?.message).toContain("ADR/RFC number");
    // Bare `isSyncKind` is not backticked, so the code-symbol class must NOT fire.
    expect(jargon?.message).not.toContain("code symbol");
  });

  test("does NOT fire on the readable rewrite", () => {
    expect(checksFor(ASK_9864_READABLE)).not.toContain(CHECK_DOMAIN_JARGON);
  });

  test("fires on a backticked camelCase symbol", () => {
    expect(checksFor("Should `isSyncKind` keep its current behaviour?")).toContain(
      CHECK_DOMAIN_JARGON
    );
  });

  test("does NOT fire on a filename, a version, or a hostname", () => {
    // The three shapes a general dotted-identifier pattern would have caught.
    expect(checksFor("The change lands in form-lint.ts and nowhere else.")).not.toContain(
      CHECK_DOMAIN_JARGON
    );
    expect(checksFor("We would move to 1.2.3 in the same release.")).not.toContain(
      CHECK_DOMAIN_JARGON
    );
    expect(checksFor("The page lives at app.notion.com under your home.")).not.toContain(
      CHECK_DOMAIN_JARGON
    );
  });

  test("covers every AskKind — the enumeration cannot silently drift", () => {
    const allKinds: AskKind[] = [
      "capability.escalate",
      "information.retrieve",
      "authorization.approve",
      "direction.decide",
      "coordination.notify",
      "quality.review",
      "stuck.unblock",
    ];
    for (const kind of allKinds) {
      expect(ASK_KIND_JARGON_PATTERN.test(`the ${kind} path`)).toBe(true);
    }
  });
});

describe("meta-lede (mt#4516)", () => {
  test("fires on the rewrite that opened with a correction", () => {
    expect(checksFor(ASK_9864_FIRST_REWRITE)).toContain(CHECK_META_LEDE);
  });

  test("does NOT fire on the body it was filed with, which opens with the question", () => {
    expect(checksFor(ASK_9864_AS_FILED)).not.toContain(CHECK_META_LEDE);
  });

  test("does NOT fire on the readable rewrite", () => {
    expect(checksFor(ASK_9864_READABLE)).not.toContain(CHECK_META_LEDE);
  });

  test("is anchored to the opening — mid-body 'correction' is ordinary prose", () => {
    expect(
      checksFor("Should we ship the fix now, or wait? A correction: the deploy is already out.")
    ).not.toContain(CHECK_META_LEDE);
  });

  test("requires punctuation after the label, so 'Note that…' is not a lede", () => {
    expect(META_LEDE_PATTERN.test("Note that the deploy already went out.")).toBe(false);
    expect(META_LEDE_PATTERN.test("Note: the deploy already went out.")).toBe(true);
  });

  test("catches a bare date opening, the other common shape", () => {
    expect(DATE_LEDE_PATTERN.test("2026-08-24: reopening this after the merge.")).toBe(true);
    expect(DATE_LEDE_PATTERN.test("Should we reopen this after the merge?")).toBe(false);
  });

  test("catches a first sentence talking ABOUT the ask, with no label to key on", () => {
    expect(checksFor("This ask was filed on a misquote. Which option do you want?")).toContain(
      CHECK_META_LEDE
    );
  });

  test("does NOT fire when the ask refers to itself LATER in the body", () => {
    expect(
      checksFor(
        "Which transport should a stuck agent use to reach you? Answering this ask also settles the shim work."
      )
    ).not.toContain(CHECK_META_LEDE);
  });

  test("first-sentence window is capped, so an unpunctuated body cannot widen it", () => {
    const unpunctuated = `${"a".repeat(400)} this ask`;
    expect(firstSentenceOf(unpunctuated).length).toBe(200);
    expect(checksFor(unpunctuated)).not.toContain(CHECK_META_LEDE);
  });
});
