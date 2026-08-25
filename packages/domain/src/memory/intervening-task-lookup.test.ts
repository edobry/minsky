/**
 * Tests for the intervening-task lookup's pure parts (mt#4452).
 *
 * The point of interest is the `LIKE` pattern: every subsystem token this receives is a
 * snake_case identifier or a dotted path, i.e. dense in `LIKE` metacharacters. PR #3271 R1
 * caught them going through unescaped.
 *
 * Asserted against `escapeLikePattern` directly rather than through a fake `db` capturing
 * drizzle's assembled SQL. A first attempt did the latter and captured nothing, because it was
 * guessing at drizzle's internal node shape — the test would have been asserting on my model of
 * a third-party structure rather than on the escaping. The escaping is the part that can be
 * wrong; SQL assembly is drizzle's job and has its own tests.
 */

import { describe, expect, test } from "bun:test";
import { escapeLikePattern } from "./intervening-task-lookup";
import { COMPLETED_TASK_STATUSES } from "./staleness";

describe("escapeLikePattern", () => {
  test("escapes underscores, which are single-character wildcards in LIKE", () => {
    // Unescaped, `agent_transcript_turns` matches `agent<any>transcript<any>turns`. The tokens
    // fed here are snake_case by construction, so this is systematic, not occasional.
    expect(escapeLikePattern("agent_transcript_turns")).toBe("agent\\_transcript\\_turns");
  });

  test("escapes percent signs, which are multi-character wildcards", () => {
    expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
  });

  test("escapes the escape character itself, so it cannot smuggle an escape in", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  test("leaves a dotted path untouched — no metacharacters in it", () => {
    expect(escapeLikePattern("turn-writer.ts")).toBe("turn-writer.ts");
  });

  test("is a no-op on a token with nothing to escape", () => {
    expect(escapeLikePattern("cockpit")).toBe("cockpit");
  });

  test("handles a token that is only metacharacters", () => {
    expect(escapeLikePattern("%_\\")).toBe("\\%\\_\\\\");
  });
});

describe("completed-status source of truth", () => {
  test("is shared rather than copied per module", () => {
    // The divergence risk PR #3271 R1 flagged: two hand-maintained copies of "landed".
    expect([...COMPLETED_TASK_STATUSES]).toEqual(["DONE", "CLOSED"]);
  });
});
