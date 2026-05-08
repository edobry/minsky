import { describe, test, expect } from "bun:test";
import { restoreImpl, type RestoreDependencies } from "./restore-operations";

const WORKDIR = "/tmp/work";

function makeDeps(handler: { stdout: string; stderr?: string } | Error): RestoreDependencies {
  return {
    async execAsync() {
      if (handler instanceof Error) throw handler;
      return { stdout: handler.stdout, stderr: handler.stderr ?? "" };
    },
  };
}

describe("restoreImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(restoreImpl).toBeDefined();
    expect(restoreImpl.length).toBe(2);
  });

  test("throws when paths is empty", async () => {
    const deps = makeDeps({ stdout: "" });
    await expect(restoreImpl({ repoPath: WORKDIR, paths: [] }, deps)).rejects.toThrow(
      /at least one path/
    );
  });

  test("returns restored paths on success", async () => {
    const deps = makeDeps({ stdout: "" });
    const result = await restoreImpl({ repoPath: WORKDIR, paths: ["src/foo.ts"] }, deps);
    expect(result.restored).toEqual(["src/foo.ts"]);
    expect(result.workdir).toBe(WORKDIR);
  });

  test("returns all provided paths", async () => {
    const deps = makeDeps({ stdout: "" });
    const result = await restoreImpl({ repoPath: WORKDIR, paths: ["file1.ts", "file2.ts"] }, deps);
    expect(result.restored).toEqual(["file1.ts", "file2.ts"]);
  });

  test("propagates exec errors", async () => {
    const err = new Error("restore failed");
    const deps = makeDeps(err);
    await expect(restoreImpl({ repoPath: WORKDIR, paths: ["foo.ts"] }, deps)).rejects.toBe(err);
  });
});
