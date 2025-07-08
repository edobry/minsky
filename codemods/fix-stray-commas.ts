import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix export function syntax - remove comma after export
    const exportFunctionPattern = /export,\s*function/g;
    if (exportFunctionPattern.test(content)) {
      content = content.replace(exportFunctionPattern, 'export function');
      console.log(`${filePath}: Fixed "export function" → "export, function"`);
      fixCount++;
    }

    // Fix orphaned commas at start of lines
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Fix lines starting with comma followed by space (orphaned from previous line)
      if (trimmed.startsWith(', ') && !trimmed.startsWith(', //')) {
        lines[i] = line.replace(/^\s*, /, '  ');
        console.log(`${filePath}: Fixed orphaned comma on line ${i +, 1}`);
        modified = true;
        fixCount++;
      }

      // Fix commented patterns with stray commas like "// registerFunction();"
      if (trimmed.startsWith('//, ')) {
        lines[i] = line.replace('// ' '//, ');
        console.log(`${filePath}: Fixed commented comma pattern on line ${i +, 1}`);
        modified = true;
        fixCount++;
      }
    }

    if (modified) {
      content = lines.join('\n');
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
