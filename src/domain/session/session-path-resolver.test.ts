/**
 * Domain tests for SessionPathResolver
 * @migrated Converted from adapter tests to domain tests
 * @refactored Focuses on domain logic using actual class methods
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { SessionPathResolver } from "./session-path-resolver";
import { join } from "path";
import { InvalidPathError } from "../workspace/workspace-backend";
import { PATH_TEST_PATTERNS } from "../../utils/test-utils/test-constants";

describe("SessionPathResolver Domain Logic", () => {
  let sessionWorkspace: string;
  let resolver: SessionPathResolver;

  beforeEach(() => {
    // Use mock paths - no real filesystem operations needed
    sessionWorkspace = "/mock/session-workspace";
    resolver = new SessionPathResolver();
  });

  describe("validateAndResolvePath", () => {
    test("should validate and resolve relative paths correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve dot paths correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, "./src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve root path correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, ".");
      expect(result).toBe(sessionWorkspace);
    });

    test("should block path traversal attempts", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, PATH_TEST_PATTERNS.ETC_PASSWD_PATH);
      }).toThrow(InvalidPathError);
    });

    test("should block multiple path traversal attempts", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "src/../../../../../../tmp/malicious");
      }).toThrow(InvalidPathError);
    });

    test("should handle absolute paths within session workspace", () => {
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.validateAndResolvePath(sessionWorkspace, absolutePath);
      expect(result).toBe(absolutePath);
    });

    test("should block absolute paths outside session workspace", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "/etc/passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("getRelativePathFromSession", () => {
    test("should return relative path from session root", () => {
      const result = resolver.getRelativePathFromSession(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return dot for session root", () => {
      const result = resolver.getRelativePathFromSession(sessionWorkspace, ".");
      expect(result).toBe(".");
    });

    test("should handle nested paths", () => {
      const result = resolver.getRelativePathFromSession(
        sessionWorkspace,
        "src/components/Button.tsx"
      );
      expect(result).toBe(join("src", "components", "Button.tsx"));
    });
  });

  describe("createSafePath", () => {
    test("should create safe path from components", () => {
      const result = resolver.createSafePath(sessionWorkspace, "src", "components", "Button.tsx");
      expect(result).toBe(join(sessionWorkspace, "src", "components", "Button.tsx"));
    });

    test("should prevent unsafe path creation", () => {
      expect(() => {
        resolver.createSafePath(sessionWorkspace, "..", "..", "etc", "passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("validateMultiplePaths", () => {
    test("should validate multiple valid paths", () => {
      const paths = ["src/index.ts", "package.json", "src/components"];
      const result = resolver.validateMultiplePaths(sessionWorkspace, paths);
      expect(result).toEqual([
        join(sessionWorkspace, "src", "index.ts"),
        join(sessionWorkspace, "package.json"),
        join(sessionWorkspace, "src", "components"),
      ]);
    });

    test("should throw error when any path is invalid", () => {
      const paths = ["src/index.ts", PATH_TEST_PATTERNS.ETC_PASSWD_PATH, "package.json"];
      expect(() => {
        resolver.validateMultiplePaths(sessionWorkspace, paths);
      }).toThrow(InvalidPathError);
    });
  });

  describe("normalizeRelativePath", () => {
    test("should normalize relative path correctly", () => {
      const result = resolver.normalizeRelativePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should prevent directory traversal in relative paths", () => {
      expect(() => {
        resolver.normalizeRelativePath(sessionWorkspace, PATH_TEST_PATTERNS.ETC_PASSWD_PATH);
      }).toThrow(InvalidPathError);
    });
  });

  describe("absoluteToRelative", () => {
    test("should convert absolute path to relative", () => {
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.absoluteToRelative(sessionWorkspace, absolutePath);
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return null for paths outside session", () => {
      const result = resolver.absoluteToRelative(sessionWorkspace, "/etc/passwd");
      expect(result).toBe(null);
    });

    test("should return dot for session root", () => {
      const result = resolver.absoluteToRelative(sessionWorkspace, sessionWorkspace);
      expect(result).toBe(".");
    });
  });

  describe("lazy sessionProvider DI (mt#1799)", () => {
    test("thunk constructor: thunk is NOT invoked at construction time", () => {
      let thunkInvocations = 0;
      // Construct with a thunk; the bug pattern would resolve the provider eagerly.
      const _r = new SessionPathResolver(() => {
        thunkInvocations++;
        return undefined;
      });
      expect(thunkInvocations).toBe(0);
    });

    test("thunk constructor: thunk IS invoked when getSessionWorkspacePath is called", async () => {
      let thunkInvocations = 0;
      const lazyResolver = new SessionPathResolver(() => {
        thunkInvocations++;
        return undefined;
      });
      await expect(lazyResolver.getSessionWorkspacePath("any-session-id")).rejects.toThrow();
      expect(thunkInvocations).toBe(1);
    });

    test("error message distinguishes thunk-returns-undefined from constructor-undefined", async () => {
      const thunkResolver = new SessionPathResolver(() => undefined);
      const constructorResolver = new SessionPathResolver();

      let thunkError: Error | undefined;
      let constructorError: Error | undefined;
      try {
        await thunkResolver.getSessionWorkspacePath("x");
      } catch (e) {
        thunkError = e as Error;
      }
      try {
        await constructorResolver.getSessionWorkspacePath("x");
      } catch (e) {
        constructorError = e as Error;
      }

      // Both throw the same top-level message, but the diagnostic Cause: section
      // distinguishes the two DI failure modes so an operator can pinpoint
      // which call site is at fault.
      expect(thunkError?.message).toContain("stored provider thunk returned undefined");
      // Both sub-causes are named in the thunk-case wording so the operator
      // doesn't have to guess which DI site is at fault. The wording was
      // softened in PR #1088 R1 — the prior text asserted has()===false even
      // when the container itself was missing.
      expect(thunkError?.message).toContain("no DI container was passed");
      expect(thunkError?.message).toContain("did not have 'sessionProvider' bound");
      expect(constructorError?.message).toContain("constructor was called without a provider");
    });

    test("thunk is invoked on each call (no stale-undefined caching)", async () => {
      let thunkInvocations = 0;
      const lazyResolver = new SessionPathResolver(() => {
        thunkInvocations++;
        return undefined;
      });
      await expect(lazyResolver.getSessionWorkspacePath("x")).rejects.toThrow();
      await expect(lazyResolver.getSessionWorkspacePath("y")).rejects.toThrow();
      // If the resolver cached the first thunk result, the second call would
      // skip the lookup. The fix's intent is to re-query the container each
      // time so a late initialization is observable.
      expect(thunkInvocations).toBe(2);
    });

    test("per-call sessionProvider arg still wins over the stored thunk", async () => {
      // The getSessionWorkspacePath(_, sessionProvider?) overload retains its
      // existing semantics: the per-call arg is preferred when present.
      // Pass a thunk that would error if invoked, plus an explicit provider
      // arg — but the provider would route to resolveSessionDirectory which
      // we don't want to actually invoke here. Easiest verification: the
      // stored thunk is NOT invoked when a per-call arg is passed.
      let thunkInvocations = 0;
      const lazyResolver = new SessionPathResolver(() => {
        thunkInvocations++;
        return undefined;
      });
      // Per-call provider is non-null, so the throw branch is not taken; the
      // call falls through to resolveSessionDirectory which will likely fail
      // for an unknown sessionId, but the stored thunk should not be touched.
      await expect(
        lazyResolver.getSessionWorkspacePath("nonexistent", {} as never)
      ).rejects.toThrow();
      expect(thunkInvocations).toBe(0);
    });
  });
});
