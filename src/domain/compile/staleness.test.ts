/**
 * Unit tests for the checkStaleness helper.
 *
 * Covers: fresh, modified-content, missing-file, and orphan-file scenarios.
 */

import { describe, it, expect } from "bun:test";
import { checkStaleness } from "./staleness";
import type { MinskyCompileFsDeps, MinskyCompileTarget, MinskyTargetOptions } from "./types";

// ─── Fake fs ─────────────────────────────────────────────────────────────────

function makeFakeFs(diskFiles: Record<string, string>): MinskyCompileFsDeps {
  return {
    async readFile(path: string, _enc: "utf-8"): Promise<string> {
      const content = diskFiles[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(): Promise<void> {},
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(diskFiles)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment !== undefined && !segment.includes("/")) {
            names.add(segment);
          }
        }
      }
      return Array.from(names);
    },
    async access(path: string): Promise<void> {
      if (diskFiles[path] === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
    },
  };
}

// ─── Stub target ─────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";
const OUTPUT_DIR = `${WORKSPACE}/.out`;
const FILE_A = `${OUTPUT_DIR}/a.md`;
const FILE_B = `${OUTPUT_DIR}/b.md`;

function makeStubTarget(outputFiles: string[]): MinskyCompileTarget {
  return {
    id: "stub",
    displayName: "Stub",
    defaultOutputPath(_workspacePath: string): string {
      return OUTPUT_DIR;
    },
    async listOutputFiles(
      _options: MinskyTargetOptions,
      _workspacePath: string
    ): Promise<string[]> {
      return outputFiles;
    },
    async compile(_options: MinskyTargetOptions, _workspacePath: string) {
      return {
        target: "stub",
        filesWritten: outputFiles,
        definitionsIncluded: [],
        definitionsSkipped: [],
      };
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("checkStaleness", () => {
  describe("fresh (up-to-date)", () => {
    it("returns stale=false when all files match expected content", async () => {
      const target = makeStubTarget([FILE_A]);
      const expectedContents = new Map([[FILE_A, "content-a"]]);
      const fakeFs = makeFakeFs({ [FILE_A]: "content-a" });

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(false);
      expect(result.staleFile).toBeUndefined();
    });

    it("returns stale=false with multiple files all matching", async () => {
      const target = makeStubTarget([FILE_A, FILE_B]);
      const expectedContents = new Map([
        [FILE_A, "content-a"],
        [FILE_B, "content-b"],
      ]);
      const diskFiles = { [FILE_A]: "content-a", [FILE_B]: "content-b" };
      const fakeFs = makeFakeFs(diskFiles);

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(false);
    });
  });

  describe("stale: missing file", () => {
    it("returns stale=true when an expected file does not exist on disk", async () => {
      const target = makeStubTarget([FILE_A]);
      const expectedContents = new Map([[FILE_A, "content-a"]]);
      const fakeFs = makeFakeFs({}); // FILE_A missing

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(FILE_A);
    });
  });

  describe("stale: modified content", () => {
    it("returns stale=true when on-disk content differs from expected", async () => {
      const target = makeStubTarget([FILE_A]);
      const expectedContents = new Map([[FILE_A, "new-content"]]);
      const fakeFs = makeFakeFs({ [FILE_A]: "old-content" });

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(FILE_A);
    });
  });

  describe("stale: unknown expected content", () => {
    it("returns stale=true when expectedContents has no entry for a file", async () => {
      const target = makeStubTarget([FILE_A]);
      const expectedContents = new Map<string, string>(); // no entry for FILE_A
      const fakeFs = makeFakeFs({ [FILE_A]: "some-content" });

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(FILE_A);
    });
  });

  describe("stale: orphan file", () => {
    it("returns stale=true when an unexpected file exists in the output dir", async () => {
      // Target expects FILE_A but disk also has orphan.md
      const target = makeStubTarget([FILE_A]);
      const expectedContents = new Map([[FILE_A, "content-a"]]);
      const fakeFs = makeFakeFs({
        [FILE_A]: "content-a",
        [`${OUTPUT_DIR}/orphan.md`]: "orphan",
      });

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(true);
      expect(result.staleFile).toBe(`${OUTPUT_DIR}/orphan.md`);
    });
  });

  describe("orphan detection skipped when outputDir doesn't exist", () => {
    it("returns stale=false when no expected files exist but dir doesn't exist either", async () => {
      const target = makeStubTarget([]); // no expected files
      const expectedContents = new Map<string, string>();
      const fakeFs = makeFakeFs({}); // readdir will throw ENOENT for OUTPUT_DIR

      const result = await checkStaleness(target, {}, WORKSPACE, expectedContents, fakeFs);

      expect(result.stale).toBe(false);
    });
  });
});
