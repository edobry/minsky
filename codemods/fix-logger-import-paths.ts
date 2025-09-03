#!/usr/bin/env bun

import { Project, SourceFile, ImportDeclaration } from "ts-morph";
import { globSync } from "glob";
import path from "path";

function isLocalPath(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function isLoggerImport(spec: string): boolean {
  return /\/utils\/logger(\.(js|ts))?$/.test(spec);
}

function removeExtension(spec: string): string {
  return spec.replace(/\.(js|ts)$/, "");
}

function ensureDotPrefix(rel: string): string {
  if (!rel.startsWith(".") && !rel.startsWith("/")) return `./${rel}`;
  return rel;
}

function normalizeSlashes(p: string): string {
  return p.split(path.sep).join("/");
}

// Canonical target: always point to root src/utils/logger
function computeTargetForFile(_filePath: string, repoRoot: string): string {
  return path.join(repoRoot, "src", "utils", "logger.ts");
}

async function run(): Promise<void> {
  const repoRoot = process.cwd();
  const project = new Project({
    tsConfigFilePath: path.join(repoRoot, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });

  const files = [
    ...globSync("src/**/*.ts", {
      ignore: ["**/*.d.ts", "**/node_modules/**", "**/dist/**", "**/build/**"],
    }),
    ...globSync("src/**/*.tsx", {
      ignore: ["**/*.d.ts", "**/node_modules/**", "**/dist/**", "**/build/**"],
    }),
    ...globSync("src/**/*.js", { ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"] }),
  ];

  project.addSourceFilesAtPaths(files);

  let modifiedFiles = 0;
  let modifiedImports = 0;

  const sourceFiles: SourceFile[] = project.getSourceFiles();
  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    let fileChanged = false;
    const imports: ImportDeclaration[] = sf.getImportDeclarations();
    for (const imp of imports) {
      let spec: string | undefined;
      try {
        spec = imp.getModuleSpecifierValue();
      } catch {
        continue; // non-literal or malformed, skip safely
      }
      if (!spec) continue;
      if (!isLocalPath(spec)) continue;
      if (!isLoggerImport(spec)) continue;

      const targetAbs = computeTargetForFile(filePath, repoRoot);
      const rel = path.relative(path.dirname(filePath), targetAbs);
      const relNoExt = removeExtension(rel);
      const normalized = ensureDotPrefix(normalizeSlashes(relNoExt));

      if (normalized !== spec) {
        imp.setModuleSpecifier(normalized);
        fileChanged = true;
        modifiedImports++;
      }
    }

    if (fileChanged) modifiedFiles++;
  }

  await project.save();
  console.log(
    `fix-logger-import-paths: modified ${modifiedImports} imports across ${modifiedFiles} files`
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
