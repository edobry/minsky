/**
 * mt#5063 SC6 / mt#5067 SC5 — tests for the bundle-portability registry check.
 *
 * The script's value depends entirely on its ability to FAIL, so these exercise the
 * non-clean branches directly rather than only the happy path a fixed build produces.
 * `auditBundle` is pure over a string, so no build and no filesystem is touched.
 */
import { describe, it, expect } from "bun:test";

import { auditBundle, packageOfBakedPath, RETIRED_BAKES } from "./verify-bundle-portability";

/** The literal bun emits for a bundled CJS module, with the builder's own absolute path. */
function baked(absPath: string, identifier: "__dirname" | "__filename" = "__dirname"): string {
  return `var ${identifier}="${absPath}",x=1;`;
}

/** The one registered bake (mt#5067): braintrust's label-only `__filename`. */
const KNOWN = "/somewhere/node_modules/braintrust/dist/index.mjs";
/** The package mt#5063 exists for — externalised, so it must never reappear. */
const TIKTOKEN = "/home/runner/work/minsky/minsky/node_modules/tiktoken";

describe("mt#5063 — packageOfBakedPath", () => {
  it("returns the path after the LAST node_modules segment", () => {
    // Nested installs are real: the last segment is the package that actually loaded.
    expect(packageOfBakedPath("/a/node_modules/b/node_modules/tiktoken")).toBe("tiktoken");
  });

  it("keeps the subdirectory, because that is what distinguishes the entries", () => {
    // `esbuild/lib` and a hypothetical `esbuild/bin` are different bakes.
    expect(packageOfBakedPath("/somewhere/node_modules/esbuild/lib")).toBe("esbuild/lib");
  });

  it("keeps the FILE for a __filename bake, so it is a distinct key from its directory", () => {
    expect(packageOfBakedPath(KNOWN)).toBe("braintrust/dist/index.mjs");
  });

  it("returns null for a path with no node_modules segment", () => {
    // Not silently dropped — auditBundle reports these as unknown findings.
    expect(packageOfBakedPath("/opt/app/dist")).toBeNull();
  });
});

describe("mt#5063 — auditBundle", () => {
  it("passes a bundle whose only bake is registered", () => {
    const audit = auditBundle(baked(KNOWN, "__filename"));
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
    const audit = auditBundle(
      `${baked(KNOWN, "__filename")}${baked(TIKTOKEN)}${baked(KNOWN, "__filename")}`
    );
    expect(audit.total).toBe(3);
    expect(audit.findings.map((f) => f.pkg)).toEqual(["tiktoken"]);
  });

  it("a bundle with no baked path is clean and reports zero", () => {
    // The end-state this task is driving toward; must not be mistaken for a broken matcher.
    const audit = auditBundle("var x=1;const y=__dirname;const z=__filename;");
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
    const audit = auditBundle(
      String.raw`var __filename="C:\b\node_modules\braintrust\dist\index.mjs";`
    );
    expect(audit.findings).toEqual([]);
  });

  it("does not match a bare __dirname reference — only an assignment to a literal", () => {
    // `__dirname` used at runtime is fine and is the PORTABLE form; flagging it would make
    // the check fire on correct code.
    const audit = auditBundle('path.join(__dirname,"./asset.wasm")');
    expect(audit.total).toBe(0);
  });
});

describe("mt#5067 — __filename is a bake too", () => {
  // Until mt#5067 the matcher read `__dirname` only, and typescript's default-lib lookup
  // walks from `__filename`. A check that cannot see half the class passes a bundle that
  // still pins that lookup to the build host.

  it("FAILS on an unregistered __filename bake, and says which identifier it was", () => {
    const audit = auditBundle(
      baked("/build/node_modules/typescript/lib/typescript.js", "__filename")
    );
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]).toEqual({
      identifier: "__filename",
      path: "/build/node_modules/typescript/lib/typescript.js",
      pkg: "typescript/lib/typescript.js",
    });
  });

  it("carries the identifier on a __dirname finding as well", () => {
    const audit = auditBundle(baked(TIKTOKEN));
    expect(audit.findings[0]?.identifier).toBe("__dirname");
  });

  it("registration is keyed on the exact baked path, so a directory entry does not cover its file", () => {
    // `braintrust/dist/index.mjs` is registered; `braintrust/dist` is not. A `__dirname` bake
    // for the same package would be a NEW decision, not covered by the file's ruling.
    const audit = auditBundle(baked("/build/node_modules/braintrust/dist"));
    expect(audit.findings.map((f) => f.pkg)).toEqual(["braintrust/dist"]);
  });

  it("every RETIRED bake is a finding — a decided fix must not silently regress", () => {
    // tiktoken, @pnpm/tabtab, typescript, esbuild, rollup were ruled on by REMOVAL
    // (`--external`), so none is registered and each reappearing is a failure.
    expect(RETIRED_BAKES.length).toBeGreaterThan(0);
    for (const pkg of RETIRED_BAKES) {
      const identifier = pkg.endsWith(".js") ? "__filename" : "__dirname";
      const audit = auditBundle(baked(`/build/node_modules/${pkg}`, identifier));
      expect(audit.findings.map((f) => f.pkg)).toEqual([pkg]);
    }
  });
});
