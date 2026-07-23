/**
 * Tests for the shared changeset display-title helper (mt#3096).
 *
 * This helper backs BOTH the changesets list row and the changeset detail
 * header. The originating bug was those two drifting: the detail page rendered
 * a literal "(no title)" where the row it was reached from already fell back to
 * the task title, so drilling in made the title strictly worse.
 *
 * Lives under web/lib (not with the server-side session-detail mappers) because
 * web files cannot import a runtime value from that server module — see the
 * module doc on changeset-title.ts.
 */
import { describe, test, expect } from "bun:test";
import { changesetDisplayTitle } from "./changeset-title";

const bare = { title: null, headBranch: null, number: null };

describe("changesetDisplayTitle (mt#3096)", () => {
  test("prefers the PR title", () => {
    expect(
      changesetDisplayTitle({ ...bare, title: "real title" }, { taskTitle: "task", taskId: "mt#1" })
    ).toBe("real title");
  });

  test("falls back to the task title when the PR title is missing", () => {
    expect(changesetDisplayTitle(bare, { taskTitle: "task title", taskId: "mt#1" })).toBe(
      "task title"
    );
  });

  test("falls back to the task id when there is no task title", () => {
    expect(changesetDisplayTitle(bare, { taskTitle: null, taskId: "mt#3096" })).toBe("mt#3096");
  });

  test("falls back to the head branch when there is no session", () => {
    expect(changesetDisplayTitle({ ...bare, headBranch: "task/mt-3096" }, null)).toBe(
      "task/mt-3096"
    );
  });

  test("falls back to the PR number as a last resort", () => {
    expect(changesetDisplayTitle({ ...bare, number: 2222 }, null)).toBe("PR #2222");
  });

  /** A blank title is "missing", not a title — otherwise the header renders empty. */
  test("treats a blank/whitespace PR title as missing", () => {
    expect(
      changesetDisplayTitle({ ...bare, title: "   " }, { taskTitle: "task", taskId: null })
    ).toBe("task");
  });

  test("never returns an empty string", () => {
    expect(changesetDisplayTitle(bare, null)).toBe("Untitled changeset");
  });

  test("handles an undefined session the same as null", () => {
    expect(changesetDisplayTitle({ ...bare, headBranch: "b" }, undefined)).toBe("b");
  });
});
