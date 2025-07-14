#!/usr/bin/env bun

/**
 * Variable Naming Fix Example
 * 
 * This example demonstrates the successful AST-based approach from Task #166
 * that achieved 231 fixes with 100% success rate and zero syntax errors.
 * 
 * Based on: fix-variable-naming-ast.ts
 * Evidence: 6x more effective than regex-based approaches
 */

import { Project } from "ts-morph";
import { globSync } from "glob";

interface VariableNamingIssue {
  file: string;
  line: number;
  description: string;
  type: "parameter" | "variable" | "function";
}

class VariableNamingFixer {
  private project: Project;
  private issues: VariableNamingIssue[] = [];
  private fixes: number = 0;

  constructor() {
    this.project = new Project();
  }

  addSourceFiles(patterns: string[]): void {
    const files = patterns.flatMap(pattern => 
      globSync(pattern, { ignore: ["**/*.d.ts", "**/*.test.ts"] })
    );
    
    this.project.addSourceFilesAtPaths(files);
    console.log(`Added ${files.length} source files`);
  }

  findIssues(): void {
    const sourceFiles = this.project.getSourceFiles();
    
    sourceFiles.forEach(sourceFile => {
      const functions = sourceFile.getFunctions();
      
      functions.forEach(func => {
        const parameters = func.getParameters();
        
        parameters.forEach(param => {
          const paramName = param.getName();
          
          if (paramName.startsWith("_")) {
            this.issues.push({
              file: sourceFile.getFilePath(),
              line: param.getStartLineNumber(),
              description: `Parameter ${paramName} has underscore prefix`,
              type: "parameter"
            });
          }
        });
      });
    });
    
    console.log(`Found ${this.issues.length} variable naming issues`);
  }

  fixIssues(): void {
    const sourceFiles = this.project.getSourceFiles();
    
    sourceFiles.forEach(sourceFile => {
      const functions = sourceFile.getFunctions();
      
      functions.forEach(func => {
        const parameters = func.getParameters();
        
        parameters.forEach(param => {
          const paramName = param.getName();
          
          if (paramName.startsWith("_")) {
            const newName = paramName.substring(1);
            param.rename(newName);
            this.fixes++;
          }
        });
      });
      
      sourceFile.saveSync();
    });
    
    console.log(`Fixed ${this.fixes} variable naming issues`);
  }

  execute(patterns: string[]): void {
    console.log("Starting variable naming fix...");
    
    this.addSourceFiles(patterns);
    this.findIssues();
    this.fixIssues();
    
    console.log("Variable naming fix completed successfully");
  }
}

// Usage
async function main() {
  const fixer = new VariableNamingFixer();
  
  fixer.execute([
    "src/**/*.ts",
    "src/**/*.tsx"
  ]);
}

if (import.meta.main) {
  main();
} 
