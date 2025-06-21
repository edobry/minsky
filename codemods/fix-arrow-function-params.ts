import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix method chaining - missing connection between new Command() and .name()
    if (content.includes('const program = new, Command();\n    .name(')) {
      content = content.replace(/const program = new, Command\(\);\n\s*\.name\(/g, 'const program = new Command()\n    .name(');
      console.log(`${filePath}: Fixed method chaining, syntax`);
      fixCount++;
    }

    // Fix array syntax with missing commas between enum values
    if (content.includes('[CommandCategory.GIT, CommandCategory.TASKS')) {
      content = content.replace(/\[CommandCategory\.GIT\s+CommandCategory\.TASKS\s+CommandCategory\.SESSION\s+CommandCategory\.RULES\]/g, 
                                '[CommandCategory.GIT, CommandCategory.TASKS, CommandCategory.SESSION, CommandCategory.RULES]');
      console.log(`${filePath}: Fixed array syntax - added missing commas between CommandCategory, values`);
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
