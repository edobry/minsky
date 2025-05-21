/**
 * Option Descriptions Tests
 * 
 * This file tests that option descriptions are consistent across interfaces.
 */

import { describe, test, expect } from "bun:test";
import * as descriptions from "../option-descriptions.js";

describe("Option Descriptions", () => {
  test("descriptions should be defined", () => {
    // Test that all exported descriptions are defined
    Object.entries(descriptions).forEach(([name, value]) => {
      expect(value).toBeDefined();
      expect(typeof value).toBe("string");
    });
  });

  test("descriptions should be non-empty", () => {
    // Test that all exported descriptions are non-empty
    Object.entries(descriptions).forEach(([name, value]) => {
      expect(value.length).toBeGreaterThan(0);
    });
  });

  test("descriptions should end with proper punctuation", () => {
    // Test that descriptions end with proper punctuation
    Object.entries(descriptions).forEach(([name, value]) => {
      // Descriptions should not end with a period (consistent with CLI conventions)
      expect(value.endsWith(".")).toBe(false);
    });
  });

  test("descriptions should be consistent with naming", () => {
    // Test that description constants follow naming convention
    Object.keys(descriptions).forEach((name) => {
      // Check that the name follows the pattern: ALL_CAPS_DESCRIPTION
      const regex = /^[A-Z_]+_DESCRIPTION$/;
      expect(regex.test(name)).toBe(true);
    });
  });
}); 
