/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp files exercise the real byte-offset, partial-line, truncation, and multibyte behavior the tailer exists to handle; mocking fs would defeat the test */
/**
 * Tests for {@link JsonlTailer} — the shared incremental byte-offset JSONL reader
 * (mt#2320 watcher + mt#2232 live render).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTailer } from "./jsonl-tailer";

describe("JsonlTailer", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jsonl-tailer-"));
    file = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads and parses complete newline-terminated lines", async () => {
    await writeFile(file, '{"a":1}\n{"a":2}\n');
    const tailer = new JsonlTailer();

    const res = await tailer.readNew<{ a: number }>(file);

    expect(res.lines).toEqual([{ a: 1 }, { a: 2 }]);
    expect(res.malformed).toBe(0);
    expect(res.pendingBytes).toBe(0);
    expect(res.reset).toBe(false);
    expect(res.offset).toBe(16);
  });

  test("does NOT consume a partial trailing line until its newline lands (SC4)", async () => {
    // A line written without a terminating newline (writer killed mid-line).
    await writeFile(file, '{"a":1}\n{"partial":');
    const tailer = new JsonlTailer();

    const first = await tailer.readNew(file);
    expect(first.lines).toEqual([{ a: 1 }]);
    expect(first.pendingBytes).toBe('{"partial":'.length);
    const offsetAfterFirst = first.offset;
    expect(offsetAfterFirst).toBe('{"a":1}\n'.length);

    // Complete the line — only now should it be surfaced.
    await appendFile(file, "2}\n");
    const second = await tailer.readNew<{ partial: number }>(file);
    expect(second.lines).toEqual([{ partial: 2 }]);
    expect(second.pendingBytes).toBe(0);
    expect(tailer.getOffset(file)).toBe('{"a":1}\n{"partial":2}\n'.length);
  });

  test("advances past already-read content on subsequent reads (no re-yield)", async () => {
    await writeFile(file, '{"n":1}\n');
    const tailer = new JsonlTailer();

    const first = await tailer.readNew(file);
    expect(first.lines).toEqual([{ n: 1 }]);

    // No new content — empty result, offset unchanged.
    const idle = await tailer.readNew(file);
    expect(idle.lines).toEqual([]);
    expect(idle.offset).toBe(first.offset);

    await appendFile(file, '{"n":2}\n{"n":3}\n');
    const third = await tailer.readNew(file);
    expect(third.lines).toEqual([{ n: 2 }, { n: 3 }]);
  });

  test("resets to offset 0 when the file shrinks (truncation / rotation)", async () => {
    await writeFile(file, '{"old":1}\n{"old":2}\n');
    const tailer = new JsonlTailer();
    await tailer.readNew(file);
    expect(tailer.getOffset(file)).toBeGreaterThan(0);

    // Truncate to empty and write fresh content.
    await truncate(file, 0);
    await writeFile(file, '{"fresh":1}\n');

    const res = await tailer.readNew<{ fresh: number }>(file);
    expect(res.reset).toBe(true);
    expect(res.lines).toEqual([{ fresh: 1 }]);
  });

  test("counts malformed lines without throwing and still returns valid ones", async () => {
    await writeFile(file, '{"ok":1}\nnot json\n{"ok":2}\n');
    const tailer = new JsonlTailer();

    const res = await tailer.readNew<{ ok: number }>(file);
    expect(res.lines).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(res.malformed).toBe(1);
  });

  test("skips blank lines", async () => {
    await writeFile(file, '{"x":1}\n\n   \n{"x":2}\n');
    const tailer = new JsonlTailer();

    const res = await tailer.readNew<{ x: number }>(file);
    expect(res.lines).toEqual([{ x: 1 }, { x: 2 }]);
    expect(res.malformed).toBe(0);
  });

  test("readNewRaw returns raw line strings without parsing", async () => {
    await writeFile(file, '{"a":1}\nnot json\n');
    const tailer = new JsonlTailer();

    const res = await tailer.readNewRaw(file);
    expect(res.rawLines).toEqual(['{"a":1}', "not json"]);
  });

  test("tracks byte offsets correctly across multibyte UTF-8 content", async () => {
    // "café" + an emoji are multibyte; offset accounting must be in bytes.
    const line1 = JSON.stringify({ msg: "café ☕" });
    const line2 = JSON.stringify({ msg: "naïve 🚀" });
    await writeFile(file, `${line1}\n`);
    const tailer = new JsonlTailer();

    const first = await tailer.readNew<{ msg: string }>(file);
    expect(first.lines).toEqual([{ msg: "café ☕" }]);
    expect(first.offset).toBe(Buffer.byteLength(`${line1}\n`, "utf-8"));

    await appendFile(file, `${line2}\n`);
    const second = await tailer.readNew<{ msg: string }>(file);
    expect(second.lines).toEqual([{ msg: "naïve 🚀" }]);
    expect(tailer.getOffset(file)).toBe(Buffer.byteLength(`${line1}\n${line2}\n`, "utf-8"));
  });

  test("setOffset seeds past pre-existing content (only tails later appends)", async () => {
    await writeFile(file, '{"history":1}\n{"history":2}\n');
    const tailer = new JsonlTailer();

    // Seed to end-of-file so existing content is skipped.
    const { size } = await Bun.file(file).stat();
    tailer.setOffset(file, size);

    const idle = await tailer.readNew(file);
    expect(idle.lines).toEqual([]);

    await appendFile(file, '{"new":1}\n');
    const res = await tailer.readNew<{ new: number }>(file);
    expect(res.lines).toEqual([{ new: 1 }]);
  });

  test("forget() and clear() drop tracked offsets", async () => {
    await writeFile(file, '{"a":1}\n');
    const tailer = new JsonlTailer();
    await tailer.readNew(file);
    expect(tailer.size).toBe(1);

    tailer.forget(file);
    expect(tailer.size).toBe(0);
    expect(tailer.getOffset(file)).toBe(0);

    // After forgetting, the file is re-read from the start.
    const res = await tailer.readNew<{ a: number }>(file);
    expect(res.lines).toEqual([{ a: 1 }]);

    tailer.clear();
    expect(tailer.size).toBe(0);
  });

  test("empty file yields no lines", async () => {
    await writeFile(file, "");
    const tailer = new JsonlTailer();
    const res = await tailer.readNew(file);
    expect(res.lines).toEqual([]);
    expect(res.offset).toBe(0);
    expect(res.pendingBytes).toBe(0);
  });
});
