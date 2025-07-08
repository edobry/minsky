import { Project, SyntaxKind } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Fix {
  file: string;
  line: number;
  description: string;
  oldText: string;
  newText: string;
}

const fixes: Fix[] = [];

function fixMockFunctionSignatures(): void {
  console.log("🔧 Fixing mock function signatures...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Focus on test utility files
  const testUtilsFiles = [
    "src/utils/test-utils/dependencies.ts",
    "src/utils/test-utils/mocking.ts",
  ];

  for (const filePath of testUtilsFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let fileChanged = false;

      // Find all object literal expressions (mock objects)
      const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);

      for (const objectLiteral of objectLiterals) {
        const properties = objectLiteral.getProperties();
        
        for (const prop of properties) {
          if (prop.getKind() === SyntaxKind.PropertyAssignment) {
            const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const propName = propAssignment.getName();
            const initializer = propAssignment.getInitializer();
            
            if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
              const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
              const body = arrowFunc.getBody();
              
              if (body && body.getKind() === SyntaxKind.CallExpression) {
                const callExpr = body.asKindOrThrow(SyntaxKind.CallExpression);
                const expression = callExpr.getExpression();
                
                if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
                  const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
                  const methodName = propAccess.getName();
                  
                  if (methodName === "resolve") {
                    const args = callExpr.getArguments();
                    if (args.length === 1) {
                      const arg = args[0];
                      
                      // Fix specific mock function patterns
                      if (propName === "createTask" && arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                        const taskObj = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
                        const taskProps = taskObj.getProperties();
                        
                        for (const taskProp of taskProps) {
                          if (taskProp.getKind() === SyntaxKind.PropertyAssignment) {
                            const taskPropAssign = taskProp.asKindOrThrow(SyntaxKind.PropertyAssignment);
                            const taskPropName = taskPropAssign.getName();
                            
                            if (taskPropName === "_id") {
                              taskPropAssign.getNameNode().replaceWithText("id");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: taskPropAssign.getStartLineNumber(),
                                description: "Fixed Task property name: _id → id",
                                oldText: "_id",
                                newText: "id"
                              });
                            } else if (taskPropName === "_title") {
                              taskPropAssign.getNameNode().replaceWithText("title");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: taskPropAssign.getStartLineNumber(),
                                description: "Fixed Task property name: _title → title",
                                oldText: "_title",
                                newText: "title"
                              });
                            } else if (taskPropName === "_status") {
                              taskPropAssign.getNameNode().replaceWithText("status");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: taskPropAssign.getStartLineNumber(),
                                description: "Fixed Task property name: _status → status",
                                oldText: "_status",
                                newText: "status"
                              });
                            }
                          }
                        }
                      }
                      
                      // Fix git service mock return types
                      if ((propName === "clone" || propName === "branch") && arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
                        const gitObj = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
                        const gitProps = gitObj.getProperties();
                        
                        for (const gitProp of gitProps) {
                          if (gitProp.getKind() === SyntaxKind.PropertyAssignment) {
                            const gitPropAssign = gitProp.asKindOrThrow(SyntaxKind.PropertyAssignment);
                            const gitPropName = gitPropAssign.getName();
                            
                            if (gitPropName === "_workdir") {
                              gitPropAssign.setName("workdir");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: gitPropAssign.getStartLineNumber(),
                                description: "Fixed git result property: _workdir → workdir",
                                oldText: "_workdir",
                                newText: "workdir"
                              });
                            } else if (gitPropName === "_session") {
                              gitPropAssign.setName("session");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: gitPropAssign.getStartLineNumber(),
                                description: "Fixed git result property: _session → session",
                                oldText: "_session",
                                newText: "session"
                              });
                            } else if (gitPropName === "_branch") {
                              gitPropAssign.setName("branch");
                              fileChanged = true;
                              fixes.push({
                                file: filePath,
                                line: gitPropAssign.getStartLineNumber(),
                                description: "Fixed git result property: _branch → branch",
                                oldText: "_branch",
                                newText: "branch"
                              });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              
              // Fix functions returning void that should return proper result objects
              if (propName === "stashChanges" || propName === "pullLatest" || propName === "push" || propName === "popStash") {
                const bodyText = body.getText();
                if (bodyText.includes("Promise.resolve()")) {
                  let newReturnValue = "";
                  
                  if (propName === "stashChanges") {
                    newReturnValue = 'Promise.resolve({ workdir: "/mock/workdir", stashed: true })';
                  } else if (propName === "pullLatest") {
                    newReturnValue = 'Promise.resolve({ workdir: "/mock/workdir", updated: true })';
                  } else if (propName === "push") {
                    newReturnValue = 'Promise.resolve({ workdir: "/mock/workdir", pushed: true })';
                  } else if (propName === "popStash") {
                    newReturnValue = 'Promise.resolve({ workdir: "/mock/workdir", stashed: false })';
                  }
                  
                  if (newReturnValue) {
                    arrowFunc.setBodyText(newReturnValue);
                    fileChanged = true;
                    fixes.push({
                      file: filePath,
                      line: arrowFunc.getStartLineNumber(),
                      description: `Fixed ${propName} return type: void → proper result object`,
                      oldText: bodyText,
                      newText: newReturnValue
                    });
                  }
                }
              }
              
              // Fix mergeBranch to include conflicts property
              if (propName === "mergeBranch") {
                const bodyText = body.getText();
                if (bodyText.includes("{ conflicts: false }")) {
                  const newReturnValue = 'Promise.resolve({ workdir: "/mock/workdir", merged: true, conflicts: false })';
                  arrowFunc.setBodyText(newReturnValue);
                  fileChanged = true;
                  fixes.push({
                    file: filePath,
                    line: arrowFunc.getStartLineNumber(),
                    description: "Fixed mergeBranch return type: added workdir and merged properties",
                    oldText: bodyText,
                    newText: newReturnValue
                  });
                }
              }
            }
          }
        }
      }

      if (fileChanged) {
        sourceFile.saveSync();
        console.log(`✅ Fixed mock functions in ${filePath}`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
    }
  }
}

// Run the fix
fixMockFunctionSignatures();

// Report results
console.log(`\n📊 Mock Function Signature Fixes Applied: ${fixes.length}`);
if (fixes.length > 0) {
  console.log("\n🔍 Summary of fixes:");
  const fixesByFile = fixes.reduce((acc, fix) => {
    acc[fix.file] = (acc[fix.file] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  Object.entries(fixesByFile).forEach(([file, count]) => {
    console.log(`  ${file}: ${count} fixes`);
  });
  
  console.log("\n📝 Detailed fixes:");
  fixes.forEach((fix, index) => {
    console.log(`  ${index + 1}. ${fix.description} (${fix.file}:${fix.line})`);
  });
}

console.log("\n✅ Mock function signature fixes completed!"); 
