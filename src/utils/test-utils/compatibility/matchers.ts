/**
 * Asymmetric Matchers Compatibility Layer
 *
 * This module provides Jest/Vitest compatible asymmetric matchers that work with Bun's test runner.
 * Asymmetric matchers allow for flexible assertions that match a broader range of values.
 */

import { log } from "../../logger";

/**
 * Interface for asymmetric matchers
 */
export interface AsymmetricMatcher {
  /**
   * Determines if the provided value matches the matcher's criteria
   */
  asymmetricMatch(other: unknown): boolean;

  /**
   * Returns a string representation of the matcher for error messages
   */
  toString(): string;

  /**
   * Returns a string representation when used with `JSON.stringify()`
   */
  toJSON(): string;
}

/**
 * Base class for all asymmetric matchers
 */
abstract class AsymmetricMatcherBase implements AsymmetricMatcher {
  private readonly matcherName: string;

  constructor(matcherName: string) {
    this.matcherName = matcherName;
  }

  abstract asymmetricMatch(other: unknown): boolean;

  toString(): string {
    return `${this.matcherName}`;
  }

  toJSON(): string {
    return `${this.matcherName}`;
  }
}

/**
 * Matcher that matches anything except null or undefined
 */
class AnythingMatcher extends AsymmetricMatcherBase {
  constructor() {
    super("Anything");
  }

  asymmetricMatch(other: unknown): boolean {
    return other !== null && other !== undefined;
  }
}

/**
 * Matcher that matches any instance of a given constructor
 */
class AnyMatcher extends AsymmetricMatcherBase {
  private readonly expectedType: unknown;

  constructor(expectedType: unknown) {
    super("Any");
    this.expectedType = expectedType;
  }

  asymmetricMatch(other: unknown): boolean {
    if (other === null || other === undefined) {
      return false;
    }

    // Handle primitive type matching with typeof
    if (this.expectedType === String) {
      return typeof other === "string";
    }
    if (this.expectedType === Number) {
      return typeof other === "number";
    }
    if (this.expectedType === Boolean) {
      return typeof other === "boolean";
    }
    if (this.expectedType === BigInt) {
      return typeof other === "bigint";
    }
    if (this.expectedType === Symbol) {
      return typeof other === "symbol";
    }
    if (this.expectedType === Function) {
      return typeof other === "function";
    }
    if (this.expectedType === Object) {
      return typeof other === "object" && other !== null;
    }

    // For Array, use Array.isArray
    if (this.expectedType === Array) {
      return Array.isArray(other);
    }

    // For all other constructors, use instanceof
    if (typeof this.expectedType === "function") {
      return other instanceof this.expectedType;
    }

    // As a fallback, use typeof for string type names
    return typeof other === this.expectedType;
  }

  toString(): string {
    return `Any<${this.expectedType?.name || this.expectedType}>`;
  }

  toJSON(): string {
    return `Any<${this.expectedType?.name || this.expectedType}>`;
  }
}

/**
 * Matcher that matches strings containing a specific substring
 */
class StringContainingMatcher extends AsymmetricMatcherBase {
  private readonly expectedSubstring: string;

  constructor(expectedSubstring: string) {
    super("StringContaining");
    this.expectedSubstring = expectedSubstring;
  }

  asymmetricMatch(other: unknown): boolean {
    if (typeof other !== "string") {
      return false;
    }

    return other.includes(this.expectedSubstring);
  }

  toString(): string {
    return `StringContaining(${this.expectedSubstring})`;
  }

  toJSON(): string {
    return `StringContaining(${this.expectedSubstring})`;
  }
}

/**
 * Matcher that matches strings against a regular expression
 */
class StringMatchingMatcher extends AsymmetricMatcherBase {
  private readonly expectedPattern: RegExp;

  constructor(expectedPattern: RegExp | string) {
    super("StringMatching");
    this.expectedPattern = new RegExp(expectedPattern);
  }

  asymmetricMatch(other: unknown): boolean {
    if (typeof other !== "string") {
      return false;
    }

    return this.expectedPattern.test(other);
  }

  toString(): string {
    return `StringMatching(${this.expectedPattern})`;
  }

  toJSON(): string {
    return `StringMatching(${this.expectedPattern})`;
  }
}

/**
 * Matcher that matches objects containing specific properties
 */
class ObjectContainingMatcher extends AsymmetricMatcherBase {
  private readonly expectedObject: Record<string, unknown>;

  constructor(expectedObject: Record<string, unknown>) {
    super("ObjectContaining");
    this.expectedObject = expectedObject;
  }

  asymmetricMatch(other: unknown): boolean {
    if (typeof other !== "object" || other === null) {
      return false;
    }

    const otherObject = other as Record<string, unknown>;

    for (const key in this.expectedObject) {
      if (!(key in otherObject)) {
        return false;
      }

      const expectedValue = this.expectedObject[key];
      const actualValue = otherObject[key];

      // Handle nested asymmetric matchers
      if (isAsymmetricMatcher(expectedValue)) {
        if (!expectedValue.asymmetricMatch(actualValue)) {
          return false;
        }
      } else if (!this.valuesAreEqual(expectedValue, actualValue)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks if two values are equal, handling object and array comparison
   */
  private valuesAreEqual(expected: unknown, actual: any): boolean {
    // If types don't match, they're not equal
    if (typeof expected !== typeof actual) {
      return false;
    }

    // Handle primitive values
    if (expected === actual) {
      return true;
    }

    // Handle null
    if (expected === null || actual === null) {
      return expected === actual;
    }

    // Handle dates
    if (expected instanceof Date && actual instanceof Date) {
      return expected.getTime() === actual.getTime();
    }

    // Handle arrays
    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) {
        return false;
      }

      for (let i = 0; i < expected.length; i++) {
        if (!this.valuesAreEqual(expected[i], actual[i])) {
          return false;
        }
      }

      return true;
    }

    // Handle regular objects
    if (typeof expected === "object" && typeof actual === "object") {
      const expectedKeys = Object.keys(expected);
      const actualKeys = Object.keys(actual);

      if (expectedKeys.length !== actualKeys.length) {
        return false;
      }

      for (const key of expectedKeys) {
        if (!actualKeys.includes(key)) {
          return false;
        }

        if (!this.valuesAreEqual(expected[key], actual[key])) {
          return false;
        }
      }

      return true;
    }

    // For all other cases, simple equality
    return expected === actual;
  }

  toString(): string {
    return `ObjectContaining(${JSON.stringify(this.expectedObject)})`;
  }

  toJSON(): string {
    return `ObjectContaining(${JSON.stringify(this.expectedObject)})`;
  }
}

/**
 * Matcher that matches arrays containing specific items
 */
class ArrayContainingMatcher extends AsymmetricMatcherBase {
  private readonly expectedItems: unknown[];

  constructor(expectedItems: unknown[]) {
    super("ArrayContaining");
    this.expectedItems = expectedItems;
  }

  asymmetricMatch(other: unknown): boolean {
    if (!Array.isArray(other)) {
      return false;
    }

    return this.expectedItems.every((expected) => {
      return other.some((actual) => {
        // Handle nested asymmetric matchers
        if (expected && typeof expected === "object" && "asymmetricMatch" in expected) {
          return (expected as AsymmetricMatcher).asymmetricMatch(actual);
        }

        return expected === actual;
      });
    });
  }

  toString(): string {
    return `ArrayContaining(${JSON.stringify(this.expectedItems)})`;
  }

  toJSON(): string {
    return `ArrayContaining(${JSON.stringify(this.expectedItems)})`;
  }
}

/**
 * Creates an object that provides factory methods for asymmetric matchers.
 * This matches the interface of Jest's expect object.
 */
export const asymmetricMatchers = {
  /**
   * Matches anything except null or undefined
   */
  anything(): AsymmetricMatcher {
    return new AnythingMatcher();
  },

  /**
   * Matches any value that is an instance of a specific constructor
   *
   * @param constructor The constructor to match instances of
   */
  any(constructor: unknown): AsymmetricMatcher {
    return new AnyMatcher(constructor);
  },

  /**
   * Matches any string that contains the specified substring
   *
   * @param substring The substring to search for
   */
  stringContaining(substring: string): AsymmetricMatcher {
    return new StringContainingMatcher(substring);
  },

  /**
   * Matches any string that matches the specified pattern
   *
   * @param pattern The regexp pattern to match
   */
  stringMatching(pattern: RegExp | string): AsymmetricMatcher {
    return new StringMatchingMatcher(pattern);
  },

  /**
   * Matches any object that contains all of the specified properties
   *
   * @param obj The object with properties to match
   */
  objectContaining(obj: Record<string, unknown>): AsymmetricMatcher {
    return new ObjectContainingMatcher(obj);
  },

  /**
   * Matches any array that contains all of the specified items
   *
   * @param items The items that should exist in the array
   */
  arrayContaining(items: unknown[]): AsymmetricMatcher {
    return new ArrayContainingMatcher(items);
  },
};

/**
 * Registers the asymmetric matchers with Bun's expect
 *
 * @param expectObj The expect object to enhance
 */
export function registerAsymmetricMatchers(expectObj: unknown): void {
  // Add each matcher to the expect object
  for (const [key, value] of Object.entries(asymmetricMatchers)) {
    if (!(key in (expectObj))) {
      expectObj[key] = value;
    }
  }
}

/**
 * Check if an object is an asymmetric matcher
 */
export function isAsymmetricMatcher(obj: unknown): obj is AsymmetricMatcher {
  return obj !== null && typeof obj === "object" && typeof obj.asymmetricMatch === "function";
}

// Export a function to extend the global expect with asymmetric matchers
export function setupAsymmetricMatchers(): void {
  try {
    const bun = require("bun:test");

    // Add matchers to expect
    registerAsymmetricMatchers(bun.expect);

    // Override the equality comparison for assertions
    const originalEquals = bun.expect.equals;
    if (originalEquals) {
      // Save original
      const originalEqualsFn = originalEquals;

      // Override with matcher-aware version
      bun.expect.equals = (a: unknown, b: any): boolean => {
        // Check if either value is an asymmetric matcher
        if (isAsymmetricMatcher(a)) {
          return a.asymmetricMatch(b);
        }
        if (isAsymmetricMatcher(b)) {
          return b.asymmetricMatch(a);
        }

        // Fall back to the original equality check
        return originalEqualsFn(a, b);
      };
    } else {
      // If no equals method was found, just log a warning
      console.warn("Could not find expect.equals method to override for matcher support.");
    }
  } catch (error) {
    // Fail gracefully if bun:test is not available
    console.warn("Failed to set up asymmetric matchers:", error);
  }
}
