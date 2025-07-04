#!/usr/bin/env bun

import { Project, SyntaxKind, Node } from "ts-morph";

function fixPropertyNameCorrections() {
  console.log("🚀 Starting property name corrections fix...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  // Add all TypeScript files
  const sourceFiles = project.addSourceFilesAtPaths([
    "src/**/*.ts", 
    "scripts/**/*.ts"
  ]);
  console.log(`📁 Processing ${sourceFiles.length} TypeScript files...`);

  let fixCount = 0;
  const fixes: string[] = [];

  // Property name corrections mapping
  const corrections = {
    '_parameters': 'parameters',
    '_workdir': 'workdir', 
    '_session': 'session',
    '_branch': 'branch',
    '_repoPath': 'repoPath',
    'params': 'parameters' // In MCP context
  };

  for (const sourceFile of sourceFiles) {
    
         // 1. Fix property assignments in object literals
     sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach(propAssignment => {
       const name = propAssignment.getName();
       
       if (corrections[name]) {
         const nameNode = propAssignment.getNameNode();
         if (Node.isIdentifier(nameNode)) {
           nameNode.replaceWithText(corrections[name]);
           fixCount++;
           fixes.push(`Fixed property ${name} → ${corrections[name]} in ${sourceFile.getBaseName()}`);
         }
       }
     });

    // 2. Fix shorthand property assignments
    sourceFile.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment).forEach(shorthand => {
      const name = shorthand.getName();
      
      if (corrections[name]) {
        // Convert shorthand to full property assignment with corrected name
        shorthand.replaceWithText(`${corrections[name]}: ${name}`);
        fixCount++;
        fixes.push(`Fixed shorthand property ${name} → ${corrections[name]} in ${sourceFile.getBaseName()}`);
      }
    });

    // 3. Fix object binding patterns (destructuring)
    sourceFile.getDescendantsOfKind(SyntaxKind.ObjectBindingPattern).forEach(binding => {
      binding.getElements().forEach(element => {
        if (Node.isBindingElement(element)) {
          const propertyName = element.getPropertyNameNode();
          if (propertyName && Node.isIdentifier(propertyName)) {
            const name = propertyName.getText();
            if (corrections[name]) {
              propertyName.replaceWithText(corrections[name]);
              fixCount++;
              fixes.push(`Fixed binding property ${name} → ${corrections[name]} in ${sourceFile.getBaseName()}`);
            }
          }
        }
      });
    });

         // 4. Special case: fix 'params' → 'parameters' in MCP files
     if (sourceFile.getBaseName().includes('mcp') || sourceFile.getFilePath().includes('/mcp/')) {
       sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach(propAssignment => {
         const name = propAssignment.getName();
         if (name === 'params') {
           const nameNode = propAssignment.getNameNode();
           if (Node.isIdentifier(nameNode)) {
             nameNode.replaceWithText('parameters');
             fixCount++;
             fixes.push(`Fixed MCP property params → parameters in ${sourceFile.getBaseName()}`);
           }
         }
       });
     }
  }

  // Save all changes
  console.log("💾 Saving changes...");
  project.saveSync();
  console.log(`💾 Saved changes to ${sourceFiles.length} files`);

  // Print report
  console.log(`\n📋 Property Name Corrections Report:`);
  console.log(`   Fixes applied: ${fixCount}`);
  
  if (fixes.length > 0) {
    console.log(`\n🔧 Applied fixes:`);
    fixes.slice(0, 10).forEach(fix => console.log(`✅ ${fix}`));
    if (fixes.length > 10) {
      console.log(`... and ${fixes.length - 10} more fixes`);
    }
  }

  console.log(`\n✅ Property name corrections completed!`);
}

fixPropertyNameCorrections(); 
