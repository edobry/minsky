import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import {
  findFirstNulByteOffset,
  isPathAllowlisted,
  isOverrideTruthy,
  detectNulByteViolations,
  KNOWN_BINARY_EXTENSIONS,
  NUL_BYTE_CHECK_OVERRIDE_ENV,
} from "./nul-byte-detector";

/**
 * Build a Buffer from mixed string + byte-number segments without using
 * `Buffer.concat` / `Buffer.alloc` — the project's TS Buffer stub only
 * exposes `Buffer.from(string | array)`. Each string segment is interpreted
 * as ASCII (charCodeAt) which is fine for the test corpus.
 */
function mkBuf(...parts: Array<string | number>): Buffer {
  const bytes: number[] = [];
  for (const p of parts) {
    if (typeof p === "number") {
      bytes.push(p);
    } else {
      for (let i = 0; i < p.length; i++) bytes.push(p.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

describe("findFirstNulByteOffset", () => {
  test("returns null for ASCII text", () => {
    expect(findFirstNulByteOffset(Buffer.from("hello world"))).toBeNull();
  });

  test("returns null for empty buffer", () => {
    expect(findFirstNulByteOffset(Buffer.from([]))).toBeNull();
  });

  test("returns offset of single NUL byte mid-buffer", () => {
    // 'abc' + NUL + 'def'  =>  NUL at offset 3
    expect(findFirstNulByteOffset(mkBuf("abc", 0, "def"))).toBe(3);
  });

  test("returns offset of FIRST NUL when multiple are present", () => {
    // 'xx' + NUL*3 + 'yy'  =>  first NUL at offset 2
    expect(findFirstNulByteOffset(mkBuf("xx", 0, 0, 0, "yy"))).toBe(2);
  });

  test("detects NUL byte at offset 0", () => {
    expect(findFirstNulByteOffset(mkBuf(0, "abc"))).toBe(0);
  });

  test("detects NUL byte at end of buffer", () => {
    expect(findFirstNulByteOffset(mkBuf("abc", 0))).toBe(3);
  });
});

describe("isPathAllowlisted", () => {
  test("source-code paths are NOT allowlisted", () => {
    expect(isPathAllowlisted("src/foo.ts")).toBe(false);
    expect(isPathAllowlisted("src/hooks/pre-commit.ts")).toBe(false);
    expect(isPathAllowlisted("scripts/build.js")).toBe(false);
    expect(isPathAllowlisted("README.md")).toBe(false);
    expect(isPathAllowlisted("docs/architecture.md")).toBe(false);
  });

  test("known-binary extensions are allowlisted", () => {
    expect(isPathAllowlisted("logo.png")).toBe(true);
    expect(isPathAllowlisted("font.woff2")).toBe(true);
    expect(isPathAllowlisted("dist/bundle.so")).toBe(true);
    expect(isPathAllowlisted("data.bin")).toBe(true);
    expect(isPathAllowlisted("archive.zip")).toBe(true);
  });

  test("extension match is case-insensitive", () => {
    expect(isPathAllowlisted("LOGO.PNG")).toBe(true);
    expect(isPathAllowlisted("Photo.JPG")).toBe(true);
    expect(isPathAllowlisted("Font.WOFF2")).toBe(true);
  });

  test("tests/fixtures/ prefix is allowlisted", () => {
    expect(isPathAllowlisted("tests/fixtures/nul-byte-source.ts")).toBe(true);
    expect(isPathAllowlisted("tests/fixtures/subdir/foo.ts")).toBe(true);
    expect(isPathAllowlisted("tests/fixtures/anything.txt")).toBe(true);
  });

  test("near-miss paths are NOT allowlisted", () => {
    expect(isPathAllowlisted("src/tests/foo.ts")).toBe(false);
    expect(isPathAllowlisted("tests/unit/foo.ts")).toBe(false);
    expect(isPathAllowlisted("tests/fixtures-like/foo.ts")).toBe(false);
  });

  test("files with no extension are not allowlisted", () => {
    expect(isPathAllowlisted("LICENSE")).toBe(false);
    expect(isPathAllowlisted("Dockerfile")).toBe(false);
    expect(isPathAllowlisted("Makefile")).toBe(false);
  });

  test("KNOWN_BINARY_EXTENSIONS is non-empty and well-formed", () => {
    expect(KNOWN_BINARY_EXTENSIONS.size).toBeGreaterThan(10);
    for (const ext of KNOWN_BINARY_EXTENSIONS) {
      expect(ext.startsWith(".")).toBe(true);
      expect(ext.toLowerCase()).toBe(ext);
    }
  });
});

describe("isOverrideTruthy", () => {
  test("undefined and empty return false", () => {
    expect(isOverrideTruthy(undefined)).toBe(false);
    expect(isOverrideTruthy("")).toBe(false);
  });

  test("truthy strings return true", () => {
    expect(isOverrideTruthy("1")).toBe(true);
    expect(isOverrideTruthy("true")).toBe(true);
    expect(isOverrideTruthy("TRUE")).toBe(true);
    expect(isOverrideTruthy("yes")).toBe(true);
    expect(isOverrideTruthy("Yes")).toBe(true);
  });

  test("falsy strings return false", () => {
    expect(isOverrideTruthy("0")).toBe(false);
    expect(isOverrideTruthy("false")).toBe(false);
    expect(isOverrideTruthy("no")).toBe(false);
    expect(isOverrideTruthy("nope")).toBe(false);
  });

  test("override env var name is the documented constant", () => {
    expect(NUL_BYTE_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_NUL_CHECK");
  });
});

describe("detectNulByteViolations", () => {
  test("returns empty array for clean source files", () => {
    const m = new Map<string, Buffer>([
      ["src/foo.ts", Buffer.from("export const x = 1;")],
      ["README.md", Buffer.from("# Hello")],
      ["scripts/build.js", Buffer.from('console.log("ok")')],
    ]);
    expect(detectNulByteViolations(m)).toEqual([]);
  });

  test("flags TypeScript file with mid-content NUL byte (AT1 shape)", () => {
    const m = new Map<string, Buffer>([["src/foo.ts", mkBuf("export const SEP = ", 0, ";")]]);
    const result = detectNulByteViolations(m);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "src/foo.ts", offset: 19 });
  });

  test("skips binary files even when they contain NUL bytes (AT2)", () => {
    // PNG signature + IHDR chunk-length 00 00 00 0D — multiple NUL bytes.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const woff = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
    const m = new Map<string, Buffer>([
      ["assets/logo.png", png],
      ["fonts/icons.woff2", woff],
    ]);
    expect(detectNulByteViolations(m)).toEqual([]);
  });

  test("skips tests/fixtures/ paths even when they contain NUL bytes", () => {
    const m = new Map<string, Buffer>([
      ["tests/fixtures/nul-byte-source.ts", mkBuf("foo", 0, "bar")],
    ]);
    expect(detectNulByteViolations(m)).toEqual([]);
  });

  test("reports multiple violations in deterministic order", () => {
    const m = new Map<string, Buffer>([
      ["a.ts", mkBuf("x", 0)],
      ["b.ts", Buffer.from("clean")],
      ["c.ts", mkBuf(0, "y")],
    ]);
    expect(detectNulByteViolations(m)).toEqual([
      { path: "a.ts", offset: 1 },
      { path: "c.ts", offset: 0 },
    ]);
  });

  test("violation offset matches FIRST NUL when file contains many", () => {
    const m = new Map<string, Buffer>([
      ["src/many-nuls.ts", mkBuf("prefix", 0, 0, 0, 0, "middle", 0, "end")],
    ]);
    expect(detectNulByteViolations(m)).toEqual([{ path: "src/many-nuls.ts", offset: 6 }]);
  });
});

describe("real fixture file (AT1, AT5)", () => {
  test("tests/fixtures/nul-byte-source.ts contains a NUL byte on disk", async () => {
    const fixturePath = resolve(
      import.meta.dir,
      "..",
      "..",
      "tests",
      "fixtures",
      "nul-byte-source.ts"
    );
    // Use Bun.file().bytes() — returns Uint8Array, which Buffer.indexOf
    // accepts at runtime. This sidesteps the `no-real-fs-in-tests` rule's
    // ban on `fs/promises` (the rule is right that most tests shouldn't
    // touch the filesystem; THIS test's job is specifically to verify
    // that the on-disk fixture really contains a NUL byte, AT1+AT5).
    const bytes = await Bun.file(fixturePath).bytes();
    const buf = Buffer.from(bytes as unknown as number[]);
    const offset = findFirstNulByteOffset(buf);
    expect(offset).not.toBeNull();
    expect(offset).toBeGreaterThan(0);
  });

  test("the fixture path is allowlisted (so it does not block its own staging)", () => {
    expect(isPathAllowlisted("tests/fixtures/nul-byte-source.ts")).toBe(true);
  });
});
