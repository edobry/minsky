/**
 * Tests for custom assertion helpers
 */
import { describe, test, expect } from "bun:test";
import {
  expectToMatch,
  expectToHaveLength,
  expectToBeInstanceOf,
  expectToHaveProperty,
  expectToBeCloseTo,
  expectToContainEqual,
} from "../assertions.js";

describe("Custom Assertion Helpers", () => {
  describe("expectToMatch", () => {
    test("should match a string against a regex pattern", () => {
      // Should succeed
      expectToMatch("hello world", /world/);

      // Should fail
      let failed = false;
      try {
        expectToMatch("hello world", /universe/);
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });

  describe("expectToHaveLength", () => {
    test("should verify array length", () => {
      // Should succeed
      expectToHaveLength([1, 2, 3], 3);

      // Should fail
      let failed = false;
      try {
        expectToHaveLength([1, 2, 3], 4);
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });

    test("should verify string length", () => {
      // Should succeed
      expectToHaveLength("hello", 5);

      // Should fail
      let failed = false;
      try {
        expectToHaveLength("hello", 6);
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });

  describe("expectToBeInstanceOf", () => {
    test("should verify object instanceof", () => {
      // Should succeed
      expectToBeInstanceOf(new Date(), Date);

      // Should fail
      let failed = false;
      try {
        expectToBeInstanceOf("not a date", Date);
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });

  describe("expectToHaveProperty", () => {
    test("should verify object has property", () => {
      const obj = {
        name: "test",
        nested: {
          value: 42,
        },
      };

      // Should succeed
      expectToHaveProperty(obj, "name");
      expectToHaveProperty(obj, "nested.value");
      expectToHaveProperty(obj, "name", "test");
      expectToHaveProperty(obj, "nested.value", 42);

      // Should fail - property doesn't exist
      let failed = false;
      try {
        expectToHaveProperty(obj, "missing");
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();

      // Should fail - wrong value
      failed = false;
      try {
        expectToHaveProperty(obj, "name", "wrong");
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });

  describe("expectToBeCloseTo", () => {
    test("should compare floating point numbers with precision", () => {
      // Should succeed
      expectToBeCloseTo(0.1 + 0.2, 0.3, 5);

      // Should fail
      let failed = false;
      try {
        expectToBeCloseTo(0.1, 0.2, 5);
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });

  describe("expectToContainEqual", () => {
    test("should check if array contains an item with deep equality", () => {
      const arr = [
        { id: 1, name: "test1" },
        { id: 2, name: "test2" },
      ];

      // Should succeed
      expectToContainEqual(arr, { id: 1, name: "test1" });

      // Should fail
      let failed = false;
      try {
        expectToContainEqual(arr, { id: 3, name: "test3" });
      } catch (error) {
        failed = true;
      }
      expect(failed).toBeTruthy();
    });
  });
});
