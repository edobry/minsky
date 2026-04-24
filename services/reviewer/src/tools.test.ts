/**
 * Tests for github-client helpers: readFileAtRef and listDirectoryAtRef.
 *
 * Mocks octokit.rest.repos.getContent to avoid real network calls.
 */

import { describe, expect, test, mock } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { readFileAtRef, listDirectoryAtRef } from "./github-client";

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
  test("returns decoded file content on success", async () => {
    const content = Buffer.from("hello world\n").toString("base64");
    const octokit = makeOctokit(() => ({
      data: { type: "file", content, encoding: "base64" },
    }));

    const result = await readFileAtRef(octokit, OWNER, REPO, "src/hello.ts", REF);
    expect(result).toBe("hello world\n");
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

  test("filters out non-file/non-dir entries (e.g. symlinks)", async () => {
    const octokit = makeOctokit(() => ({
      data: [
        { name: "foo.ts", type: "file" },
        { name: "link", type: "symlink" },
      ],
    }));

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "src", REF);
    expect(result).toEqual([{ name: "foo.ts", type: "file" }]);
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

  test("returns empty array when directory has no recognized entries", async () => {
    const octokit = makeOctokit(() => ({
      data: [{ name: "dangling", type: "submodule" }],
    }));

    const result = await listDirectoryAtRef(octokit, OWNER, REPO, "src", REF);
    expect(result).toEqual([]);
  });
});
