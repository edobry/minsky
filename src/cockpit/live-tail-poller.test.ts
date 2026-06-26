/**
 * Tests for the Rung-1 live-tail poller helpers (mt#2232).
 *
 * Covers:
 *   1. `jsonlLineToLiveBlock` — JSONL line → SessionContextSnapshotBlock conversion
 *   2. `resolveJsonlPath` — JSONL file path resolution (via injected mock fsMod)
 *   3. `startLiveTail` — polling loop (via injected mock tailer + statFn)
 *
 * All filesystem operations are handled through the injectable `fsMod` /
 * `statFn` / `tailer` seams so no real disk I/O occurs in this test suite.
 */
import { describe, test, expect } from "bun:test";

import type { ResolveJsonlFsMod, TailerLike } from "./live-tail-poller";
import { jsonlLineToLiveBlock, resolveJsonlPath, startLiveTail } from "./live-tail-poller";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-abc123";

const USER_LINE = {
  type: "user",
  uuid: "u1",
  timestamp: "2026-06-26T10:00:00.000Z",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello from user" }],
  },
};

const ASSISTANT_LINE = {
  type: "assistant",
  uuid: "a1",
  parentUuid: "u1",
  timestamp: "2026-06-26T10:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Hello from assistant" }],
  },
};

const SYSTEM_LINE = {
  type: "system",
  uuid: "s1",
  timestamp: "2026-06-26T10:00:02.000Z",
  message: { subtype: "init" },
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a fake in-memory directory tree for resolveJsonlPath. */
function makeMockFsMod(files: string[]): ResolveJsonlFsMod {
  // files is a set of absolute paths that "exist"
  const fileSet = new Set(files);

  // Build a dir→children map from the file paths.
  // We only need one-level deep: claudeProjectsDir/subdir/file.jsonl
  const dirChildren: Map<string, string[]> = new Map();
  for (const fp of files) {
    const parts = fp.split("/");
    if (parts.length < 2) continue;
    // parent dir is all but last segment
    const parentDir = parts.slice(0, -1).join("/");
    const entry = parts.at(-1) ?? "";
    const parentChildren = dirChildren.get(parentDir) ?? [];
    if (!dirChildren.has(parentDir)) dirChildren.set(parentDir, parentChildren);
    parentChildren.push(entry);

    // also register the grandparent dir → parent as a subdir
    const grandparentDir = parts.slice(0, -2).join("/");
    const subdirName = parts.at(-2) ?? "";
    const grandChildren = dirChildren.get(grandparentDir) ?? [];
    if (!dirChildren.has(grandparentDir)) dirChildren.set(grandparentDir, grandChildren);
    if (!grandChildren.includes(subdirName)) {
      grandChildren.push(subdirName);
    }
  }

  return {
    async readdirWithTypes(dir: string) {
      const children = dirChildren.get(dir) ?? [];
      return children.map((name) => {
        const fullPath = `${dir}/${name}`;
        const isDir = dirChildren.has(fullPath);
        return { name, isDirectory: () => isDir };
      });
    },
    fileExists(path: string) {
      return fileSet.has(path);
    },
  };
}

/** Mock tailer that returns queued lines and tracks what offset was set. */
class MockTailer implements TailerLike {
  private queue: unknown[] = [];
  public lastSetOffset: number | null = null;
  public forgotPath: string | null = null;

  queueLines(...lines: unknown[]): void {
    this.queue.push(...lines);
  }

  setOffset(_path: string, offset: number): void {
    this.lastSetOffset = offset;
  }

  forget(path: string): void {
    this.forgotPath = path;
  }

  async readNew<T = unknown>(_path: string): Promise<{ lines: T[] }> {
    const lines = this.queue.splice(0) as T[];
    return { lines };
  }
}

// ---------------------------------------------------------------------------
// jsonlLineToLiveBlock
// ---------------------------------------------------------------------------

describe("jsonlLineToLiveBlock", () => {
  test("converts a user line to a live block with live: id scheme", () => {
    const block = jsonlLineToLiveBlock(SESSION_ID, 0, USER_LINE);
    expect(block).not.toBeNull();
    expect(block?.id).toBe(`${SESSION_ID}:live:0`);
    expect(block?.rawJsonlType).toBe("user");
    expect(block?.type).toBe("user-prompt");
    expect(block?.source).toBe("observed");
    expect(block?.timestamp).toBe("2026-06-26T10:00:00.000Z");
  });

  test("converts an assistant line to a live block", () => {
    const block = jsonlLineToLiveBlock(SESSION_ID, 1, ASSISTANT_LINE);
    expect(block).not.toBeNull();
    expect(block?.id).toBe(`${SESSION_ID}:live:1`);
    expect(block?.rawJsonlType).toBe("assistant");
    expect(block?.type).toBe("assistant-text");
  });

  test("returns null for system lines (filtered out)", () => {
    const block = jsonlLineToLiveBlock(SESSION_ID, 0, SYSTEM_LINE);
    expect(block).toBeNull();
  });

  test("returns null for null input", () => {
    const block = jsonlLineToLiveBlock(SESSION_ID, 0, null);
    expect(block).toBeNull();
  });

  test("returns null for a line missing timestamp", () => {
    const noTs = { type: "user", uuid: "x", message: { role: "user", content: [] } };
    const block = jsonlLineToLiveBlock(SESSION_ID, 0, noTs);
    expect(block).toBeNull();
  });

  test("uses the supplied counter as the live: id index", () => {
    const b0 = jsonlLineToLiveBlock(SESSION_ID, 0, USER_LINE);
    const b1 = jsonlLineToLiveBlock(SESSION_ID, 1, USER_LINE);
    const b2 = jsonlLineToLiveBlock(SESSION_ID, 2, ASSISTANT_LINE);
    expect(b0?.id).toBe(`${SESSION_ID}:live:0`);
    expect(b1?.id).toBe(`${SESSION_ID}:live:1`);
    expect(b2?.id).toBe(`${SESSION_ID}:live:2`);
  });
});

// ---------------------------------------------------------------------------
// resolveJsonlPath
// ---------------------------------------------------------------------------

describe("resolveJsonlPath", () => {
  const PROJECTS_ROOT = "/mock/claude/projects";
  const PROJ_SUBDIR = `${PROJECTS_ROOT}/encoded-project`;
  const FILE_PATH = `${PROJ_SUBDIR}/${SESSION_ID}.jsonl`;

  test("finds JSONL file via projectDir fast-path", async () => {
    const fsMod = makeMockFsMod([FILE_PATH]);
    const result = await resolveJsonlPath(SESSION_ID, {
      projectDir: PROJ_SUBDIR,
      fsMod,
    });
    expect(result).toBe(FILE_PATH);
  });

  test("finds JSONL file by scanning under claudeProjectsDir", async () => {
    const fsMod = makeMockFsMod([FILE_PATH]);
    const result = await resolveJsonlPath(SESSION_ID, {
      claudeProjectsDir: PROJECTS_ROOT,
      fsMod,
    });
    expect(result).toBe(FILE_PATH);
  });

  test("returns null when file not found in scan", async () => {
    const fsMod = makeMockFsMod([]);
    const result = await resolveJsonlPath("nonexistent-session-id", {
      claudeProjectsDir: PROJECTS_ROOT,
      fsMod,
    });
    expect(result).toBeNull();
  });

  test("returns null when claudeProjectsDir does not exist (readdirWithTypes throws)", async () => {
    const fsMod: ResolveJsonlFsMod = {
      async readdirWithTypes(_dir: string) {
        throw new Error("ENOENT: no such file or directory");
      },
      fileExists: () => false,
    };
    const result = await resolveJsonlPath(SESSION_ID, {
      claudeProjectsDir: "/nonexistent/path",
      fsMod,
    });
    expect(result).toBeNull();
  });

  test("returns null when projectDir is provided but file does not exist", async () => {
    const fsMod = makeMockFsMod([]); // no files exist
    const result = await resolveJsonlPath(SESSION_ID, {
      projectDir: PROJ_SUBDIR,
      fsMod,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startLiveTail
// ---------------------------------------------------------------------------

describe("startLiveTail", () => {
  const JSONL_PATH = "/mock/sessions/test-session.jsonl";

  test("calls onBlock with new turns queued after connection", async () => {
    const tailer = new MockTailer();
    const statFn = async (_path: string) => ({ size: 1000 });
    const received: unknown[] = [];

    // Queue the assistant line BEFORE startLiveTail so it appears in the first poll.
    tailer.queueLines(ASSISTANT_LINE);

    const stopTail = await startLiveTail(
      JSONL_PATH,
      SESSION_ID,
      (block) => {
        received.push(block);
      },
      { pollMs: 20, tailer, statFn }
    );

    // Wait for at least one poll cycle.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    stopTail();

    expect(received.length).toBe(1);
    const block = received[0] as { rawJsonlType: string; id: string };
    expect(block.rawJsonlType).toBe("assistant");
    expect(block.id).toBe(`${SESSION_ID}:live:0`);
  });

  test("seeds tailer offset to current EOF (stat.size) at startup", async () => {
    const tailer = new MockTailer();
    const statFn = async (_path: string) => ({ size: 4096 });

    const stop = await startLiveTail(JSONL_PATH, SESSION_ID, () => {}, {
      pollMs: 100,
      tailer,
      statFn,
    });
    stop();

    expect(tailer.lastSetOffset).toBe(4096);
  });

  test("skips system lines (jsonlLineToLiveBlock returns null for them)", async () => {
    const tailer = new MockTailer();
    const statFn = async (_path: string) => ({ size: 0 });
    const received: unknown[] = [];

    tailer.queueLines(SYSTEM_LINE);

    const stop = await startLiveTail(
      JSONL_PATH,
      SESSION_ID,
      (block) => {
        received.push(block);
      },
      { pollMs: 20, tailer, statFn }
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    stop();

    expect(received.length).toBe(0);
  });

  test("stop() halts polling — no blocks delivered after stop", async () => {
    const tailer = new MockTailer();
    const statFn = async (_path: string) => ({ size: 0 });
    const received: unknown[] = [];

    const stop = await startLiveTail(
      JSONL_PATH,
      SESSION_ID,
      (block) => {
        received.push(block);
      },
      { pollMs: 20, tailer, statFn }
    );

    stop();

    // Queue lines AFTER stop — they should never arrive.
    tailer.queueLines(USER_LINE, ASSISTANT_LINE);

    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(received.length).toBe(0);
  });

  test("stop() calls tailer.forget with the jsonlPath", async () => {
    const tailer = new MockTailer();
    const statFn = async (_path: string) => ({ size: 0 });

    const stop = await startLiveTail(JSONL_PATH, SESSION_ID, () => {}, {
      pollMs: 100,
      tailer,
      statFn,
    });
    stop();

    expect(tailer.forgotPath).toBe(JSONL_PATH);
  });
});
