/**
 * Option Descriptions Tests
 * @migrated Native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 *
 * This file tests that option descriptions are consistent across interfaces.
 */
import { describe, expect, it } from "bun:test";
import * as descriptions from "./option-descriptions";
import { RULE_FORMAT_VALUES, type RuleFormat } from "@minsky/domain/rules/types";
import completionManifest from "../generated/completion-manifest.json";
import { setupTestMocks } from "./test-utils/mocking";
// Set up automatic mock cleanup
setupTestMocks();

describe("Option Descriptions", () => {
  it("all exported descriptions should be non-empty strings", () => {
    // Get all exported values
    const allDescriptions = Object.values(descriptions);
    expect(allDescriptions.length).toBeGreaterThan(0);

    // Check each one is a non-empty string
    for (const desc of allDescriptions) {
      expect(typeof desc).toBe("string");
      expect((desc as string).length).toBeGreaterThan(0);
    }
  });

  it("all descriptions should follow consistent naming pattern (UPPERCASE_WITH_DESCRIPTION suffix)", () => {
    // Get all exported keys
    const allKeys = Object.keys(descriptions);

    // Check each key follows the pattern
    for (const key of allKeys) {
      // Check pattern ends with _DESCRIPTION
      const endsWithDescription = key.endsWith("_DESCRIPTION");
      expect(endsWithDescription).toBe(true);

      // Check the key is uppercase
      expect(key).toBe(key.toUpperCase());
    }
  });

  it("all descriptions should end with proper punctuation", () => {
    // Get all exported values
    const allDescriptions = Object.values(descriptions) as string[];

    // Check each description ends with a period, question mark, or no punctuation
    // Some descriptions are phrases/fragments and don't need periods
    for (const desc of allDescriptions) {
      const hasProperPunctuation =
        desc.endsWith(".") ||
        desc.endsWith("?") ||
        desc.endsWith(")") ||
        desc.endsWith("}") ||
        /[a-zA-Z0-9)]$/.test(desc); // Ends with alphanumeric or closing parenthesis

      expect(hasProperPunctuation).toBeTruthy();
    }
  });

  it("repository resolution descriptions should be consistent", () => {
    expect(descriptions.SESSION_DESCRIPTION).toBeTruthy();
    expect(descriptions.REPO_DESCRIPTION).toBeTruthy();
    expect(descriptions.UPSTREAM_REPO_DESCRIPTION).toBeTruthy();
  });

  it("output format descriptions should be consistent", () => {
    expect(descriptions.JSON_DESCRIPTION).toBeTruthy();
    expect(descriptions.DEBUG_DESCRIPTION).toBeTruthy();
  });

  it("task descriptions should be consistent", () => {
    expect(descriptions.TASK_ID_DESCRIPTION).toBeTruthy();
    expect(descriptions.TASK_STATUS_FILTER_DESCRIPTION).toBeTruthy();
    expect(descriptions.TASK_STATUS_DESCRIPTION).toBeTruthy();
    expect(descriptions.TASK_ALL_DESCRIPTION).toBeTruthy();
  });

  it("backend descriptions should be consistent", () => {
    expect(descriptions.BACKEND_DESCRIPTION).toBeTruthy();
    expect(descriptions.TASK_BACKEND_DESCRIPTION).toBeTruthy();
  });

  it("force option descriptions should be consistent", () => {
    expect(descriptions.FORCE_DESCRIPTION).toBeTruthy();
    expect(descriptions.OVERWRITE_DESCRIPTION).toBeTruthy();
  });

  it("git option descriptions should be consistent", () => {
    expect(descriptions.GIT_REMOTE_DESCRIPTION).toBeTruthy();
    expect(descriptions.GIT_BRANCH_DESCRIPTION).toBeTruthy();
    expect(descriptions.GIT_FORCE_DESCRIPTION).toBeTruthy();
    expect(descriptions.NO_STATUS_UPDATE_DESCRIPTION).toBeTruthy();
  });

  it("rules option descriptions should be consistent", () => {
    expect(descriptions.RULE_CONTENT_DESCRIPTION).toBeTruthy();
    expect(descriptions.RULE_DESCRIPTION_DESCRIPTION).toBeTruthy();
    expect(descriptions.RULE_NAME_DESCRIPTION).toBeTruthy();
    expect(descriptions.RULE_FORMAT_DESCRIPTION).toBeTruthy();
    expect(descriptions.RULE_TAGS_DESCRIPTION).toBeTruthy();
  });
});

/**
 * mt#4741 — the advertised value set of `--rule-format` must equal the accepted
 * set. `minsky` was added to `RuleFormat` on 2026-04-01 (mt#588) and every help
 * string went on saying "cursor or generic" for five months, because a
 * hand-written description is coupled to nothing.
 */
describe("--rule-format advertises exactly the accepted RuleFormat values", () => {
  it("advertises every accepted format", () => {
    for (const format of RULE_FORMAT_VALUES) {
      expect(descriptions.RULE_FORMAT_DESCRIPTION).toContain(format);
    }
  });

  it("derives the advertised set from the type rather than restating it", () => {
    // A `Record<RuleFormat, true>` rather than a plain array on purpose: adding a
    // member to `RuleFormat` makes THIS LINE a compile error, so the expectation
    // cannot silently drift out of step with the union the way a hand-written
    // list can — which is the exact failure this test exists to catch.
    const everyFormat: Record<RuleFormat, true> = { cursor: true, generic: true, minsky: true };
    const expected = Object.keys(everyFormat) as RuleFormat[];
    expect([...RULE_FORMAT_VALUES].sort()).toEqual(expected.sort());
  });

  it("no longer carries the stale two-value phrasing", () => {
    expect(descriptions.RULE_FORMAT_DESCRIPTION).not.toContain("cursor or generic");
  });

  it("does not leave the stale phrasing in the committed completion manifest", () => {
    // The manifest is generated from these descriptions; a stale string here means
    // it was not regenerated after the source changed.
    //
    // Asserted as a BOOLEAN, not via `expect(json).not.toContain(...)`: the manifest
    // serializes to ~300KB, and a failing `toContain` prints the whole thing as its
    // diff, which buries the result it is meant to report. Observed while running
    // this file's own negative control.
    const manifestCarriesStalePhrase =
      JSON.stringify(completionManifest).includes("cursor or generic");
    expect(manifestCarriesStalePhrase).toBe(false);
  });
});
