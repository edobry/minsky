/**
 * Unit tests for MinskyCompileService.
 *
 * Uses a stub target to avoid coupling to the claude-skills implementation.
 */

import { describe, it, expect } from "bun:test";
import { MinskyCompileService } from "./compile-service";
import type { MinskyCompileTarget, MinskyCompileResult, MinskyTargetOptions } from "./types";

// ─── Stub Target ─────────────────────────────────────────────────────────────

const STUB_FILE = "/workspace/.out/stub.md";
const STUB_CONTENT = "# Stub output";

const stubTarget: MinskyCompileTarget = {
  id: "stub",
  displayName: "Stub Target",

  defaultOutputPath(_workspacePath: string): string {
    return "/workspace/.out";
  },

  async listOutputFiles(_options: MinskyTargetOptions, _workspacePath: string): Promise<string[]> {
    return [STUB_FILE];
  },

  async compile(
    options: MinskyTargetOptions,
    _workspacePath: string
  ): Promise<MinskyCompileResult> {
    return {
      target: "stub",
      filesWritten: [STUB_FILE],
      definitionsIncluded: ["stub-skill"],
      definitionsSkipped: [],
      content: options.dryRun ? STUB_CONTENT : undefined,
      contentsByPath: options.dryRun ? new Map([[STUB_FILE, STUB_CONTENT]]) : undefined,
    };
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MinskyCompileService", () => {
  describe("registerTarget / getTarget / getAvailableTargets", () => {
    it("registers a target and retrieves it by id", () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);
      expect(service.getTarget("stub")).toBe(stubTarget);
    });

    it("returns undefined for unregistered target id", () => {
      const service = new MinskyCompileService();
      expect(service.getTarget("missing")).toBeUndefined();
    });

    it("lists available target ids", () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);
      expect(service.getAvailableTargets()).toEqual(["stub"]);
    });
  });

  describe("compile — error cases", () => {
    it("throws for an unknown target", async () => {
      const service = new MinskyCompileService();
      await expect(service.compile("unknown", { workspacePath: "/workspace" })).rejects.toThrow(
        'Unknown compile target: "unknown"'
      );
    });
  });

  describe("compile — dryRun mode", () => {
    it("returns content without writing files", async () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);

      const result = await service.compile("stub", {
        workspacePath: "/workspace",
        dryRun: true,
      });

      expect(result.content).toBe(STUB_CONTENT);
      expect(result.filesWritten).toEqual([STUB_FILE]);
      expect(result.definitionsIncluded).toEqual(["stub-skill"]);
    });
  });

  describe("compile — normal mode", () => {
    it("delegates to target compile and returns result", async () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);

      const result = await service.compile("stub", {
        workspacePath: "/workspace",
      });

      expect(result.target).toBe("stub");
      expect(result.filesWritten).toEqual([STUB_FILE]);
      expect(result.content).toBeUndefined();
    });
  });

  describe("compile — check mode (fresh)", () => {
    it("returns stale=false when on-disk content matches expected", async () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);

      // Fake fs: file exists with correct content
      const fakeFs = {
        async readFile(_path: string, _enc: "utf-8"): Promise<string> {
          return STUB_CONTENT;
        },
        async writeFile(): Promise<void> {},
        async mkdir(): Promise<undefined> {
          return undefined;
        },
        async readdir(_path: string): Promise<string[]> {
          return ["stub.md"];
        },
        async access(): Promise<void> {},
      };

      const result = await service.compile(
        "stub",
        { workspacePath: "/workspace", check: true },
        fakeFs
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.staleFile).toBeUndefined();
    });
  });

  describe("compile — check mode (stale: missing file)", () => {
    it("returns stale=true when expected file is missing", async () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);

      const fakeFs = {
        async readFile(_path: string, _enc: "utf-8"): Promise<string> {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        async writeFile(): Promise<void> {},
        async mkdir(): Promise<undefined> {
          return undefined;
        },
        async readdir(_path: string): Promise<string[]> {
          return [];
        },
        async access(): Promise<void> {},
      };

      const result = await service.compile(
        "stub",
        { workspacePath: "/workspace", check: true },
        fakeFs
      );

      expect(result.check).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(STUB_FILE);
    });
  });

  describe("compile — check mode (stale: modified content)", () => {
    it("returns stale=true when on-disk content differs from expected", async () => {
      const service = new MinskyCompileService();
      service.registerTarget(stubTarget);

      const fakeFs = {
        async readFile(_path: string, _enc: "utf-8"): Promise<string> {
          return "# Old content";
        },
        async writeFile(): Promise<void> {},
        async mkdir(): Promise<undefined> {
          return undefined;
        },
        async readdir(_path: string): Promise<string[]> {
          return ["stub.md"];
        },
        async access(): Promise<void> {},
      };

      const result = await service.compile(
        "stub",
        { workspacePath: "/workspace", check: true },
        fakeFs
      );

      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(STUB_FILE);
    });
  });
});
