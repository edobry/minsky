/**
 * Tests for github-client helpers: readFileAtRef and listDirectoryAtRef.
 *
 * Mocks octokit.rest.repos.getContent to avoid real network calls.
 */

import { describe, expect, test, mock } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { listDirectoryAtRef, normalizeContentPath, readFileAtRef } from "./github-client";

/** Build a minimal mock Octokit with a stubbed getContent. */
function makeOctokit(
  getContentImpl: (params: { owner: string; repo: string; path: string; ref: string }) => unknown
): Octokit {
  return {
    rest: {
      repos: {
        getContent: mock(getContentImpl),
      },
    },
  } as unknown as Octokit;
}

const OWNER = "test-owner";
const REPO = "test-repo";
const REF = "abc1234";

// ----- readFileAtRef -----

describe("readFileAtRef", () => {
  test("returns text kind with decoded content on success", async () => {
    const content = Buffer.from("hello world\n").toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64" },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "src/hello.ts", REF);
    expect(result).toEqual({ kind: "text", content: "hello world\n", truncated: false });
  });

  test("returns null on 404", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });

    const result = await readFileAtRef(octokit, OWNER, REPO, "missing/file.ts", REF);
    expect(result).toBeNull();
  });

  test("throws on non-404 errors", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Internal Server Error") as Error & { status: number };
      err.status = 500;
      throw err;
    });

    await expect(readFileAtRef(octokit, OWNER, REPO, "src/foo.ts", REF)).rejects.toThrow(
      "Internal Server Error"
    );
  });

  test("throws when getContent returns an array (directory path)", async () => {
    const octokit = makeOctokit(() => ({
      data: [{ name: "foo.ts", type: "file" }],
    }));

    await expect(readFileAtRef(octokit, OWNER, REPO, "src", REF)).rejects.toThrow("is a directory");
  });

  test("throws when entry type is not 'file'", async () => {
    const octokit = makeOctokit(() => ({
      data: { type: "symlink", content: "" },
    }));

    await expect(readFileAtRef(octokit, OWNER, REPO, "src/link", REF)).rejects.toThrow(
      "is not a file"
    );
  });

  // ----- binary detection (mt#1216) -----
  //
  // Files with a NUL byte in the first ~8KB are binary (file(1) heuristic).
  // Decoding them as UTF-8 produces gibberish that wastes context budget; the
  // helper returns a placeholder kind so the envelope can surface size to the
  // model without the raw content.

  test("returns binary kind when content contains a null byte in the sampled region", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    const content = bytes.toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64" },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "assets/logo.png", REF);
    expect(result).toEqual({ kind: "binary", size: bytes.length });
  });

  test("empty file (zero bytes) is still treated as text", async () => {
    const content = Buffer.from("").toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64" },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "empty", REF);
    expect(result).toEqual({ kind: "text", content: "", truncated: false });
  });

  test("text file containing the literal word 'null' returns text kind (not envelope 'not_found')", async () => {
    // Regression: the pre-mt#1216 tool envelope serialized missing-file as the
    // literal string "null", which collided with a file whose content was
    // exactly those four characters. Binary detection + structured result
    // cleanly distinguish the two now.
    const content = Buffer.from("null").toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64" },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "fixtures/null.txt", REF);
    expect(result).toEqual({ kind: "text", content: "null", truncated: false });
  });
});

// ----- listDirectoryAtRef -----

describe("listDirectoryAtRef", () => {
  test("returns files and dirs", async () => {
    const octokit = makeOctokit(() => ({
      data: [
        { name: "index.ts", type: "file" },
        { name: "lib", type: "dir" },
        { name: "README.md", type: "file" },
      ],
    }));

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "src", REF);
    expect(result).toEqual([
      { name: "index.ts", type: "file" },
      { name: "lib", type: "dir" },
      { name: "README.md", type: "file" },
    ]);
  });

  test("passes symlink and submodule entries through with their real type (mt#1216)", async () => {
    const octokit = makeOctokit(() => ({
      data: [
        { name: "foo.ts", type: "file" },
        { name: "link", type: "symlink" },
        { name: "vendor", type: "submodule" },
      ],
    }));

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "src", REF);
    expect(result).toEqual([
      { name: "foo.ts", type: "file" },
      { name: "link", type: "symlink" },
      { name: "vendor", type: "submodule" },
    ]);
  });

  test("returns null on 404", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "missing-dir", REF);
    expect(result).toBeNull();
  });

  test("throws on non-404 errors", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    });

    await expect(listDirectoryAtRef(octokit, OWNER, REPO, "src", REF)).rejects.toThrow("Forbidden");
  });

  test("throws when getContent returns a file object (not array)", async () => {
    const content = Buffer.from("data").toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content },
    }));

    await expect(listDirectoryAtRef(octokit, OWNER, REPO, "src/foo.ts", REF)).rejects.toThrow(
      "is not a directory"
    );
  });

  test("filters entries whose type is neither file/dir/symlink/submodule", async () => {
    // GitHub has historically returned only the four recognized types, but
    // the helper filters defensively so a novel type never lands unlabelled.
    const octokit = makeOctokit(() => ({
      data: [
        { name: "ok.ts", type: "file" },
        { name: "weird", type: "something-new" },
      ],
    }));

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "src", REF);
    expect(result).toEqual([{ name: "ok.ts", type: "file" }]);
  });
});

// ----- normalizeContentPath (mt#1126 minsky-reviewer finding) -----

describe("normalizeContentPath", () => {
  test('maps "." to ""', () => {
    // The GitHub Contents API expects an empty string for the repo root.
    // Prior to the fix, "." was passed verbatim and produced spurious 404s.
    expect(normalizeContentPath(".")).toBe("");
  });

  test('maps "./" to ""', () => {
    expect(normalizeContentPath("./")).toBe("");
  });

  test('maps "/" to ""', () => {
    expect(normalizeContentPath("/")).toBe("");
  });

  test('maps "" to ""', () => {
    expect(normalizeContentPath("")).toBe("");
  });

  test('strips a "./" prefix', () => {
    expect(normalizeContentPath("./src/foo.ts")).toBe("src/foo.ts");
  });

  test("strips trailing slashes on non-root dir paths", () => {
    expect(normalizeContentPath("src/")).toBe("src");
    expect(normalizeContentPath("src/foo/")).toBe("src/foo");
  });

  test("leaves normal paths unchanged", () => {
    expect(normalizeContentPath("src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeContentPath("README.md")).toBe("README.md");
  });

  test('strips leading "/" for non-root paths (models often supply absolute-like paths)', () => {
    // The Contents API expects relative paths. Models frequently supply
    // "/src/foo.ts" and similar — that would 404 without normalization.
    expect(normalizeContentPath("/src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeContentPath("/README.md")).toBe("README.md");
    expect(normalizeContentPath("/src/dir/")).toBe("src/dir");
  });

  test("strips multiple leading slashes", () => {
    expect(normalizeContentPath("//src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeContentPath("///foo.ts")).toBe("foo.ts");
  });
});

// ----- readFileAtRef: root-path normalization + truncation handling -----

describe("readFileAtRef — root-path normalization", () => {
  test('normalizes "." to "" before calling getContent', async () => {
    const content = Buffer.from("root file\n").toString("base64");
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: { type: "file", content, encoding: "base64" } };
    });

    await readFileAtRef(octokit, OWNER, REPO, ".", REF);
    expect(capturedPath).toBe("");
  });

  test('normalizes "./" to "" before calling getContent', async () => {
    const content = Buffer.from("root file\n").toString("base64");
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: { type: "file", content, encoding: "base64" } };
    });

    await readFileAtRef(octokit, OWNER, REPO, "./README.md", REF);
    // "./README.md" → "README.md" (prefix stripped)
    expect(capturedPath).toBe("README.md");
  });
});

describe("readFileAtRef — truncation handling (mt#1216)", () => {
  test("surfaces truncation as a boolean flag on the text result", async () => {
    // The Contents API sets `truncated: true` on files above ~1MB. Pre-mt#1216
    // prepended a notice string to the content; now the fact rides as a
    // dedicated boolean so a truncated JSON file remains valid JSON.
    const snippet = "this is only the first few KB of a huge file\n";
    const content = Buffer.from(snippet).toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64", truncated: true },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "dist/big.js", REF);
    expect(result).toEqual({ kind: "text", content: snippet, truncated: true });
  });

  test("truncated content is NOT wrapped in any prefix notice", async () => {
    // Regression guard: the content field must be byte-identical to the
    // decoded API response, with no "[TRUNCATED]" header prepended.
    const snippet = '{ "partial": true }';
    const content = Buffer.from(snippet).toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64", truncated: true },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "config.json", REF);
    if (result === null || result.kind !== "text") throw new Error("expected text result");
    expect(result.content).toBe(snippet);
    expect(result.content).not.toContain("[TRUNCATED]");
  });

  test("truncated=false / absent yields truncated: false on the result", async () => {
    const text = "small file\n";
    const content = Buffer.from(text).toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64", truncated: false },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "src/small.ts", REF);
    expect(result).toEqual({ kind: "text", content: text, truncated: false });
  });
});

describe("listDirectoryAtRef — root-path normalization", () => {
  test('normalizes "." to "" before calling getContent', async () => {
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: [] };
    });

    await listDirectoryAtRef(octokit, OWNER, REPO, ".", REF);
    expect(capturedPath).toBe("");
  });

  test('normalizes "./" to "" before calling getContent', async () => {
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: [] };
    });

    await listDirectoryAtRef(octokit, OWNER, REPO, "./", REF);
    expect(capturedPath).toBe("");
  });

  test('normalizes "/" to "" before calling getContent', async () => {
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: [] };
    });

    await listDirectoryAtRef(octokit, OWNER, REPO, "/", REF);
    expect(capturedPath).toBe("");
  });

  test('strips leading "/" on non-root dir paths', async () => {
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: [] };
    });

    await listDirectoryAtRef(octokit, OWNER, REPO, "/src/foo", REF);
    expect(capturedPath).toBe("src/foo");
  });

  test("strips trailing slashes on dir paths", async () => {
    let capturedPath: string | undefined;
    const octokit = makeOctokit((params) => {
      capturedPath = params.path;
      return { data: [] };
    });

    await listDirectoryAtRef(octokit, OWNER, REPO, "src/foo/", REF);
    expect(capturedPath).toBe("src/foo");
  });
});
