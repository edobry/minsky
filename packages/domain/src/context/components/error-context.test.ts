/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: the component runs the real
   TypeScript compiler over real files under src/, and the defect this regresses (mt#5084) is the
   checker throwing on a SourceFile the program never bound — mocking fs would leave the program
   nothing to parse, so the throw could never be observed */
/**
 * Regression tests for the error-context component's diagnostics path (mt#5084).
 *
 * Before the fix, `gatherInputs` handed `ts.getPreEmitDiagnostics` a SourceFile it had parsed
 * itself with `ts.createSourceFile` rather than the program's own, so the checker dereferenced an
 * unbound symbol and threw on every file. The per-file catch turned that into an `analysis-error`
 * warning, and the component reported "0 errors, N warnings" for any workspace.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ErrorContextComponent, type ErrorContextInputs } from "./error-context";

const VALID_FILE = `export const doubled: number[] = [1, 2, 3].map((n) => n * 2);
export const later: Promise<string> = Promise.resolve("ok");
console.log(doubled.length, JSON.stringify({ ok: true }));
`;

const TYPE_ERROR_FILE = `const n: number = "x";
export { n };
`;

const createdRoots: string[] = [];

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mt5084-error-context-"));
  createdRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  return root;
}

async function gather(workspacePath: string): Promise<ErrorContextInputs> {
  return (await ErrorContextComponent.gatherInputs({ workspacePath })) as ErrorContextInputs;
}

afterAll(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("ErrorContextComponent.gatherInputs (mt#5084)", () => {
  test("a valid TypeScript file yields no diagnostics and no analysis-error warning", async () => {
    const root = await makeWorkspace({ "src/sample.ts": VALID_FILE });

    const inputs = await gather(root);

    expect(inputs.runtimeErrors).toEqual([]);
    expect(inputs.typeScriptErrors).toEqual([]);
    expect(inputs.totalErrors).toBe(0);
    expect(inputs.totalWarnings).toBe(0);
  });

  test("a real type error is reported as an error carrying its TS code", async () => {
    const root = await makeWorkspace({ "src/sample.ts": TYPE_ERROR_FILE });

    const inputs = await gather(root);

    expect(inputs.runtimeErrors).toEqual([]);
    expect(inputs.typeScriptErrors).toHaveLength(1);
    const [diagnostic] = inputs.typeScriptErrors;
    expect(diagnostic?.file).toBe("src/sample.ts");
    expect(diagnostic?.line).toBe(1);
    expect(diagnostic?.code).toBe(2322);
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.source).toBe("typescript");
    expect(diagnostic?.category).toBe("type-mismatch");
    expect(inputs.totalErrors).toBe(1);
    expect(inputs.totalWarnings).toBe(0);
  });

  test("an imported file's error is attributed to that file, not to its importer", async () => {
    const root = await makeWorkspace({
      "src/dep.ts": `export const bad: number = "x";\n`,
      "src/sample.ts": `import { bad } from "./dep";\nexport const ok: number = bad + 1;\n`,
    });

    const inputs = await gather(root);

    expect(inputs.runtimeErrors).toEqual([]);
    expect(inputs.typeScriptErrors.map((error) => error.file)).toEqual(["src/dep.ts"]);
    expect(inputs.typeScriptErrors[0]?.code).toBe(2322);
  });
});
