import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix patterns where commas were incorrectly added
    const fixes = [
      // Fix variable declarations
      {
        pattern: /\b(const|let|var), /g,
        replacement: '$1 ',
        description: 'Fix variable declarations with incorrect commas'
      },
      // Fix await expressions
      {
        pattern: /\bawait, /g,
        replacement: 'await ',
        description: 'Fix await expressions with incorrect commas'
      },
      // Fix return statements
      {
        pattern: /\breturn, /g,
        replacement: 'return ',
        description: 'Fix return statements with incorrect commas'
      },
      // Fix function calls and property access
      {
        pattern: /(\w+), (\w+\()/g,
        replacement: '$1 $2',
        description: 'Fix function calls with incorrect commas'
      },
      // Fix test descriptions
      {
        pattern: /"([^"]*), ([^"]*)"/g,
        replacement: '"$1 $2"',
        description: 'Fix test descriptions with incorrect commas'
      },
      // Fix property access chains
      {
        pattern: /(\w+), (\w+\.[a-zA-Z])/g,
        replacement: '$1 $2',
        description: 'Fix property access with incorrect commas'
      },
      // Fix basic assignments
      {
        pattern: /= ([^,\s]+), ([^,\s]+);/g,
        replacement: '= $1 $2;',
        description: 'Fix assignments with incorrect commas'
      },
      // Fix type annotations
      {
        pattern: /: ([^,\s]+), ([A-Z][a-zA-Z]*)/g,
        replacement: ': $1 $2',
        description: 'Fix type annotations with incorrect commas'
      }
    ];

    for (const { pattern, replacement, description } of, fixes) {
      const originalContent = content;
      content = content.replace(pattern, replacement);
      
      if (content !== originalContent) {
        const matches = (originalContent.match(pattern) || []).length;
        console.log(`${filePath}: ${description} (${matches}, fixes)`);
        fixCount += matches;
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
