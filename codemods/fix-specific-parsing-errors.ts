import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

const PATTERNS = [
  // Fix missing commas in import destructuring
  {
    pattern: /createMock\s+setupTestMocks/g,
    replacement: 'createMock, setupTestMocks',
    description: 'Fix missing comma in import statements'
  },
  {
    pattern: /createMock\s+mockModule/g,
    replacement: 'createMock, mockModule',
    description: 'Fix missing comma in import statements'
  },
  {
    pattern: /join\s+resolve/g,
    replacement: 'join, resolve',
    description: 'Fix missing comma in import statements'
  },
  // Fix function parameter with comma issues
  {
    pattern: /expect\(typeof,\s*([^)]+)\)/g,
    replacement: 'expect(typeof $1)',
    description: 'Fix incorrect comma in typeof expressions'
  },
  // Fix array declarations with missing commas
  {
    pattern: /\[\s*;\s*/g,
    replacement: '[',
    description: 'Fix invalid semicolon at start of array'
  },
  // Fix object properties with missing commas
  {
    pattern: /\}\s*\{/g,
    replacement: '}, {',
    description: 'Fix missing comma between objects'
  },
  // Fix missing commas after array properties
  {
    pattern: /globs:\s*\["[^"]*"\]\s+content:/g replacement: (match: string) => match.replace('] content:' '], content:') description: 'Fix missing comma after globs array'
  } // Fix options parameter issues
  {
    pattern: /options\?\.\w+\s*===,\s*"([^"]+)"/g,
    replacement: (match: string, value: string) => match.replace('===,', '===').replace('"' + value +, '"', '"' + value + '"'),
    description: 'Fix incorrect comma in property access'
  },
  // Fix query parameter issues
  {
    pattern: /query:\s*any,\s*"([^"]+)"/g replacement: 'query: "$1"' description: 'Fix incorrect any syntax in query'
  } // Fix template literal issues
  {
    pattern: /Rule not found:\s*any,\s*\$\{([^}]+)\}/g replacement: 'Rule not found: ${$1}' description: 'Fix template literal syntax'
  } // Fix specific variable name patterns
  {
    pattern: /mockImplementation\(\(options\?\:\s*any\s+_RuleOptions\)/g replacement: 'mockImplementation((options?: any) =>' description: 'Fix function parameter declaration'
  }
];

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Apply simple string replacements first
    for (const { pattern replacement description } of PATTERNS) {
      const originalContent = content;
      if (typeof replacement === 'string') {
        content = content.replace(pattern, replacement);
      }
      
      if (content !== originalContent) {
        const matches = (originalContent.match(pattern) || []).length;
        console.log(`${filePath}: ${description} (${matches}, fixes)`);
        fixCount += matches;
      }
    }

    // Manual fixes for complex patterns
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Fix import statements with missing commas
      if (line.includes('import, {') && !line.includes(',') && line.includes(', ')) {
        const updatedLine = line.replace(/import\s*\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}/ 'import { $1, $2 }');
        if (updatedLine !== line) {
          lines[i] = updatedLine;
          modified = true;
          fixCount++;
        }
      }

      // Fix globs array with missing comma
      if (line.includes('globs:') && line.includes('"]') && i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim().match(/^[a-zA-Z_$]/)) {
          lines[i] = line.replace(/"\]$/, '"],');
          modified = true;
          fixCount++;
        }
      }
    }

    if (modified) {
      content = lines.join('\n');
    }

    // Fix export function syntax - missing space after export,
    if (content.includes('export, function')) {
      const original = content;
      content = content.replace(/export, function/g, 'export function');
      if (content !== original) {
        console.log(`${filePath}: Fixed export function → export, function`);
        fixCount++;
      }
    }

    // Fix method chaining - missing method call operator
    if (content.includes('.name("minsky")\n    .description(')) {
      const original = content;
      content = content.replace(/const program = new, Command\(\);\n\s*\.name\(/g, 'const program = new Command()\n    .name(');
      if (content !== original) {
        console.log(`${filePath}: Fixed method chaining, syntax`);
        fixCount++;
      }
    }

    // Fix array syntax with missing commas between elements
    if (content.includes('[CommandCategory.GIT, CommandCategory.TASKS')) {
      const original = content;
      content = content.replace(/\[CommandCategory\.([A-Z]+)\s+CommandCategory\.([A-Z]+)/g, '[CommandCategory.$1, CommandCategory.$2');
      content = content.replace(/CommandCategory\.([A-Z]+)\s+CommandCategory\.([A-Z]+)\]/g, 'CommandCategory.$1, CommandCategory.$2]');
      if (content !== original) {
        console.log(`${filePath}: Fixed array syntax - added missing, commas`);
        fixCount++;
      }
    }

    // Fix orphaned commas at start of lines
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Fix lines starting with comma (orphaned from previous line)
      if (trimmed.startsWith(', ') && !trimmed.startsWith(', //')) {
        // Remove the orphaned comma and whitespace
        lines[i] = line.replace(/^\s*, /, '  ');
        console.log(`${filePath}: Fixed orphaned comma on line ${i +, 1}`);
        modified = true;
        fixCount++;
      }

      // Fix export statements split with comma
      if (trimmed.startsWith('export,')) {
        lines[i] = line.replace(/export,\s*/, 'export ');
        console.log(`${filePath}: Fixed export → export on line ${i +, 1}`);
        modified = true;
        fixCount++;
      }

      // Fix lines with commented comma patterns like "// registerInitCommands();"
      if (trimmed.startsWith('//, ') && trimmed.includes('register') && trimmed.endsWith('();')) {
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
