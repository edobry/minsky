import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix import statements with missing comma: import { item1, item2 } from
    const importMissingCommaPattern = /import\s*\{\s*([^,\s}]+)\s+([^,\s}]+)\s*\}\s*from/g;
    if (importMissingCommaPattern.test(content)) {
      content = content.replace(importMissingCommaPattern, 'import { $1, $2  } from');
      console.log(`${filePath}: Fixed import with missing comma between, items`);
      fixCount++;
    }

    // Fix import paths missing .js extension
    const importNoExtPattern = /from\s+"([^"]+(?:commands|shared|utils|adapters|domain)\/[^"]+(?<!\.js))"/g;
    if (importNoExtPattern.test(content)) {
      content = content.replace(importNoExtPattern, 'from "$1.js"');
      console.log(`${filePath}: Fixed import missing .js, extension`);
      fixCount++;
    }

    // Fix describe/test with embedded commas: describe("name1 name2" () =>
    const describeCommaPattern = /(describe|test|it)\("([^",]+),\s*([^"]+)"/g;
    if (describeCommaPattern.test(content)) {
      content = content.replace(describeCommaPattern, '$1("$2 $3"');
      console.log(`${filePath}: Fixed test/describe with embedded, commas`);
      fixCount++;
    }

    // Fix trailing commas in function parameters
    const trailingCommaPattern = /,\s*\)/g;
    if (trailingCommaPattern.test(content)) {
      content = content.replace(trailingCommaPattern, ')');
      console.log(`${filePath}: Fixed trailing commas in function, parameters`);
      fixCount++;
    }

    // Fix multiple spaces between words that should have commas
    const multiSpacePattern = /("[^"]+)\s{2,}([^"]+"\))/g;
    if (multiSpacePattern.test(content)) {
      content = content.replace(multiSpacePattern, '$1, $2');
      console.log(`${filePath}: Fixed multiple spaces that should be, commas`);
      fixCount++;
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
