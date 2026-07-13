import { describe, test, expect } from "bun:test";
import { resetImpl, type ResetDependencies } from "./reset-operations";

const WORKDIR = "/tmp/work";

type ExecCall = { command: string };

function makeDeps(handler: { stdout: string; stderr?: string } | Error): {
  deps: ResetDependencies;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const deps: ResetDependencies = {
    async execAsync(command: string) {
      calls.push({ command });
      if (handler instanceof Error) throw handler;
      return { stdout: handler.stdout, stderr: handler.stderr ?? "" };
    },
  };
  return { deps, calls };
}

describe("resetImpl", () => {
  test("is defined and takes 2 parameters", () => {
    expect(resetImpl).toBeDefined();
    expect(resetImpl.length).toBe(2);
  });

  test("throws when mode=hard without confirmHard", async () => {
    const { deps } = makeDeps({ stdout: "" });
    await expect(resetImpl({ repoPath: WORKDIR, mode: "hard" }, deps)).rejects.toThrow(
      /confirmHard: true/
    );
  });

  test("throws when mode=hard with confirmHard=false", async () => {
    const { deps } = makeDeps({ stdout: "" });
    await expect(
      resetImpl({ repoPath: WORKDIR, mode: "hard", confirmHard: false }, deps)
    ).rejects.toThrow(/confirmHard: true/);
  });

  test("succeeds for mode=soft", async () => {
    const { deps, calls } = makeDeps({ stdout: "" });
    const result = await resetImpl({ repoPath: WORKDIR, mode: "soft" }, deps);
    expect(result.reset).toBe(true);
    expect(result.mode).toBe("soft");
    expect(result.target).toBe("HEAD");
    expect(calls[0]?.command).toContain("--soft");
  });

  test("succeeds for mode=mixed (default git behavior)", async () => {
    const { deps, calls } = makeDeps({ stdout: "" });
    const result = await resetImpl({ repoPath: WORKDIR, mode: "mixed" }, deps);
    expect(result.mode).toBe("mixed");
    expect(calls[0]?.command).toContain("--mixed");
  });

  test("succeeds for mode=hard when confirmHard=true", async () => {
    const { deps, calls } = makeDeps({ stdout: "" });
    const result = await resetImpl({ repoPath: WORKDIR, mode: "hard", confirmHard: true }, deps);
    expect(result.reset).toBe(true);
    expect(result.mode).toBe("hard");
    expect(calls[0]?.command).toContain("--hard");
  });

  test("uses specified target ref", async () => {
    const { deps, calls } = makeDeps({ stdout: "" });
    await resetImpl({ repoPath: WORKDIR, mode: "soft", target: "HEAD~1" }, deps);
    expect(calls[0]?.command).toContain("'HEAD~1'");

    const result = await resetImpl({ repoPath: WORKDIR, mode: "soft", target: "HEAD~1" }, deps);
    expect(result.target).toBe("HEAD~1");
  });

  test("propagates exec errors", async () => {
    const err = new Error("reset failed");
    const { deps } = makeDeps(err);
    await expect(resetImpl({ repoPath: WORKDIR, mode: "mixed" }, deps)).rejects.toBe(err);
  });
});
