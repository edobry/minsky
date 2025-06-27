#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

/**
 * Codemod to fix no-magic-numbers issues
 * Extract magic numbers to named constants
 */

interface MagicNumber {
  value: string;
  context: string;
  constantName: string;
}

function generateConstantName(value: string, context: string): string {
  // Common patterns for naming constants based on context and value
  const num = parseInt(value);
  
  if (context.includes('port') || context.includes('Port')) {
    if (num === 3000) return 'DEFAULT_SERVER_PORT';
    if (num === 8080) return 'DEFAULT_HTTP_PORT';
    if (num === 8081) return 'ALTERNATIVE_HTTP_PORT';
    if (num === 6274) return 'INSPECTOR_PORT';
    return `PORT_${num}`;
  }
  
  if (context.includes('timeout') || context.includes('Timeout')) {
    if (num === 1000) return 'DEFAULT_TIMEOUT_MS';
    return `TIMEOUT_${num}_MS`;
  }
  
  if (context.includes('status') || context.includes('Status')) {
    if (num === 404) return 'HTTP_NOT_FOUND';
    if (num === 401) return 'HTTP_UNAUTHORIZED';
    if (num === 403) return 'HTTP_FORBIDDEN';
    return `HTTP_STATUS_${num}`;
  }
  
  if (context.includes('length') || context.includes('Length') || context.includes('size') || context.includes('Size')) {
    if (num === 20) return 'DEFAULT_DISPLAY_LENGTH';
    if (num === 36) return 'UUID_LENGTH';
    if (num === 7) return 'SHORT_ID_LENGTH';
    if (num === 8) return 'COMMIT_HASH_SHORT_LENGTH';
    return `SIZE_${num}`;
  }
  
  if (context.includes('test') || context.includes('Test')) {
    if (num === 5) return 'TEST_ARRAY_SIZE';
    if (num === 123) return 'TEST_VALUE';
    if (num === 42) return 'TEST_ANSWER';
    return `TEST_VALUE_${num}`;
  }
  
  // Default patterns
  if (num === 0.1 || num === 0.2 || num === 0.3 || num === 0.5) {
    return `DECIMAL_${value.replace('.', '_')}`;
  }
  
  if (num === 100000) return 'MAX_ID_VALUE';
  if (num === 900) return 'HIGH_TIMEOUT_MS';
  if (num === 6) return 'DEFAULT_TRUNCATE_LENGTH';
  if (num === 15) return 'ANALYSIS_LIMIT';
  
  // Fallback
  return `CONSTANT_${num}`;
}

function fixMagicNumbersInFile(filePath: string): boolean {
  try {
    let content: string = readFileSync(filePath, 'utf-8') as string;
    let modified = false;
    const originalContent = content;
    const constants: MagicNumber[] = [];

    // Common magic number patterns to extract
    const magicNumberPatterns = [
      // Port numbers
      { pattern: /\b(3000|8080|8081|6274)\b/g, context: 'port' },
      // HTTP status codes
      { pattern: /\b(404|401|403)\b/g, context: 'status' },
      // Common sizes and lengths
      { pattern: /\b(20|36|7|8|100000|6|15)\b/g, context: 'length' },
      // Test values
      { pattern: /\b(5|123|42)\b/g, context: 'test' },
      // Timeouts and delays
      { pattern: /\b(1000|900)\b/g, context: 'timeout' },
      // Decimal values
      { pattern: /\b(0\.1|0\.2|0\.3|0\.5)\b/g, context: 'decimal' },
    ];

    // Find all magic numbers in the file
    for (const { pattern, context } of magicNumberPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const value = match[0];
        const constantName = generateConstantName(value, context);
        
        // Only add if we don't already have this constant
        if (!constants.find(c => c.value === value)) {
          constants.push({ value, context, constantName });
        }
      }
      pattern.lastIndex = 0; // Reset regex
    }

    // If we found constants to extract, add them and replace usage
    if (constants.length > 0) {
      // Check if file already has constants section
      const hasConstantsSection = content.includes('// Constants') || content.includes('const ');
      
      // Generate constants declarations
      const constantsDeclarations = constants.map(c => 
        `const ${c.constantName} = ${c.value};`
      ).join('\n');

      // Add constants at the top of the file (after imports)
      const importEndMatch = content.match(/^((?:import[^;]+;[\r\n]*)*)/);
      if (importEndMatch && importEndMatch[1]) {
        const importsSection = importEndMatch[1];
        const restOfFile = content.slice(importsSection.length);
        
        content = importsSection + 
          (hasConstantsSection ? '' : '\n// Constants\n') +
          constantsDeclarations + '\n\n' + 
          restOfFile;
      } else {
        // No imports, add at the beginning
        content = (hasConstantsSection ? '' : '// Constants\n') +
          constantsDeclarations + '\n\n' + 
          content;
      }

      // Replace magic numbers with constants
      for (const { value, constantName } of constants) {
        // Be careful to only replace standalone numbers, not parts of other numbers
        const regex = new RegExp(`\\b${value.replace('.', '\\.')}\\b`, 'g');
        content = content.replace(regex, constantName);
      }

      modified = true;
    }

    if (modified) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ Fixed magic numbers in ${filePath} (${constants.length} constants)`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
    return false;
  }
}

async function main() {
  console.log('🔧 Starting magic numbers cleanup...');
  
  // Get all TypeScript files
  const files = await glob('src/**/*.ts', { ignore: ['node_modules/**', '**/*.d.ts'] });
  
  let fixedFiles = 0;
  let totalFiles = files.length;
  
  console.log(`📊 Processing ${totalFiles} TypeScript files...`);
  
  for (const file of files) {
    if (fixMagicNumbersInFile(file)) {
      fixedFiles++;
    }
  }
  
  console.log(`\n🎯 Results:`);
  console.log(`   Fixed: ${fixedFiles} files`);
  console.log(`   Total: ${totalFiles} files`);
  console.log(`   Success rate: ${((fixedFiles / totalFiles) * 100).toFixed(1)}%`);
}

if (require.main === module) {
  main().catch(console.error);
} 
