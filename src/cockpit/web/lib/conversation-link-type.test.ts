/**
 * mt#3691 AT5 — `link_type` presentation.
 *
 * Pins the exact rendered string for each of the five live writer classes, so
 * the "format the term, do not substitute words for it" constraint (ask#6947)
 * is enforced by the suite rather than by a comment: a change to
 * "Working-directory match" or "Spawned by orchestrator" fails here, which is
 * the moment to go read mt#3695 instead of coining vocabulary.
 */
import { describe, expect, test } from "bun:test";

import { formatLinkType } from "./conversation-link-type";

describe("formatLinkType", () => {
  test("formats each live writer class", () => {
    expect(formatLinkType("session_creator")).toBe("Session creator");
    expect(formatLinkType("subagent_spawn")).toBe("Subagent spawn");
    expect(formatLinkType("pr_author")).toBe("PR author");
    expect(formatLinkType("driven_spawn")).toBe("Driven spawn");
    expect(formatLinkType("cwd_match")).toBe("CWD match");
  });

  test("formats a value it has never seen rather than blanking it", () => {
    // The column is plain `text`; a sixth writer class must not render empty
    // just because it postdates this module.
    expect(formatLinkType("merge_hook")).toBe("Merge hook");
    expect(formatLinkType("declared")).toBe("Declared");
    expect(formatLinkType("some_future_writer")).toBe("Some future writer");
  });

  test("normalizes casing rather than trusting the stored casing", () => {
    expect(formatLinkType("SESSION_CREATOR")).toBe("Session creator");
    expect(formatLinkType("Cwd_Match")).toBe("CWD match");
  });

  test("returns degenerate input unchanged instead of inventing a placeholder", () => {
    expect(formatLinkType("")).toBe("");
    expect(formatLinkType("__")).toBe("__");
  });
});
