/**
 * classifyDockerfileWorkspaceCopyRegenError tests (mt#2621).
 *
 * `runDockerfileWorkspaceCopyRegen` shells out to
 * `bun run generate:dockerfile-workspace-copies` and, on failure, formats
 * the error via this pure helper. Mirrors the mt#2622
 * `classifyCompletionManifestRegenError` test suite — same shape, same
 * stderr-over-stdout-over-Error.message-over-String(error) precedence.
 */
import { describe, test, expect } from "bun:test";
import { classifyDockerfileWorkspaceCopyRegenError } from "./pre-commit";

describe("classifyDockerfileWorkspaceCopyRegenError (mt#2621)", () => {
  test("prefers stderr over stdout when both are present", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError({
      stdout: "some stdout noise",
      stderr: "services/cockpit/Dockerfile: missing the generated workspace-COPY markers",
    });
    expect(result.message).toBe(
      "Dockerfile workspace-COPY regeneration failed: services/cockpit/Dockerfile: missing the generated workspace-COPY markers"
    );
    expect(result.logLines[0]).toBe("❌ Dockerfile workspace-COPY regeneration failed:");
    expect(result.logLines).toContain(
      "   services/cockpit/Dockerfile: missing the generated workspace-COPY markers"
    );
  });

  test("falls back to stdout when stderr is empty", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError({
      stdout: "Dockerfile: missing the generated workspace-COPY markers",
      stderr: "",
    });
    expect(result.message).toBe(
      "Dockerfile workspace-COPY regeneration failed: Dockerfile: missing the generated workspace-COPY markers"
    );
  });

  test("falls back to Error.message when neither stdout nor stderr is present", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError(new Error("spawn ENOENT"));
    expect(result.message).toBe("Dockerfile workspace-COPY regeneration failed: spawn ENOENT");
  });

  test("falls back to String(error) for a non-Error, non-exec-result throw", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError("timeout");
    expect(result.message).toBe("Dockerfile workspace-COPY regeneration failed: timeout");
  });

  test("always includes the actionable hint pointing at the generated-block markers", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError(new Error("boom"));
    expect(result.logLines.at(-1)).toContain("generated-block markers");
  });

  test("multi-line detail is indented and preserved line-by-line", () => {
    const result = classifyDockerfileWorkspaceCopyRegenError({
      stdout: "",
      stderr: "line one\nline two",
    });
    expect(result.logLines).toContain("   line one");
    expect(result.logLines).toContain("   line two");
  });
});
