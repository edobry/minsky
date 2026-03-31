/**
 * Tests for the repository backends implementation.
 */
import { describe, test, expect } from "bun:test";
import { RepositoryBackendType } from "./repository";

describe("Repository backends", () => {
  test("RepositoryBackendType enum has correct values", () => {
    expect(RepositoryBackendType.LOCAL).toBe("local");
    expect(RepositoryBackendType.REMOTE).toBe("remote");
    expect(RepositoryBackendType.GITHUB).toBe("github");
  });

  test("RepositoryBackendType enum has all three backend types", () => {
    const values = Object.values(RepositoryBackendType);
    expect(values).toContain("local");
    expect(values).toContain("remote");
    expect(values).toContain("github");
    expect(values.length).toBe(3);
  });

  test("RepositoryBackendType LOCAL value matches string literal", () => {
    const backendType: RepositoryBackendType = RepositoryBackendType.LOCAL;
    expect(backendType).toBe("local");
  });

  test("RepositoryBackendType GITHUB value matches string literal", () => {
    const backendType: RepositoryBackendType = RepositoryBackendType.GITHUB;
    expect(backendType).toBe("github");
  });
});
