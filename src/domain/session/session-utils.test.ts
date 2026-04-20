import { describe, it, expect } from "bun:test";
import { parsePrDescriptionFromCommitMessage, resolveBackendType } from "./session-utils";
import { RepositoryBackendType } from "../repository/index";

const SAMPLE_TITLE = "feat: add feature";

describe("parsePrDescriptionFromCommitMessage", () => {
  it("empty string → empty title, empty body", () => {
    const result = parsePrDescriptionFromCommitMessage("");
    expect(result.title).toBe("");
    expect(result.body).toBe("");
  });

  it("single line → title only, empty body", () => {
    const result = parsePrDescriptionFromCommitMessage(SAMPLE_TITLE);
    expect(result.title).toBe(SAMPLE_TITLE);
    expect(result.body).toBe("");
  });

  it("multi-line → title + body", () => {
    const result = parsePrDescriptionFromCommitMessage(`${SAMPLE_TITLE}\n\nSome details here.`);
    expect(result.title).toBe(SAMPLE_TITLE);
    expect(result.body).toBe("Some details here.");
  });

  it("duplicate first body line is deduplicated", () => {
    const result = parsePrDescriptionFromCommitMessage(
      `${SAMPLE_TITLE}\n\n${SAMPLE_TITLE}\n\nMore details.`
    );
    expect(result.title).toBe(SAMPLE_TITLE);
    expect(result.body).toBe("More details.");
  });

  it("non-duplicate body lines are kept", () => {
    const result = parsePrDescriptionFromCommitMessage(
      `${SAMPLE_TITLE}\n\nDifferent first body line.\n\nSecond body line.`
    );
    expect(result.title).toBe(SAMPLE_TITLE);
    // Empty lines between body lines are filtered out; remaining lines are joined with \n
    expect(result.body).toBe("Different first body line.\nSecond body line.");
  });

  it("whitespace-only lines between title and body are filtered out", () => {
    const result = parsePrDescriptionFromCommitMessage("title\n   \n\nbody line");
    expect(result.title).toBe("title");
    expect(result.body).toBe("body line");
  });

  it("leading/trailing whitespace on the full commit message is trimmed before parsing", () => {
    // Outer trim() removes leading/trailing whitespace from the whole message,
    // but trailing spaces on the first line are preserved in the title.
    const result = parsePrDescriptionFromCommitMessage("  title line\n\nbody");
    expect(result.title).toBe("title line");
    expect(result.body).toBe("body");
  });
});

describe("resolveBackendType", () => {
  it('"github" → RepositoryBackendType.GITHUB', () => {
    expect(resolveBackendType("github", "https://github.com/owner/repo.git")).toBe(
      RepositoryBackendType.GITHUB
    );
  });

  it('"local" → RepositoryBackendType.LOCAL', () => {
    expect(resolveBackendType("local", "/some/local/path")).toBe(RepositoryBackendType.LOCAL);
  });

  it('"remote" → RepositoryBackendType.REMOTE', () => {
    expect(resolveBackendType("remote", "https://example.com/repo.git")).toBe(
      RepositoryBackendType.REMOTE
    );
  });

  it("undefined with github.com URL → GITHUB", () => {
    expect(resolveBackendType(undefined, "https://github.com/owner/repo.git")).toBe(
      RepositoryBackendType.GITHUB
    );
  });

  it("undefined with local absolute path → LOCAL", () => {
    expect(resolveBackendType(undefined, "/home/user/projects/repo")).toBe(
      RepositoryBackendType.LOCAL
    );
  });

  it("undefined with file:// URL → LOCAL", () => {
    expect(resolveBackendType(undefined, "file:///home/user/projects/repo")).toBe(
      RepositoryBackendType.LOCAL
    );
  });

  it("undefined with non-github remote URL → REMOTE", () => {
    expect(resolveBackendType(undefined, "https://gitlab.com/owner/repo.git")).toBe(
      RepositoryBackendType.REMOTE
    );
  });

  it("unknown backendType string falls back to LOCAL", () => {
    expect(resolveBackendType("unknown-type", "/some/path")).toBe(RepositoryBackendType.LOCAL);
  });
});
