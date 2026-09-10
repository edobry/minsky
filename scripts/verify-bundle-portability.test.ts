/**
 * mt#5063 SC6 — tests for the bundle-portability registry check.
 *
 * The script's value depends entirely on its ability to FAIL, so these exercise the
 * non-clean branches directly rather than only the happy path a fixed build produces.
 * `auditBundle` is pure over a string, so no build and no filesystem is touched.
 */
import { describe, it, expect } from "bun:test";

import { auditBundle, packageOfBakedPath } from "./verify-bundle-portability";

/** The literal bun emits for a bundled CJS module, with the builder's own absolute path. */
function baked(absPath: string): string {
  return `var __dirname="${absPath}",x=1;`;
}

/** A registered package, so a fixture can be clean without being empty. */
const KNOWN = "/somewhere/node_modules/esbuild/lib";
/** The package this whole task exists for — externalised, so it must never reappear. */
const TIKTOKEN = "/home/runner/work/minsky/minsky/node_modules/tiktoken";

describe("mt#5063 — packageOfBakedPath", () => {
  it("returns the path after the LAST node_modules segment", () => {
    // Nested installs are real: the last segment is the package that actually loaded.
    expect(packageOfBakedPath("/a/node_modules/b/node_modules/tiktoken")).toBe("tiktoken");
  });

  it("keeps the subdirectory, because that is what distinguishes the entries", () => {
    // `esbuild/lib` and a hypothetical `esbuild/bin` are different bakes.
    expect(packageOfBakedPath(KNOWN)).toBe("esbuild/lib");
  });

  it("returns null for a path with no node_modules segment", () => {
    // Not silently dropped — auditBundle reports these as unknown findings.
    expect(packageOfBakedPath("/opt/app/dist")).toBeNull();
  });
});

describe("mt#5063 — auditBundle", () => {
  it("passes a bundle whose only baked __dirname is registered", () => {
    const audit = auditBundle(baked(KNOWN));
    expect(audit.total).toBe(1);
    expect(audit.findings).toEqual([]);
  });

  it("FAILS on tiktoken — the regression this check exists to prevent", () => {
    // If tiktoken is ever re-bundled, `minsky --help` breaks for every user again.
    const audit = auditBundle(baked(TIKTOKEN));
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.pkg).toBe("tiktoken");
  });

  it("FAILS on a NEW package nobody has dispositioned", () => {
    const audit = auditBundle(baked("/build/node_modules/some-new-pkg/lib"));
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.pkg).toBe("some-new-pkg/lib");
  });

  it("reports a baked path with no node_modules segment rather than ignoring it", () => {
    // Guards the silent-drop mode: an unrecognised SHAPE must not read as clean.
    const audit = auditBundle(baked("/opt/app/dist"));
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.pkg).toBeNull();
  });

  it("counts every bake and flags only the unregistered ones", () => {
    const audit = auditBundle(`${baked(KNOWN)}${baked(TIKTOKEN)}${baked(KNOWN)}`);
    expect(audit.total).toBe(3);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("a bundle with no baked __dirname is clean and reports zero", () => {
    // The end-state this task is driving toward; must not be mistaken for a broken matcher.
    const audit = auditBundle("var x=1;const y=__dirname;");
    expect(audit.total).toBe(0);
    expect(audit.findings).toEqual([]);
  });

  // ── PR #3706 R1: the matcher must not be brittle on emitter variants ───────
  //
  // Quoting style and path separator are the BUNDLER's choice, not a contract.
  // A matcher that silently sees nothing when either changes is a check that
  // cannot fail — the failure mode this whole file exists to argue against.

  it("catches a single-quoted bake", () => {
    const audit = auditBundle(`var __dirname='${TIKTOKEN}';`);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("catches a backtick-quoted bake", () => {
    const audit = auditBundle(`var __dirname=\`${TIKTOKEN}\`;`);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("catches a Windows-style bake with backslash separators", () => {
    // A `/`-only matcher returns null here and reports "no node_modules segment"
    // instead of `tiktoken` — letting the guarded regression through on Windows.
    const audit = auditBundle(String.raw`var __dirname="C:\build\node_modules\tiktoken";`);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("an apostrophe inside a double-quoted path does not truncate the capture", () => {
    // The backreference pins the closing quote to the opening one. Without it the
    // path would be cut at the apostrophe and mis-resolve to the wrong package.
    const audit = auditBundle(`var __dirname="/Users/o'brien/node_modules/tiktoken";`);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("still resolves a registered package under backslash separators", () => {
    // The normalisation must not turn a KNOWN entry into a false finding either.
    const audit = auditBundle(String.raw`var __dirname="C:\b\node_modules\esbuild\lib";`);
    expect(audit.findings).toEqual([]);
  });

  it("does not match a bare __dirname reference — only an assignment to a literal", () => {
    // `__dirname` used at runtime is fine and is the PORTABLE form; flagging it would make
    // the check fire on correct code.
    const audit = auditBundle('path.join(__dirname,"./asset.wasm")');
    expect(audit.total).toBe(0);
  });
});
