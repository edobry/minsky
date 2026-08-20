/**
 * Tests for the user-line provenance predicate (mt#4289).
 *
 * Every fixture below is a REAL shape read off `~/.claude/projects/**` on
 * 2026-08-19, not an invented one — the whole point of the predicate is that it
 * matches what Claude Code actually writes, and a fixture we made up would test
 * our belief about the harness rather than the harness.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyUserLineOrigin,
  isOperatorAuthored,
  COMPACT_SUMMARY_ORIGIN,
  HARNESS_META_ORIGIN,
  OPERATOR_ORIGIN,
} from "./user-line-origin";

/**
 * The auto-compaction boundary record, key-for-key as observed. Note what is
 * ABSENT: no `isMeta`, and no `origin`/`promptSource` — this record predates
 * neither, it simply does not carry them, which is why it needs its own check.
 */
const compactSummaryLine = {
  parentUuid: "0b3ec032-f3f9-4cdb-a68f-00d04a5332a6",
  isSidechain: false,
  promptId: "08e43edb-fc67-467e-b03e-d366c5c119f8",
  type: "user",
  message: { role: "user", content: "This session is being continued from a previous…" },
  isVisibleInTranscriptOnly: true,
  isCompactSummary: true,
  uuid: "2f08747c-ca4e-4cfc-8192-10d6566f0b57",
  timestamp: "2026-07-25T23:12:40.943Z",
  userType: "external",
  entrypoint: "cli",
  version: "2.1.219",
};

/** A typed operator prompt. */
const operatorLine = {
  type: "user",
  message: { role: "user", content: "Proceed." },
  origin: { kind: "human" },
  promptSource: "typed",
};

/** A background-task notification the harness injects as a user-role line. */
const taskNotificationLine = {
  type: "user",
  message: { role: "user", content: "<task-notification>\n<task-id>…" },
  origin: { kind: "task-notification" },
  promptSource: "system",
};

/** A Skill-tool invocation body — `isMeta`, array content. */
const skillBodyLine = {
  type: "user",
  isMeta: true,
  message: {
    role: "user",
    content: [{ type: "text", text: "Base directory for this skill: /Users/x/.claude/skills/foo" }],
  },
};

describe("classifyUserLineOrigin", () => {
  test("a compact-summary record is compact_summary", () => {
    expect(classifyUserLineOrigin(compactSummaryLine)).toBe(COMPACT_SUMMARY_ORIGIN);
  });

  test("an isMeta line is harness_meta", () => {
    expect(classifyUserLineOrigin(skillBodyLine)).toBe(HARNESS_META_ORIGIN);
  });

  test("a typed operator prompt is human", () => {
    expect(classifyUserLineOrigin(operatorLine)).toBe(OPERATOR_ORIGIN);
  });

  test("a queued operator prompt is human — queueing is delivery, not authorship", () => {
    expect(classifyUserLineOrigin({ type: "user", promptSource: "queued" })).toBe(OPERATOR_ORIGIN);
  });

  test("origin.kind is normalized to the column's underscore convention", () => {
    expect(classifyUserLineOrigin(taskNotificationLine)).toBe("task_notification");
  });

  test("promptSource classifies a line carrying no origin", () => {
    expect(classifyUserLineOrigin({ type: "user", promptSource: "sdk" })).toBe("sdk");
  });

  test("an unrecognized origin.kind survives verbatim rather than collapsing to human", () => {
    // The vocabulary is partly the HARNESS's. A kind we have never seen must be
    // visible in a `GROUP BY user_origin`, which is how the next one gets found.
    expect(classifyUserLineOrigin({ type: "user", origin: { kind: "some-future-kind" } })).toBe(
      "some_future_kind"
    );
  });
});

describe("classifyUserLineOrigin — precedence", () => {
  test("isCompactSummary wins over isMeta when both are set", () => {
    expect(classifyUserLineOrigin({ ...compactSummaryLine, isMeta: true })).toBe(
      COMPACT_SUMMARY_ORIGIN
    );
  });

  test("isMeta wins over origin.kind: the harness's own not-the-human bit is stronger", () => {
    expect(classifyUserLineOrigin({ ...skillBodyLine, origin: { kind: "human" } })).toBe(
      HARNESS_META_ORIGIN
    );
  });

  test("origin.kind human wins over a non-operator promptSource", () => {
    // The WRITER is a stronger statement than the delivery channel.
    expect(
      classifyUserLineOrigin({ type: "user", origin: { kind: "human" }, promptSource: "system" })
    ).toBe(OPERATOR_ORIGIN);
  });
});

describe("classifyUserLineOrigin — fail-open", () => {
  test("a line carrying no markers at all is human", () => {
    // Pre-`origin` history is the real population here: mis-marking operator
    // speech as synthetic REMOVES signal, while leaving a synthetic line marked
    // operator only reproduces the pre-mt#4289 behavior.
    expect(classifyUserLineOrigin({ type: "user", message: { role: "user", content: "hi" } })).toBe(
      OPERATOR_ORIGIN
    );
  });

  test("a malformed origin (not an object, or no kind) does not throw", () => {
    expect(classifyUserLineOrigin({ type: "user", origin: "task-notification" })).toBe(
      OPERATOR_ORIGIN
    );
    expect(classifyUserLineOrigin({ type: "user", origin: {} })).toBe(OPERATOR_ORIGIN);
    expect(classifyUserLineOrigin({ type: "user", origin: { kind: "   " } })).toBe(OPERATOR_ORIGIN);
  });

  test("a non-object input does not throw", () => {
    expect(classifyUserLineOrigin(null)).toBe(OPERATOR_ORIGIN);
    expect(classifyUserLineOrigin(undefined)).toBe(OPERATOR_ORIGIN);
    expect(classifyUserLineOrigin("a string")).toBe(OPERATOR_ORIGIN);
  });

  test("a non-boolean isCompactSummary is not coerced", () => {
    // Mirrors session-context-snapshot.test.ts's guard on the same field: the
    // marker is a strict `=== true`, so a truthy string must not classify.
    expect(classifyUserLineOrigin({ type: "user", isCompactSummary: "yes" })).toBe(OPERATOR_ORIGIN);
  });
});

describe("isOperatorAuthored", () => {
  test("true only for genuine operator speech", () => {
    expect(isOperatorAuthored(operatorLine)).toBe(true);
    expect(isOperatorAuthored(compactSummaryLine)).toBe(false);
    expect(isOperatorAuthored(skillBodyLine)).toBe(false);
    expect(isOperatorAuthored(taskNotificationLine)).toBe(false);
  });

  test("an unknown harness kind is NOT operator-authored", () => {
    // The two defaults point the same way: an UNMARKED line reads as operator,
    // but an explicitly-marked non-human kind demotes it even if we have never
    // seen that kind before.
    expect(isOperatorAuthored({ type: "user", origin: { kind: "some-future-kind" } })).toBe(false);
  });
});

describe("the text prefixes used to SIZE this problem are not the predicate", () => {
  // mt#4289 measured 8,245 synthetic rows with `user_text LIKE` prefixes,
  // because the turns table carried no provenance. This is the negative control
  // for that measurement leaking into the implementation: an operator who
  // PASTES one of those prefixes is still the operator.
  test("an operator prompt whose text opens with a skill-body prefix is human", () => {
    expect(
      classifyUserLineOrigin({
        type: "user",
        origin: { kind: "human" },
        promptSource: "typed",
        message: {
          role: "user",
          content: "Base directory for this skill: /x — why does this line show up as a turn?",
        },
      })
    ).toBe(OPERATOR_ORIGIN);
  });

  test("an operator prompt quoting a task-notification is human", () => {
    expect(
      classifyUserLineOrigin({
        type: "user",
        origin: { kind: "human" },
        promptSource: "typed",
        message: { role: "user", content: "<task-notification> — what emits these?" },
      })
    ).toBe(OPERATOR_ORIGIN);
  });
});
