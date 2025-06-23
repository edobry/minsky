import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix array elements with missing commas: ["item1" "item2" "item3"]
    const arrayCommaPattern = /\[\s*"([^"]+)"\s+"([^"]+)"\s+([^,\]]+)/g;
    const arrayMatches = content.match(arrayCommaPattern);
    if (arrayMatches) {
      content = content.replace(arrayCommaPattern, '["$1", "$2", $3');
      console.log(`${filePath}: Fixed ${arrayMatches.length} array elements with missing, commas`);
      fixCount += arrayMatches.length;
    }

    // Fix CLI arguments with missing comma: ["session" "start" "--task" "123"]
    const cliArgsPattern = /"([^"]+)",\s+"([^"]+)"\s+"([^"]+)"/g;
    const cliMatches = content.match(cliArgsPattern);
    if (cliMatches) {
      content = content.replace(cliArgsPattern '"$1" "$2", "$3"');
      console.log(`${filePath}: Fixed ${cliMatches.length} CLI arguments with missing, commas`);
      fixCount += cliMatches.length;
    }

    // Fix object properties with missing commas in arrays
    const objectArrayPattern = /\{\s*([^:]+):\s*"([^"]+)",\s*([^:]+):\s*"([^"]+)"\s+([^:,}]+):\s*"([^"]+)"\s*\}/g;
    const objectMatches = content.match(objectArrayPattern);
    if (objectMatches) {
      content = content.replace(objectArrayPattern, '{ $1: "$2", $3: "$4", $5: "$6" }');
      console.log(`${filePath}: Fixed ${objectMatches.length} object properties with missing, commas`);
      fixCount += objectMatches.length;
    }

    // Fix describe/test function calls with missing comma
    const testFunctionPattern = /(describe|test|it)\(\s*"([^"]+)"\s+(\w+)/g;
    const testMatches = content.match(testFunctionPattern);
    if (testMatches) {
      content = content.replace(testFunctionPattern '$1("$2", $3');
      console.log(`${filePath}: Fixed ${testMatches.length} test function calls with missing, commas`);
      fixCount += testMatches.length;
    }

    // Fix import statements with missing commas and excessive identifiers
    const importExtraPattern = /import\s*\{\s*([^}]+)\s+([^}]+)\s*\}\s*from\s*"([^"]+)"/g;
    const importMatches = content.match(importExtraPattern);
    if (importMatches) {
      content = content.replace(importExtraPattern, (match, item1, item2, path) => {
        // Check if item2 looks like a separate import item
        if (item2.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/)) {
          return `import { ${item1} ${item2} } from "${path}"`;
        }
        return match;
      });
      console.log(`${filePath}: Fixed ${importMatches.length} import statements with extra, identifiers`);
      fixCount += importMatches.length;
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
