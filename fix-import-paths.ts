#!/usr/bin/env bun
/**
 * Script to fix import path issues in test files
 * This addresses Phase 2 of task 276 - Import Path Resolution
 */

import { readdir, readFile, writeFile, stat } from "fs/promises";
import { join, dirname, relative } from "path";

interface ImportFix {
  pattern: RegExp;
  replacement: string;
  description: string;
}

const importFixes: ImportFix[] = [
  // Session imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/session['"]/g,
    replacement: "import $1 from \"./session.js\"",
    description: "Fix ../session imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/session\.ts['"]/g,
    replacement: "import $1 from \"./session.js\"",
    description: "Fix ../session.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/session\.js['"]/g,
    replacement: "import $1 from \"./session.js\"",
    description: "Fix ../session.js imports"
  },
  // Git imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/git['"]/g,
    replacement: "import $1 from \"./git.js\"",
    description: "Fix ../git imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/git\.ts['"]/g,
    replacement: "import $1 from \"./git.js\"",
    description: "Fix ../git.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/git\.js['"]/g,
    replacement: "import $1 from \"./git.js\"",
    description: "Fix ../git.js imports"
  },
  // Workspace imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/workspace['"]/g,
    replacement: "import $1 from \"./workspace.js\"",
    description: "Fix ../workspace imports"
  },
  // Tasks imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/tasks['"]/g,
    replacement: "import $1 from \"./tasks.js\"",
    description: "Fix ../tasks imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/tasks\.js['"]/g,
    replacement: "import $1 from \"./tasks.js\"",
    description: "Fix ../tasks.js imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/tasks\/taskConstants['"]/g,
    replacement: "import $1 from \"./tasks/taskConstants.js\"",
    description: "Fix ../tasks/taskConstants imports"
  },
  // Repository imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/repository-uri\.ts['"]/g,
    replacement: "import $1 from \"./repository-uri.js\"",
    description: "Fix ../repository-uri.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/repository\/github\.ts['"]/g,
    replacement: "import $1 from \"./repository/github.js\"",
    description: "Fix ../repository/github.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/repository\/github\.js['"]/g,
    replacement: "import $1 from \"./repository/github.js\"",
    description: "Fix ../repository/github.js imports"
  },
  // URI Utils imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/uri-utils\.js['"]/g,
    replacement: "import $1 from \"./uri-utils.js\"",
    description: "Fix ../uri-utils.js imports"
  },
  // Error imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/errors\/index\.ts['"]/g,
    replacement: "import $1 from \"../errors/index.js\"",
    description: "Fix ../../errors/index.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/errors\/index\.js['"]/g,
    replacement: "import $1 from \"../errors/index.js\"",
    description: "Fix ../../errors/index.js imports"
  },
  // Utils imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/utils\/test-utils\/mocking\.ts['"]/g,
    replacement: "import $1 from \"../utils/test-utils/mocking.js\"",
    description: "Fix ../../utils/test-utils/mocking.ts imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/utils\/test-utils\/mocking['"]/g,
    replacement: "import $1 from \"../utils/test-utils/mocking.js\"",
    description: "Fix ../../utils/test-utils/mocking imports"
  },
  // Command imports
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/\.\.\/adapters\/shared\/command-registry\.js['"]/g,
    replacement: "import $1 from \"../../../adapters/shared/command-registry.js\"",
    description: "Fix command-registry imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/\.\.\/adapters\/cli\/integration-example\.js['"]/g,
    replacement: "import $1 from \"../../../adapters/cli/integration-example.js\"",
    description: "Fix integration-example imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/\.\.\/utils\/rules-helpers\.js['"]/g,
    replacement: "import $1 from \"../../../utils/rules-helpers.js\"",
    description: "Fix rules-helpers imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/\.\.\/domain\/session\.js['"]/g,
    replacement: "import $1 from \"../../../domain/session.js\"",
    description: "Fix domain/session imports"
  },
  // Task constants
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/\.\.\/\.\.\/\.\.\/domain\/tasks\/taskConstants['"]/g,
    replacement: "import $1 from \"../../../../domain/tasks/taskConstants.js\"",
    description: "Fix taskConstants imports"
  },
  {
    pattern: /import\s+(.+?)\s+from\s+['"]\.\.\/sessiondb['"]/g,
    replacement: "import $1 from \"./sessiondb.js\"",
    description: "Fix sessiondb imports"
  }
];

async function findTestFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  async function traverse(currentDir: string) {
    const entries = await readdir(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stats = await stat(fullPath);
      
      if (stats.isDirectory()) {
        // Skip node_modules and other non-source directories
        if (!entry.startsWith(".") && !["node_modules", "dist", "build"].includes(entry)) {
          await traverse(fullPath);
        }
      } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.js")) {
        files.push(fullPath);
      }
    }
  }
  
  await traverse(dir);
  return files;
}

async function fixImportsInFile(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf-8");
    let modified = false;
    let newContent = content;
    
    for (const fix of importFixes) {
      const matches = content.match(fix.pattern);
      if (matches) {
        console.log(`  ${fix.description}: ${matches.length} matches`);
        newContent = newContent.replace(fix.pattern, fix.replacement);
        modified = true;
      }
    }
    
    if (modified) {
      await writeFile(filePath, newContent, "utf-8");
      console.log(`✅ Fixed imports in ${filePath}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
    return false;
  }
}

async function main() {
  const startDir = process.cwd();
  console.log(`🔍 Searching for test files in ${startDir}`);
  
  const testFiles = await findTestFiles(startDir);
  console.log(`📁 Found ${testFiles.length} test files`);
  
  let fixedCount = 0;
  let totalCount = 0;
  
  for (const file of testFiles) {
    totalCount++;
    console.log(`\n📝 Processing ${file}...`);
    
    const wasFixed = await fixImportsInFile(file);
    if (wasFixed) {
      fixedCount++;
    }
  }
  
  console.log("\n🎉 Summary:");
  console.log(`   Total files processed: ${totalCount}`);
  console.log(`   Files with fixes: ${fixedCount}`);
  console.log(`   Files unchanged: ${totalCount - fixedCount}`);
}

if (import.meta.main) {
  main().catch(console.error);
} 
