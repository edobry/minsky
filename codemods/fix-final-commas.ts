import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix arrays with missing commas
    const arrayFixes = [
      // Fix string arrays like ["item1" "item2" "item3"]
      {
        pattern: /\[([^[\]]*"[^"]*")\s+([^[\]]*"[^"]*"[^[\]]*)\]/g,
        replacement: '[$1, $2]',
        description: 'Fix string arrays with missing commas'
      },
      // Fix arrays with multiple consecutive string elements
      {
        pattern: /"([^"]*)"(\s+)"([^"]*)"/g,
        replacement: '"$1",$2"$3"',
        description: 'Fix consecutive string elements in arrays'
      }
    ];

    // Fix object properties with missing commas
    const objectFixes = [
      // Fix object properties like { prop1: value1 prop2: value2 } {
        pattern: /(\w+:\s*[^,\s}]+)\s+(\w+:\s*[^,\s}]+)/g,
        replacement: '$1, $2',
        description: 'Fix object properties with missing commas'
      },
      // Fix object properties on separate lines
      {
        pattern: /(\w+:\s*"[^"]*")\s*\n\s*(\w+:\s*"[^"]*")/g,
        replacement: '$1,\n    $2',
        description: 'Fix multiline object properties with missing commas'
      }
    ];

    // Apply fixes
    const allFixes = [...arrayFixes, ...objectFixes];
    
    for (const { pattern, replacement, description } of, allFixes) {
      const originalContent = content;
      content = content.replace(pattern, replacement);
      
      if (content !== originalContent) {
        const matches = (originalContent.match(pattern) || []).length;
        console.log(`${filePath}: ${description} (${matches}, fixes)`);
        fixCount += matches;
      }
    }

    // Special handling for common patterns
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const originalLine = line;
      let updatedLine = line;

      // Fix array elements separated by spaces within brackets
      if (line.includes('[') && line.includes(']') && !line.includes(',')) {
        // Handle patterns like: ["word1" "word2" "word3"]
        updatedLine = updatedLine.replace(/\[([^[\]]*"[^"]*")\s+([^[\]]*"[^"]*")\s+([^[\]]*"[^"]*"[^[\]]*)\]/g '[$1 $2 $3]');
        updatedLine = updatedLine.replace(/\[([^[\]]*"[^"]*")\s+([^[\]]*"[^"]*"[^[\]]*)\]/g '[$1 $2]');
      }

      // Fix object properties missing commas at end of line
      if (line.includes(':') && line.includes('"') && !line.includes(',') && !line.includes('}')) {
        const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
        if (nextLine.includes(':') && !nextLine.trim().startsWith('//') && !nextLine.trim().startsWith('*')) {
          updatedLine = updatedLine.replace(/("[^"]*")\s*$/, '$1,');
        }
      }

      if (updatedLine !== originalLine) {
        lines[i] = updatedLine;
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
        console.log(`${file}: Fixed ${fixes} comma, issues`);
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
