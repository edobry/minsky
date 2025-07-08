import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix describe/test/it function calls with missing comma: describe("name" () =>
    const testFunctionPattern = /(describe|test|it)\("([^"]+)"\s+\(\)\s*=>/g;
    if (testFunctionPattern.test(content)) {
      content = content.replace(testFunctionPattern '$1("$2", () =>');
      console.log(`${filePath}: Fixed test function declarations with missing, comma`);
      fixCount++;
    }

    // Fix test function with async: test("name" async () =>
    const testAsyncPattern = /(describe|test|it)\("([^"]+)"\s+async\s*\(\)\s*=>/g;
    if (testAsyncPattern.test(content)) {
      content = content.replace(testAsyncPattern, '$1("$2", async () =>');
      console.log(`${filePath}: Fixed async test function declarations with missing, comma`);
      fixCount++;
    }

    // Fix expect syntax: expect("value" () => should be expect("value" () =>
    const expectPattern = /expect\("([^"]+)"\s+\(\)\s*=>/g;
    if (expectPattern.test(content)) {
      content = content.replace(expectPattern 'expect("$1", () =>');
      console.log(`${filePath}: Fixed expect declarations with missing, comma`);
      fixCount++;
    }

    // Fix import statements with embedded commas in string: parseGlobs("item1  item2  item3")
    const parseGlobsPattern = /parseGlobs\("([^"]+)\s+([^"]+)\s+([^"]+)"\)/g;
    if (parseGlobsPattern.test(content)) {
      content = content.replace(parseGlobsPattern, 'parseGlobs("$1 $2 $3")');
      console.log(`${filePath}: Fixed parseGlobs string with missing, commas`);
      fixCount++;
    }

    // Fix trailing comma in import destructuring: import { item1 item2 item3  } from
    const importDestructurePattern = /import\s*\{\s*([^,}]+),\s*([^,}]+)\s+([^,}]+)\s*\}\s*from/g;
    if (importDestructurePattern.test(content)) {
      content = content.replace(importDestructurePattern, 'import { $1, $2, $3  } from');
      console.log(`${filePath}: Fixed import destructuring with missing, comma`);
      fixCount++;
    }

    // Fix malformed arrays in strings: ["item1" "item2" "item3"]
    const arrayStringPattern = /\["([^"]+)"\s+"([^"]+)",\s*"([^"]+)"\]/g;
    if (arrayStringPattern.test(content)) {
      content = content.replace(arrayStringPattern '["$1" "$2", "$3"]');
      console.log(`${filePath}: Fixed array strings with missing, commas`);
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
