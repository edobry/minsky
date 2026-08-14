/**
 * The option-exception check (mt#4148).
 *
 * Escalation-packaging R7: an ask can pass every routing, form and
 * options-presence mechanism and still authorize the wrong change, because its
 * option's exemption set was written from the case in hand rather than derived
 * from the system's structure. No matcher can decide whether an exemption set
 * is complete — these tests pin what the matcher CAN see (that an exception was
 * written at all) and, just as importantly, what it must NOT fire on.
 */
import { describe, test, expect } from "bun:test";
import { computeFormLintMatches, OPTION_EXCEPTION_WORD_PATTERN } from "./form-lint";
import type { FormLintInput } from "./form-lint";

/** The check under test, named once — matches the `CHECK_*` idiom in `form-lint.test.ts`. */
const CHECK_UNSCOPED_OPTION_EXCEPTION = "unscoped-option-exception";

/** A decision ask with real options, so only the check under test can fire. */
function decideWith(labels: string[]): FormLintInput {
  return {
    kind: "direction.decide",
    question: "Should clicking outside a cockpit peek pane close it?",
    options: labels.map((label) => ({ label })),
  };
}

function checksFor(input: FormLintInput): string[] {
  return computeFormLintMatches(input).map((m) => m.check);
}

describe("OPTION_EXCEPTION_WORD_PATTERN", () => {
  test("matches the exception words, word-bounded", () => {
    for (const word of ["except", "unless", "other than", "apart from"]) {
      expect(OPTION_EXCEPTION_WORD_PATTERN.test(`close it ${word} something`)).toBe(true);
    }
  });

  test("the warning text names exactly the words the pattern matches", () => {
    // PR #3003 R1 BLOCKING #2: the message advertised "except"/"only"/"unless"
    // after `only` had been dropped and while `other than`/`apart from` were
    // never listed — an author reading it would have believed `only` was
    // covered. Doc-code drift inside a single expression, which no type or
    // test caught until the reviewer read both halves. This pins them together.
    const message =
      computeFormLintMatches(decideWith(["Close it except on an entity ref"])).find(
        (m) => m.check === CHECK_UNSCOPED_OPTION_EXCEPTION
      )?.message ?? "";
    for (const word of ["except", "unless", "other than", "apart from"]) {
      expect(message).toContain(`"${word}"`);
    }
    expect(message).not.toContain('"only"');
  });

  test("does NOT match `only` — the word the narrowing removed", () => {
    // Regression pin for the false positive that shaped this pattern. `only`
    // was in the first draft, and `\bonly\b` matches inside `read-only`
    // because a hyphen is a word boundary — which broke mt#3477's
    // repaired-shape replay ("Alias now, read-only until mt#3325", asserted
    // clean). Re-adding `only` must fail here rather than over there.
    expect(OPTION_EXCEPTION_WORD_PATTERN.test("alias now, read-only until mt#3325")).toBe(false);
    expect(OPTION_EXCEPTION_WORD_PATTERN.test("exempting only the entity ref")).toBe(false);
  });
});

describe("AT1 — ask#8509's recommended option fires; its sibling does not", () => {
  // Verbatim from ask#8509 (6775fa88), the originating incident.
  const RECOMMENDED = "Close on outside click, except on an entity ref";
  const CONTROL = "Keep current behavior";

  test("the recommended option fires the check", () => {
    expect(checksFor(decideWith([RECOMMENDED]))).toContain(CHECK_UNSCOPED_OPTION_EXCEPTION);
  });

  test("the control option does NOT fire — this is what makes the check discriminating", () => {
    // Without this half the check could be firing on every option and the AT1
    // result above would carry no information (mem#704).
    expect(checksFor(decideWith([CONTROL]))).not.toContain(CHECK_UNSCOPED_OPTION_EXCEPTION);
  });

  test("the real three-option array fires exactly once, counting one label", () => {
    const matches = computeFormLintMatches(
      decideWith([RECOMMENDED, CONTROL, "Close on outside click everywhere, drop the hold gesture"])
    );
    const fired = matches.filter((m) => m.check === CHECK_UNSCOPED_OPTION_EXCEPTION);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.message).toContain("1 option label(s)");
  });
});

describe("AT2 — the check reads labels, and reads them case-insensitively", () => {
  test("an uppercased exception word still fires", () => {
    expect(checksFor(decideWith(["Close it EXCEPT on an entity ref"]))).toContain(
      CHECK_UNSCOPED_OPTION_EXCEPTION
    );
  });

  test("multiple carve-out labels are counted, not reported one warning each", () => {
    const matches = computeFormLintMatches(
      decideWith(["Close except on a pane", "Dismiss unless held"])
    );
    const fired = matches.filter((m) => m.check === CHECK_UNSCOPED_OPTION_EXCEPTION);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.message).toContain("2 option label(s)");
  });

  test("an exception word in the QUESTION body alone does not fire", () => {
    // Scoped to labels deliberately: a question narrating "the pane closes only
    // via Esc" is describing current behavior, not authorizing a carve-out.
    // Firing there would be the mem#719 noise failure.
    const matches = computeFormLintMatches({
      kind: "direction.decide",
      question: "Today a pane closes only via Esc, the close button, or Back.",
      options: [{ label: "Close it" }, { label: "Leave it" }],
    });
    expect(matches.map((m) => m.check)).not.toContain(CHECK_UNSCOPED_OPTION_EXCEPTION);
  });
});

describe("AT2 (cont.) — no interference with the checks that already existed", () => {
  test("an optionless ask is untouched by this check", () => {
    const matches = computeFormLintMatches({
      kind: "authorization.approve",
      question: "Approve deploying the current main to staging.",
    });
    expect(matches.map((m) => m.check)).not.toContain(CHECK_UNSCOPED_OPTION_EXCEPTION);
  });

  test("a clean decision ask produces no warnings at all", () => {
    expect(checksFor(decideWith(["Close it", "Leave it"]))).toEqual([]);
  });
});
