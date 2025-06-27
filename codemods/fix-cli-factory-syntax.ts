import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix interface parameter syntax - remove comma after export
    const exportInterfacePattern = /export,\s*interface/g;
    if (exportInterfacePattern.test(content)) {
      content = content.replace(exportInterfacePattern, 'export interface');
      console.log(`${filePath}: Fixed "export interface" → "export, interface"`);
      fixCount++;
    }

    // Fix type syntax - remove comma after export
    const exportTypePattern = /export,\s*type/g;
    if (exportTypePattern.test(content)) {
      content = content.replace(exportTypePattern, 'export type');
      console.log(`${filePath}: Fixed "export type" → "export, type"`);
      fixCount++;
    }

    // Fix const syntax - remove comma after export
    const exportConstPattern = /export,\s*const/g;
    if (exportConstPattern.test(content)) {
      content = content.replace(exportConstPattern, 'export const');
      console.log(`${filePath}: Fixed "export const" → "export, const"`);
      fixCount++;
    }

    // Fix generic type parameters with missing commas
    const genericTypePattern = /T,\s*extends\s+([A-Za-z]+)\s*=\s*,\s*z\.ZodTypeAny/g;
    if (genericTypePattern.test(content)) {
      content = content.replace(genericTypePattern, 'T extends $1 = z.ZodTypeAny');
      console.log(`${filePath}: Fixed generic type parameter, syntax`);
      fixCount++;
    }

    // Fix parameter definitions with weird comma placement
    const paramDefPattern = /mcpHidden\?\s*:\s*any,\s*boolean/g;
    if (paramDefPattern.test(content)) {
      content = content.replace(paramDefPattern, 'mcpHidden?: boolean');
      console.log(`${filePath}: Fixed parameter definition, syntax`);
      fixCount++;
    }

    // Fix type syntax Record<string, CommandParameterDefinition>
    const recordTypePattern = /Record<string\s+CommandParameterDefinition>/g;
    if (recordTypePattern.test(content)) {
      content = content.replace(recordTypePattern, 'Record<string, CommandParameterDefinition>');
      console.log(`${filePath}: Fixed Record type syntax - added missing, comma`);
      fixCount++;
    }

    // Fix function type with missing comma in generics
    const functionTypePattern = /T,\s*extends\s+CommandParameterMap\s+R>/g;
    if (functionTypePattern.test(content)) {
      content = content.replace(functionTypePattern, 'T extends CommandParameterMap, R>');
      console.log(`${filePath}: Fixed function type generic, syntax`);
      fixCount++;
    }

    // Fix object property syntax with colons and commas
    const objectPropertyPattern = /(\w+):\s*([A-Za-z]+);,/g;
    if (objectPropertyPattern.test(content)) {
      content = content.replace(objectPropertyPattern, '$1: $2;');
      console.log(`${filePath}: Fixed object property, syntax`);
      fixCount++;
    }

    // Fix throw statements with comma
    const throwPattern = /throw,\s*new/g;
    if (throwPattern.test(content)) {
      content = content.replace(throwPattern, 'throw new');
      console.log(`${filePath}: Fixed throw statement, syntax`);
      fixCount++;
    }

    // Fix Map type syntax with missing comma
    const mapTypePattern = /Map<string\s+SharedCommand>/g;
    if (mapTypePattern.test(content)) {
      content = content.replace(mapTypePattern, 'Map<string, SharedCommand>');
      console.log(`${filePath}: Fixed Map type syntax - added missing, comma`);
      fixCount++;
    }

    // Fix private property syntax with comma
    const privatePropertyPattern = /private,\s*(\w+):/g;
    if (privatePropertyPattern.test(content)) {
      content = content.replace(privatePropertyPattern, 'private $1:');
      console.log(`${filePath}: Fixed private property, syntax`);
      fixCount++;
    }

    // Fix parameter syntax in function signatures
    const parameterPattern = /(\w+):\s*,\s*(\w+)/g;
    if (parameterPattern.test(content)) {
      content = content.replace(parameterPattern, '$1: $2');
      console.log(`${filePath}: Fixed parameter, syntax`);
      fixCount++;
    }

    // Fix complex parameter syntax with underscores and commas
    const complexParamPattern = /{ \[_K,\s*in\s*keyof,\s*T\]: any\s+z\.infer<T\[K\]\["schema"\]> }/g;
    if (complexParamPattern.test(content)) {
      content = content.replace(complexParamPattern, '{ [K in keyof T]: z.infer<T[K]["schema"]> }');
      console.log(`${filePath}: Fixed complex parameter, syntax`);
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
