/**
 * Invalidation tracker tests (mt#1426).
 *
 * Verifies the notify/consume cycle, the noticePending flag semantics
 * (notice fires once, then suppresses until re-armed), and listInvalidations.
 *
 * NOTE on `custom/no-real-fs-in-tests`: this test exercises real fs writes
 * to verify the sentinel file shape (~/.config/minsky/credentials-invalidated.json),
 * matching the same posture as lifecycle.test.ts.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#1426: testing real fs sentinel file is the point */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  notifyCredentialInvalidated,
  consumeInvalidationNotice,
  consumeAndReportInvalidationNotice,
  listInvalidations,
  clearInvalidation,
} from "./invalidations";

let tempHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "minsky-inval-test-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CONFIG_HOME"];
  process.env["HOME"] = tempHome;
  process.env["XDG_CONFIG_HOME"] = join(tempHome, ".config");
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("notifyCredentialInvalidated", () => {
  it("records a new invalidation for an unknown provider", async () => {
    await notifyCredentialInvalidated("github", "401 from /user");
    const list = await listInvalidations();
    expect(list).toHaveLength(1);
    expect(list[0]?.provider).toBe("github");
    expect(list[0]?.reason).toBe("401 from /user");
  });

  it("replaces the existing entry when re-invalidating", async () => {
    await notifyCredentialInvalidated("github", "first reason");
    await notifyCredentialInvalidated("github", "second reason");
    const list = await listInvalidations();
    expect(list).toHaveLength(1);
    expect(list[0]?.reason).toBe("second reason");
  });
});

describe("consumeInvalidationNotice", () => {
  it("returns the entry on first call and null on second call", async () => {
    await notifyCredentialInvalidated("github", "401");
    const first = await consumeInvalidationNotice("github");
    expect(first).not.toBeNull();
    expect(first?.reason).toBe("401");
    const second = await consumeInvalidationNotice("github");
    expect(second).toBeNull();
  });

  it("returns null when no invalidation is recorded", async () => {
    const result = await consumeInvalidationNotice("github");
    expect(result).toBeNull();
  });

  it("re-arms noticePending when notifyCredentialInvalidated is called again", async () => {
    await notifyCredentialInvalidated("github", "first");
    await consumeInvalidationNotice("github"); // clears notice
    await notifyCredentialInvalidated("github", "second"); // re-arms
    const result = await consumeInvalidationNotice("github");
    expect(result?.reason).toBe("second");
  });
});

describe("clearInvalidation", () => {
  it("removes the entry entirely", async () => {
    await notifyCredentialInvalidated("github", "401");
    await clearInvalidation("github");
    const list = await listInvalidations();
    expect(list).toHaveLength(0);
  });
});

describe("consumeAndReportInvalidationNotice", () => {
  function captureStderr(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      let text: string;
      if (typeof chunk === "string") {
        text = chunk;
      } else if (chunk instanceof Uint8Array) {
        text = new TextDecoder().decode(chunk);
      } else {
        text = String(chunk);
      }
      writes.push(text);
      return true;
    }) as typeof process.stderr.write;
    return {
      writes,
      restore: () => {
        process.stderr.write = originalWrite;
      },
    };
  }

  it("writes a one-line notice to stderr when a notice is pending", async () => {
    await notifyCredentialInvalidated("github", "401 from /user");
    const capture = captureStderr();
    try {
      await consumeAndReportInvalidationNotice("github");
    } finally {
      capture.restore();
    }
    expect(capture.writes).toHaveLength(1);
    expect(capture.writes[0]).toContain("credential invalidated");
    expect(capture.writes[0]).toContain("github");
    expect(capture.writes[0]).toContain("401 from /user");
    expect(capture.writes[0]).toContain("minsky config credentials add github");
    expect(capture.writes[0]?.endsWith("\n")).toBe(true);
  });

  it("does not write stderr on subsequent calls (notice consumed)", async () => {
    await notifyCredentialInvalidated("github", "401");
    const capture = captureStderr();
    try {
      await consumeAndReportInvalidationNotice("github");
      await consumeAndReportInvalidationNotice("github");
    } finally {
      capture.restore();
    }
    expect(capture.writes).toHaveLength(1);
  });

  it("does not write stderr when no invalidation is recorded", async () => {
    const capture = captureStderr();
    try {
      await consumeAndReportInvalidationNotice("github");
    } finally {
      capture.restore();
    }
    expect(capture.writes).toHaveLength(0);
  });
});
