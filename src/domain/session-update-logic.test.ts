/**
 * Unit tests for session update conditional logic
 * Tests the pure functions extracted from updateSessionFromParams
 */
import { describe, test, expect } from "bun:test";
import {
  shouldStashChanges,
  shouldRestoreStash,
  shouldPushChanges,
  determineGitOperations,
  type SessionUpdateOptions,
  type SessionUpdateState,
} from "./session-update-logic";

describe("Session Update Logic", () => {
  const defaultState: SessionUpdateState = {
    hasUncommittedChanges: true,
    workdir: "/test/workdir",
  };

  const cleanState: SessionUpdateState = {
    hasUncommittedChanges: false,
    workdir: "/test/workdir",
  };

  describe("shouldStashChanges", () => {
    test("returns true when there are uncommitted changes and no special flags", () => {
      const options: SessionUpdateOptions = {};
      const result = shouldStashChanges(options, defaultState);
      expect(result).toBe(true);
    });

    test("returns false when noStash is true, even with uncommitted changes", () => {
      const options: SessionUpdateOptions = { noStash: true };
      const result = shouldStashChanges(options, defaultState);
      expect(result).toBe(false);
    });

    test("returns false when force is true, even with uncommitted changes", () => {
      const options: SessionUpdateOptions = { force: true };
      const result = shouldStashChanges(options, defaultState);
      expect(result).toBe(false);
    });

    test("returns false when there are no uncommitted changes", () => {
      const options: SessionUpdateOptions = {};
      const result = shouldStashChanges(options, cleanState);
      expect(result).toBe(false);
    });

    test("force takes precedence over noStash being false", () => {
      const options: SessionUpdateOptions = { force: true, noStash: false };
      const result = shouldStashChanges(options, defaultState);
      expect(result).toBe(false);
    });

    test("noStash takes precedence when both noStash and force are false", () => {
      const options: SessionUpdateOptions = { noStash: true, force: false };
      const result = shouldStashChanges(options, defaultState);
      expect(result).toBe(false);
    });
  });

  describe("shouldRestoreStash", () => {
    test("returns true when noStash is false (default)", () => {
      const options: SessionUpdateOptions = {};
      const result = shouldRestoreStash(options);
      expect(result).toBe(true);
    });

    test("returns true when noStash is explicitly false", () => {
      const options: SessionUpdateOptions = { noStash: false };
      const result = shouldRestoreStash(options);
      expect(result).toBe(true);
    });

    test("returns false when noStash is true", () => {
      const options: SessionUpdateOptions = { noStash: true };
      const result = shouldRestoreStash(options);
      expect(result).toBe(false);
    });

    test("is independent of force flag", () => {
      const optionsWithForce: SessionUpdateOptions = { force: true };
      const optionsWithoutForce: SessionUpdateOptions = { force: false };

      expect(shouldRestoreStash(optionsWithForce)).toBe(true);
      expect(shouldRestoreStash(optionsWithoutForce)).toBe(true);
    });
  });

  describe("shouldPushChanges", () => {
    test("returns true when noPush is false (default)", () => {
      const options: SessionUpdateOptions = {};
      const result = shouldPushChanges(options);
      expect(result).toBe(true);
    });

    test("returns true when noPush is explicitly false", () => {
      const options: SessionUpdateOptions = { noPush: false };
      const result = shouldPushChanges(options);
      expect(result).toBe(true);
    });

    test("returns false when noPush is true", () => {
      const options: SessionUpdateOptions = { noPush: true };
      const result = shouldPushChanges(options);
      expect(result).toBe(false);
    });

    test("is independent of noStash and force flags", () => {
      const options: SessionUpdateOptions = { noStash: true, force: true };
      const result = shouldPushChanges(options);
      expect(result).toBe(true);
    });
  });

  describe("determineGitOperations", () => {
    test("determines all operations correctly for default options with uncommitted changes", () => {
      const options: SessionUpdateOptions = {};
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: true,
        shouldPush: true,
        shouldRestoreStash: true,
      });
    });

    test("correctly handles noStash flag", () => {
      const options: SessionUpdateOptions = { noStash: true };
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: false, // noStash prevents stashing
        shouldPush: true, // Push still happens
        shouldRestoreStash: false, // No restore since no stash
      });
    });

    test("correctly handles noPush flag", () => {
      const options: SessionUpdateOptions = { noPush: true };
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: true, // Stashing still happens
        shouldPush: false, // noPush prevents pushing
        shouldRestoreStash: true, // Restore happens since we stashed
      });
    });

    test("correctly handles both noStash and noPush flags", () => {
      const options: SessionUpdateOptions = { noStash: true, noPush: true };
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: false, // noStash prevents stashing
        shouldPush: false, // noPush prevents pushing
        shouldRestoreStash: false, // No restore since no stash
      });
    });

    test("correctly handles force flag", () => {
      const options: SessionUpdateOptions = { force: true };
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: false, // force prevents stashing
        shouldPush: true, // Push still happens
        shouldRestoreStash: true, // Restore logic is independent of force
      });
    });

    test("correctly handles clean workspace (no uncommitted changes)", () => {
      const options: SessionUpdateOptions = {};
      const result = determineGitOperations(options, cleanState);

      expect(result).toEqual({
        shouldStash: false, // No changes to stash
        shouldPush: true, // Push still happens
        shouldRestoreStash: true, // Restore logic is independent of changes
      });
    });

    test("complex scenario: force + noPush with uncommitted changes", () => {
      const options: SessionUpdateOptions = { force: true, noPush: true };
      const result = determineGitOperations(options, defaultState);

      expect(result).toEqual({
        shouldStash: false, // force prevents stashing
        shouldPush: false, // noPush prevents pushing
        shouldRestoreStash: true, // Restore happens (independent logic)
      });
    });
  });
});
