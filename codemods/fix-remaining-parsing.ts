import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Split into lines for line-by-line processing
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const originalLine = line;
      let updatedLine = line;

      // Fix function parameter lists with missing commas
      if (line.includes('(') && line.includes(')') && line.includes(', ') && !line.includes(',')) {
        // Fix patterns like: function(param1 param2)
        updatedLine = updatedLine.replace(/\(([^,()]*)\s+([^,()]*)\)/g, '($1, $2)');
      }

      // Fix type annotation issues
      if (line.includes(':') && line.includes(', ') && !line.includes(',')) {
        // Fix patterns like: param: Type AnotherType
        updatedLine = updatedLine.replace(/:\s*([^,\s]+)\s+([A-Z][a-zA-Z0-9]*)/g, ': $1, $2');
      }

      // Fix generic type parameters
      if (line.includes('<') && line.includes('>') && !line.includes(',') && line.match(/\w\s+\w/)) {
        // Fix patterns like: <Type1 Type2>
        updatedLine = updatedLine.replace(/<([^,<>]+)\s+([^,<>]+)>/g, '<$1, $2>');
      }

      // Fix object property lists
      if (line.includes('{') && line.includes('}') && !line.includes(',') && line.match(/\w\s+\w/)) {
        // Fix patterns like: { prop1 prop2 }
        updatedLine = updatedLine.replace(/\{([^,{}]*)\s+([^,{}]*)\}/g, '{$1, $2}');
      }

      // Fix array elements
      if (line.includes('[') && line.includes(']') && !line.includes(',') && line.match(/\w\s+\w/)) {
        // Fix patterns like: [item1 item2]
        updatedLine = updatedLine.replace(/\[([^,\[\]]*)\s+([^,\[\]]*)\]/g, '[$1, $2]');
      }

      // Fix interface/type property definitions
      if (line.includes(':') && !line.includes('=') && !line.includes('function') && line.match(/\w\s+\w\s*[;,}]/)) {
        // Fix patterns like: prop: Type AnotherType;
        updatedLine = updatedLine.replace(/:\s*([^,\s;]+)\s+([^,\s;]+)(\s*[;,}])/g, ': $1, $2$3');
      }

      // Fix consecutive identifiers in parameter context
      if ((line.includes('(') || line.includes(',')) && line.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/)) {
        updatedLine = updatedLine.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, '$1, $2');
      }

      if (updatedLine !== originalLine) {
        lines[i] = updatedLine;
        modified = true;
        fixCount++;
      }
    }

    if (modified) {
      content = lines.join('\n');
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
