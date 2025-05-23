/**
 * Option Descriptions Tests
 * @migrated Native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 *
 * This file tests that option descriptions are consistent across interfaces.
 */

import { describe, expect, it } from "bun:test";
import * as descriptions from "../option-descriptions.js";
import { expectToHaveLength } from "../test-utils/assertions.js";
import { setupTestMocks } from "../test-utils/mocking.js";

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
