/**
 * The MCP surface must state Minsky's real version (mt#5029).
 *
 * `package.json` is read off DISK here rather than imported, so the assertion is
 * not tautological: comparing the constant against the same import it is built
 * from would pass no matter what. Reading the file independently is what makes
 * a re-introduced literal fail.
 */

import { describe, test, expect } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- The subject of these assertions
 * IS the real files: whether the constant matches the version `package.json`
 * actually carries on disk, and whether the call sites still contain a literal.
 * Injecting a filesystem would make every assertion a statement about the mock's
 * contents, which is exactly the substitution that lets a hardcoded version pass
 * a green suite — the defect this task exists to fix. Same reasoning and same
 * disable as mt#5018's AT4, where mocking `git clone` would have asserted the
 * mock rather than what a clone does to a real working tree. Reads only; nothing
 * here writes. */
import { readFileSync } from "fs";
import { join } from "path";
import { MCP_ADVERTISED_VERSION } from "./advertised-version";

/** The repo's package.json, read from disk — the independent source of truth. */
function packageVersionFromDisk(): string {
  const packageJsonPath = join(import.meta.dir, "..", "..", "..", "package.json");
  // `String(...)`: this tsconfig resolves readFileSync to the `string | Buffer`
  // overload even with an encoding, and a utf8 Buffer stringifies to the same
  // text, so this normalises without asserting a type the compiler rejects.
  const raw = String(readFileSync(packageJsonPath, { encoding: "utf8" }));
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json at ${packageJsonPath} has no usable version`);
  }
  return parsed.version;
}

describe("mt#5029 SC2 — the advertised MCP version tracks package.json", () => {
  test("equals the version package.json actually carries on disk", () => {
    expect(MCP_ADVERTISED_VERSION).toBe(packageVersionFromDisk());
  });

  test("is not the 1.0.0 literal this task removed", () => {
    // The exact value that shipped for four releases. A revert to a hardcoded
    // version is overwhelmingly likely to restore this one, so name it.
    expect(MCP_ADVERTISED_VERSION).not.toBe("1.0.0");
  });

  test("is a non-empty semver-shaped string, so a handshake cannot advertise nothing", () => {
    expect(MCP_ADVERTISED_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("mt#5029 SC3/SC4 — the call sites read the constant, not a literal", () => {
  const here = import.meta.dir;
  const read = (file: string): string =>
    String(readFileSync(join(here, file), { encoding: "utf8" }));

  test("start-command no longer carries the TODO or the literal", () => {
    const source = read("start-command.ts");
    expect(source).not.toContain("TODO: Import from package.json");
    expect(source).toContain("version: MCP_ADVERTISED_VERSION");
  });

  test("tools-command's product clientInfo reads the constant", () => {
    const source = read("tools-command.ts");
    expect(source).toContain('clientInfo: { name: "minsky-cli", version: MCP_ADVERTISED_VERSION }');
  });

  test("neither MCP command file still hardcodes a 1.0.0 version field", () => {
    for (const file of ["start-command.ts", "tools-command.ts"]) {
      expect(read(file)).not.toMatch(/version:\s*"1\.0\.0"/);
    }
  });
});
