/**
 * classifyDockerfileBunBuildRegenError tests (mt#3091).
 *
 * `runDockerfileBunBuildRegen` shells out to
 * `bun run generate:dockerfile-bun-build` and, on failure, formats the error
 * via this pure helper. Mirrors the mt#2621
 * `classifyDockerfileWorkspaceCopyRegenError` test suite — same shape, same
 * stderr-over-stdout-over-Error.message-over-String(error) precedence.
 */
import { describe, test, expect } from "bun:test";
import { classifyDockerfileBunBuildRegenError } from "./bun-build-sync-regen";

describe("classifyDockerfileBunBuildRegenError (mt#3091)", () => {
  test("prefers stderr over stdout when both are present", () => {
    const result = classifyDockerfileBunBuildRegenError({
      stdout: "some stdout noise",
      stderr: "Dockerfile: missing the generated bun-build markers",
    });
    expect(result.message).toBe(
      "Dockerfile bun-build regeneration failed: Dockerfile: missing the generated bun-build markers"
    );
    expect(result.logLines[0]).toBe("❌ Dockerfile bun-build regeneration failed:");
    expect(result.logLines).toContain("   Dockerfile: missing the generated bun-build markers");
  });

  test("falls back to stdout when stderr is empty", () => {
    const result = classifyDockerfileBunBuildRegenError({
      stdout: "Dockerfile: missing the generated bun-build markers",
      stderr: "",
    });
    expect(result.message).toBe(
      "Dockerfile bun-build regeneration failed: Dockerfile: missing the generated bun-build markers"
    );
  });

  test("falls back to Error.message when neither stdout nor stderr is present", () => {
    const result = classifyDockerfileBunBuildRegenError(new Error("spawn ENOENT"));
    expect(result.message).toBe("Dockerfile bun-build regeneration failed: spawn ENOENT");
  });

  test("falls back to String(error) for a non-Error, non-exec-result throw", () => {
    const result = classifyDockerfileBunBuildRegenError("timeout");
    expect(result.message).toBe("Dockerfile bun-build regeneration failed: timeout");
  });

  test("always includes the actionable hint pointing at the generated-block markers", () => {
    const result = classifyDockerfileBunBuildRegenError(new Error("boom"));
    expect(result.logLines.at(-1)).toContain("generated-block markers");
  });

  test("multi-line detail is indented and preserved line-by-line", () => {
    const result = classifyDockerfileBunBuildRegenError({
      stdout: "",
      stderr: "line one\nline two",
    });
    expect(result.logLines).toContain("   line one");
    expect(result.logLines).toContain("   line two");
  });
});
