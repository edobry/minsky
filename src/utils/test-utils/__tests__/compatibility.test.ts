/**
 * Compatibility Layer Tests
 * @migrated Native Bun patterns
 * @refactored Uses project utilities where appropriate
 *
 * Tests for the Jest/Vitest compatibility layer for Bun.
 */
import { describe, test, expect as bunExpect } from "bun:test";
import { compat } from "../index.js";
import { setupTestMocks } from "../mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Set up the compatibility layer for testing
compat.setupTestCompat();

// Use a typed expect to make TypeScript happy with the enhanced matchers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expect = bunExpect as any;

describe("Mock Function Compatibility", () => {
  test("creates working mock functions", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Call the mock function
    mockFn("test", 123);

    // Verify tracking works
    expect(mockFn.mock.calls.length).toBe(1);
    // Use type assertion to silence TypeScript
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const args = mockFn.mock.calls[0]!;
    expect(args[0]).toBe("test");
    expect(args[1]).toBe(123);
  });

  test("mockClear clears tracking data", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Call the mock function
    mockFn();

    // Clear tracking data
    mockFn.mockClear();

    // Verify tracking is cleared
    expect(mockFn.mock.calls.length).toBe(0);
  });

  test("mockReset clears implementation and tracking data", () => {
    // Create a mock function with implementation
    const mockFn = compat.createCompatMock(() => "original");

    // Call the mock function
    const result1 = mockFn();

    // Reset the mock
    mockFn.mockReset();

    // Verify tracking and implementation are reset
    expect(mockFn.mock.calls.length).toBe(0);
    expect(mockFn()).toBeUndefined();
  });

  test("mockImplementation changes function implementation", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Implement the function
    mockFn.mockImplementation(() => "mocked");

    // Verify implementation is used
    expect(mockFn()).toBe("mocked");
  });

  test("mockReturnValue sets a return value", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Set a return value
    mockFn.mockReturnValue("value");

    // Verify return value is used
    expect(mockFn()).toBe("value");
  });

  test("mockImplementationOnce sets a one-time implementation", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock(() => "default");

    // Set a one-time implementation
    mockFn.mockImplementationOnce(() => "once");

    // Verify one-time implementation is used
    expect(mockFn()).toBe("once");
    expect(mockFn()).toBe("default");
  });

  test("mockReturnValueOnce sets a one-time return value", () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Set a one-time return value
    mockFn.mockReturnValueOnce("once");

    // Verify one-time return value is used
    expect(mockFn()).toBe("once");
    expect(mockFn()).toBeUndefined();
  });

  test("supports promise-related utilities", async () => {
    // Create a mock function
    const mockFn = compat.createCompatMock();

    // Set resolved value
    mockFn.mockResolvedValue("resolved");

    // Verify resolved value by directly calling the function
    const result = await mockFn();
    expect(result).toBe("resolved");

    // Create another mock for rejection testing
    const mockFn2 = compat.createCompatMock();
    mockFn2.mockRejectedValue(new Error("rejected"));

    // Verify rejection with try/catch
    let error: Error | null = null;
    try {
      await mockFn2();
    } catch (e) {
      error = e as Error;
    }

    // Check that we got the right error
    expect(error).not.toBeNull();
    expect(error?.message).toBe("rejected");
  });
});

describe("Asymmetric Matchers Compatibility", () => {
  // Since we can't directly call expect.anything() due to TypeScript limitations,
  // we'll use the matchers directly from our compatibility layer
  const matchers = compat.asymmetricMatchers;

  test("matchers.anything() matches anything except null/undefined", () => {
    // Instead of using toEqual with matchers, directly check the asymmetricMatch method
    expect(matchers.anything().asymmetricMatch("string")).toBe(true);
    expect(matchers.anything().asymmetricMatch(123)).toBe(true);
    expect(matchers.anything().asymmetricMatch({})).toBe(true);
    expect(matchers.anything().asymmetricMatch([])).toBe(true);

    expect(matchers.anything().asymmetricMatch(null)).toBe(false);
    expect(matchers.anything().asymmetricMatch(undefined)).toBe(false);
  });

  test("matchers.any() matches type", () => {
    expect(matchers.any(String).asymmetricMatch("string")).toBe(true);
    expect(matchers.any(Number).asymmetricMatch(123)).toBe(true);
    expect(matchers.any(Object).asymmetricMatch({})).toBe(true);
    expect(matchers.any(Array).asymmetricMatch([])).toBe(true);

    expect(matchers.any(Number).asymmetricMatch("string")).toBe(false);
    expect(matchers.any(String).asymmetricMatch(123)).toBe(false);
  });

  test("matchers.stringContaining() matches substrings", () => {
    expect(matchers.stringContaining("world").asymmetricMatch("hello world")).toBe(true);

    expect(matchers.stringContaining("world").asymmetricMatch("hello")).toBe(false);
  });

  test("matchers.objectContaining() matches partial objects", () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(matchers.objectContaining({ a: 1 }).asymmetricMatch(obj)).toBe(true);
    expect(matchers.objectContaining({ a: 1, b: 2 }).asymmetricMatch(obj)).toBe(true);

    expect(matchers.objectContaining({ d: 4 }).asymmetricMatch(obj)).toBe(false);
  });

  test("matchers.arrayContaining() matches array subsets", () => {
    const arr = [1, 2, 3, 4];
    expect(matchers.arrayContaining([1]).asymmetricMatch(arr)).toBe(true);
    expect(matchers.arrayContaining([1, 2]).asymmetricMatch(arr)).toBe(true);

    expect(matchers.arrayContaining([5]).asymmetricMatch(arr)).toBe(false);
  });

  test("nested matchers work", () => {
    const obj = {
      name: "test",
      value: 123,
      items: ["a", "b", "c"],
    };

    const nestedMatcher = matchers.objectContaining({
      name: matchers.stringContaining("te"),
      value: matchers.any(Number),
      items: matchers.arrayContaining(["a"]),
    });

    expect(nestedMatcher.asymmetricMatch(obj)).toBe(true);

    const invalidObj = {
      name: "other",
      value: "not a number",
      items: ["x", "y", "z"],
    };

    expect(nestedMatcher.asymmetricMatch(invalidObj)).toBe(false);
  });
});

describe("Module Mocking Compatibility", () => {
  test("mockModule works with factory", () => {
    // Mock a module with a factory
    const mockExports = {
      foo: compat.createCompatMock().mockReturnValue("mocked foo"),
      bar: compat.createCompatMock().mockReturnValue("mocked bar"),
    };

    compat.mockModule("some/module/path", () => mockExports);

    // The module should be mocked
    const mockedModule = compat.getMockModule("some/module/path");
    expect(mockedModule).toBe(mockExports);
    expect(mockedModule.foo()).toBe("mocked foo");
    expect(mockedModule.bar()).toBe("mocked bar");
  });

  test("jest.mock provides Jest-like syntax", () => {
    // Mock a module using jest.mock
    compat.jest.mock("another/module/path", () => ({
      baz: compat.createCompatMock().mockReturnValue("mocked baz"),
    }));

    // The module should be mocked
    const mockedModule = compat.getMockModule("another/module/path");
    expect(mockedModule.baz()).toBe("mocked baz");
  });

  test("mockModuleFunction mocks a single export", () => {
    // Mock a single export
    compat.mockModuleFunction(
      "module/with/function",
      "specificFunction",
      () => "mocked specific function"
    );

    // The export should be mocked
    const mockedModule = compat.getMockModule("module/with/function");
    expect(mockedModule.specificFunction()).toBe("mocked specific function");
  });
});
