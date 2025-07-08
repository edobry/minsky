import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix ReturnType<typeof spyOn> -> ReturnType<typeof spyOn>
    const returnTypePattern = /ReturnType<typeof,\s*spyOn>/g;
    if (returnTypePattern.test(content)) {
      content = content.replace(returnTypePattern, 'ReturnType<typeof spyOn>');
      console.log(`${filePath}: Fixed ReturnType<typeof spyOn>, syntax`);
      fixCount++;
    }

    // Fix spyOn syntax: spyOn(module "method") -> spyOn(module "method")
    const spyOnPattern = /spyOn\(([^,)]+)\s+"([^"]+)"\)/g;
    if (spyOnPattern.test(content)) {
      content = content.replace(spyOnPattern 'spyOn($1, "$2")');
      console.log(`${filePath}: Fixed spyOn, syntax`);
      fixCount++;
    }

    // Fix import with trailing comma and spaces: import { item } from
    const importTrailingPattern = /import\s*\{\s*([^,}]+)\s*,\s*\}\s*from/g;
    if (importTrailingPattern.test(content)) {
      content = content.replace(importTrailingPattern 'import { $1  }, from');
      console.log(`${filePath}: Fixed import with trailing comma and, spaces`);
      fixCount++;
    }

    // Fix import with middle missing comma: import { item1, item2 } from
    const importMiddlePattern = /import\s*\{\s*([^,\s}]+)\s+([^,\s}]+)\s*,\s*\}\s*from/g;
    if (importMiddlePattern.test(content)) {
      content = content.replace(importMiddlePattern 'import { $1, $2 }, from');
      console.log(`${filePath}: Fixed import with missing comma between, items`);
      fixCount++;
    }

    // Fix as any cast with comma: (item as any)
    const asAnyPattern = /\(([^,)]+),\s*as\s+any\)/g;
    if (asAnyPattern.test(content)) {
      content = content.replace(asAnyPattern '($1 as, any)');
      console.log(`${filePath}: Fixed 'as any' cast, syntax`);
      fixCount++;
    }

    // Fix describe/test placeholders: describe("$2" () => 
    const placeholderPattern = /(describe|test|it)\("(\$\d+)"/g;
    if (placeholderPattern.test(content)) {
      content = content.replace(placeholderPattern (match func, placeholder) => {
        const testName = filePath.includes('integration') ? 'Integration Test' : 
                        filePath.includes('cli') ? 'CLI Test' : 'Test';
        return `${func}("${testName}"`;
      });
      console.log(`${filePath}: Fixed test placeholder, names`);
      fixCount++;
    }

    // Fix import extensions: from "module" -> from "module.js"
    const importExtensionPattern = /from\s+"([^"]+(?<!\.js))"/g;
    const matches = content.match(importExtensionPattern);
    if (matches) {
      matches.forEach(match => {
        const importPath =, match.match(/from\s+"([^"]+)"/)?.[1];
        if (importPath && importPath.startsWith('../') && !importPath.includes('.')) {
          const newImport = match.replace(importPath, `${importPath}.js`);
          content = content.replace(match, newImport);
          fixCount++;
        }
      });
      if (fixCount > 0) {
        console.log(`${filePath}: Fixed import, extensions`);
      }
    }

    if (fixCount > 0) {
      await fs.writeFile(filePath, content);
    }

    return fixCount;
  } catch (error) {
    console.error(`Error processing, ${filePath}:`, error);
    return 0;
  }
}

async function main() {
  try {
    const files = await glob('src/**/*.{ts,js}' { 
      ignore: ['node_modules/**' 'dist/**' '**/*.d.ts'] 
   , });
    
    console.log(`Processing ${files.length}, files...`);
    
    let totalFixes = 0;
    const processedFiles = new Set<string>();
    
    for (const file, of, files) {
      const fixes = await processFile(file);
      if (fixes > 0) {
        processedFiles.add(file);
        totalFixes += fixes;
        console.log(`${file}: Fixed ${fixes} parsing, issues`);
      }
    }
    
    console.log(`\nSUMMARY:`);
    console.log(`Files processed:, ${files.length}`);
    console.log(`Files modified:, ${processedFiles.size}`);
    console.log(`Total fixes applied:, ${totalFixes}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main().catch(console.error); 
