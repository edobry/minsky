#!/usr/bin/env bun

/**
 * AS-UNKNOWN AST Codemod for Task #280
 * 
 * Systematically removes excessive 'as unknown' type assertions throughout the codebase
 * to improve TypeScript effectiveness and reduce technical debt.
 * 
 * PROBLEM STATEMENT:
 * The codebase contains 2,728 'as unknown' assertions, with 2,461 classified as high priority.
 * These assertions mask real type errors, reduce TypeScript effectiveness, and create technical debt.
 * 
 * ANALYSIS RESULTS:
 * - Total assertions: 2,728
 * - High priority (error-masking): 2,461 (90%)
 * - Medium priority: 156 (6%)
 * - Low priority: 111 (4%)
 * 
 * TRANSFORMATION PATTERNS:
 * 
 * 1. Property Access Patterns (HIGH PRIORITY)
 *    BEFORE: (state as unknown).sessions
 *    AFTER:  state.sessions
 *    
 *    BEFORE: (this.sessionProvider as unknown).getSession(name)
 *    AFTER:  this.sessionProvider.getSession(name)
 * 
 * 2. Array/Object Method Access (HIGH PRIORITY)
 *    BEFORE: (sessions as unknown).find(s => s.id === id)
 *    AFTER:  sessions.find(s => s.id === id)
 * 
 * 3. Return Statement Patterns (CRITICAL PRIORITY)
 *    BEFORE: return null as unknown;
 *    AFTER:  return null;
 * 
 * 4. Null/Undefined Patterns (CRITICAL PRIORITY)
 *    BEFORE: const result = undefined as unknown;
 *    AFTER:  const result = undefined;
 * 
 * 5. This Context Patterns (HIGH PRIORITY)
 *    BEFORE: (this as unknown).name = "ErrorName";
 *    AFTER:  this.name = "ErrorName";
 * 
 * RISK ASSESSMENT:
 * - Critical: Return statements, null/undefined masking, error handling
 * - High: Property access in domain files, service methods, array operations
 * - Medium: Configuration access, test utilities, parameter passing
 * - Low: Test mocking (may be legitimate), type bridging, documented uses
 * 
 * IMPLEMENTATION STRATEGY:
 * 1. Parse all TypeScript files using ts-morph AST
 * 2. Identify AsExpression nodes with 'unknown' type
 * 3. Analyze context and categorize by risk level
 * 4. Apply safe transformations starting with critical patterns
 * 5. Skip patterns requiring manual review
 * 6. Validate TypeScript compilation after changes
 * 
 * SUCCESS METRICS:
 * - Target reduction: 50%+ (from 2,728 to <1,364)
 * - High priority elimination: 80%+ (from 2,461 to <492)
 * - Zero regressions: All tests must pass
 * - TypeScript compilation: Must continue to work
 * 
 * DEPENDENCIES:
 * - ts-morph: AST parsing and transformation
 * - glob: File pattern matching
 * - Codemod framework utilities
 * 
 * RELATED TASKS:
 * - Task #280: Cleanup excessive 'as unknown' assertions
 * - Task #276: Test suite optimization (identified the problem)
 * - Task #271: Risk-aware type cast fixing (similar patterns)
 */

import { Project, Node, SyntaxKind, AsExpression, TypeAssertion, SourceFile, ParenthesizedExpression, PropertyAccessExpression } from "ts-morph";

// Copy the framework interfaces locally since we're in session workspace
interface CodemodIssue {
  file: string;
  line: number;
  column: number;
  description: string;
  context: string;
  severity: "error" | "warning" | "info";
  type: string;
  original?: string;
  suggested?: string;
}

interface CodemodMetrics {
  filesProcessed: number;
  issuesFound: number;
  issuesFixed: number;
  processingTime: number;
  successRate: number;
  errors: string[];
  fileChanges: Map<string, number>;
}

interface CodemodOptions {
  tsConfigPath?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  dryRun?: boolean;
  verbose?: boolean;
}

abstract class CodemodBase {
  protected project: Project;
  protected issues: CodemodIssue[] = [];
  protected metrics: CodemodMetrics = {
    filesProcessed: 0,
    issuesFound: 0,
    issuesFixed: 0,
    processingTime: 0,
    successRate: 0,
    errors: [],
    fileChanges: new Map()
  };
  
  protected options: CodemodOptions;

  constructor(options: CodemodOptions = {}) {
    this.options = {
      tsConfigPath: "./tsconfig.json",
      includePatterns: ["src/**/*.ts", "src/**/*.tsx"],
      excludePatterns: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"],
      dryRun: false,
      verbose: false,
      ...options
    };

    this.project = new Project({
      tsConfigFilePath: this.options.tsConfigPath,
      skipAddingFilesFromTsConfig: true,
    });
  }

  async execute(): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.log("🚀 Starting codemod execution...");
      
      this.addSourceFiles();
      this.findIssues();
      
      if (!this.options.dryRun) {
        this.fixIssues();
        this.saveChanges();
      }
      
      this.metrics.processingTime = Date.now() - startTime;
      this.generateReport();
      
    } catch (error) {
      this.metrics.errors.push(`Fatal error: ${error}`);
      throw error;
    }
  }

  protected addSourceFiles(): void {
    this.log("📁 Adding source files...");
    
    const { globSync } = require("glob");
    const files = this.options.includePatterns!.flatMap(pattern => 
      globSync(pattern, { ignore: this.options.excludePatterns })
    );
    
    this.log(`Found ${files.length} files to process`);
    
    try {
      this.project.addSourceFilesAtPaths(files);
      this.log(`✅ Added ${files.length} source files`);
    } catch (error) {
      this.metrics.errors.push(`Failed to add source files: ${error}`);
      throw error;
    }
  }

  protected abstract findIssues(): void;
  protected abstract fixIssues(): void;

  protected saveChanges(): void {
    this.log("💾 Saving changes...");
    
    const sourceFiles = this.project.getSourceFiles();
    let savedCount = 0;
    
    sourceFiles.forEach(sourceFile => {
      try {
        if (!sourceFile.isSaved()) {
          sourceFile.saveSync();
          savedCount++;
        }
      } catch (error) {
        this.metrics.errors.push(`Failed to save ${sourceFile.getFilePath()}: ${error}`);
      }
    });
    
    this.log(`✅ Saved ${savedCount} modified files`);
  }

  protected generateReport(): void {
    this.log("\n📊 Codemod Execution Report");
    this.log("=".repeat(50));
    this.log(`Files Processed: ${this.metrics.filesProcessed}`);
    this.log(`Issues Found: ${this.metrics.issuesFound}`);
    this.log(`Issues Fixed: ${this.metrics.issuesFixed}`);
    this.log(`Success Rate: ${this.metrics.successRate.toFixed(1)}%`);
    this.log(`Processing Time: ${this.metrics.processingTime}ms`);
    
    if (this.metrics.errors.length > 0) {
      this.log("\n❌ Errors Encountered:");
      this.metrics.errors.forEach((error, index) => {
        this.log(`${index + 1}. ${error}`);
      });
    }
  }

  protected addIssue(issue: Omit<CodemodIssue, "severity"> & { severity?: CodemodIssue["severity"] }): void {
    this.issues.push({
      severity: "warning",
      ...issue
    });
    this.metrics.issuesFound++;
  }

  protected recordFix(filePath: string): void {
    this.metrics.issuesFixed++;
    const current = this.metrics.fileChanges.get(filePath) || 0;
    this.metrics.fileChanges.set(filePath, current + 1);
  }

  protected getLineAndColumn(node: Node): { line: number; column: number } {
    const sourceFile = node.getSourceFile();
    const pos = node.getStart();
    const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
    return {
      line: lineAndColumn.line,
      column: lineAndColumn.column
    };
  }

  protected getContext(node: Node, maxLength: number = 100): string {
    const text = node.getText();
    return text.length > maxLength ? `${text.substring(0, maxLength)  }...` : text;
  }

  protected log(message: string): void {
    if (this.options.verbose || !message.startsWith("  ")) {
      console.log(message);
    }
  }
}

interface AsUnknownIssue extends CodemodIssue {
  riskLevel: "critical" | "high" | "medium" | "low";
  pattern: string;
  transformationType: "property_access" | "service_method" | "array_operation" | "return_statement" | "null_undefined" | "this_context" | "other";
  canAutoFix: boolean;
  suggestedFix: string;
}

interface TransformationPattern {
  name: string;
  description: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  detector: (node: AsExpression, context: string) => boolean;
  canAutoFix: boolean;
}

export class AsUnknownASTFixer extends CodemodBase {
  private asUnknownIssues: AsUnknownIssue[] = [];
  private transformationPatterns: TransformationPattern[] = [];

  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: ["src/**/*.ts"],
      excludePatterns: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"],
      ...options
    });
    this.initializeTransformationPatterns();
  }

  private initializeTransformationPatterns(): void {
    this.transformationPatterns = [
      // CRITICAL PRIORITY: Return statements
      {
        name: "Return Statement Null/Undefined",
        description: "Remove 'as unknown' from return statements with null/undefined",
        riskLevel: "critical",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return context.includes("return") && 
                 (text.includes("null as unknown") || text.includes("undefined as unknown"));
        },
        canAutoFix: true
      },

      // CRITICAL PRIORITY: Null/undefined assignments
      {
        name: "Null/Undefined Assignment",
        description: "Remove 'as unknown' from null/undefined assignments",
        riskLevel: "critical",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return text === "null as unknown" || text === "undefined as unknown";
        },
        canAutoFix: true
      },

      // HIGH PRIORITY: Property access on known objects
      {
        name: "State/Session Property Access",
        description: "Remove 'as unknown' from state/session property access",
        riskLevel: "high",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return text.includes("state as unknown") || 
                 text.includes("session as unknown") ||
                 text.includes("sessions as unknown");
        },
        canAutoFix: true
      },

      // HIGH PRIORITY: Service method calls
      {
        name: "Service Method Calls",
        description: "Remove 'as unknown' from service method calls",
        riskLevel: "high",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return text.includes("this.sessionProvider as unknown") ||
                 text.includes("this.pathResolver as unknown") ||
                 text.includes("this.workspaceBackend as unknown") ||
                 text.includes("this.config as unknown");
        },
        canAutoFix: true
      },

      // HIGH PRIORITY: Array/object method access
      {
        name: "Array/Object Method Access",
        description: "Remove 'as unknown' from array/object method calls",
        riskLevel: "high",
        detector: (node: AsExpression, context: string) => {
          // Check if this AsExpression is part of a PropertyAccessExpression
          let parent = node.getParent();
          if (parent && parent.getKind() === SyntaxKind.ParenthesizedExpression) {
            const nextParent = parent.getParent();
            if (nextParent) {
              parent = nextParent;
            }
          }
          
          if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propertyAccess = parent as PropertyAccessExpression;
            const propertyName = propertyAccess.getName();
            
            // Check for array methods
            const arrayMethods = ["find", "push", "length", "filter", "map", "splice", "findIndex"];
            if (arrayMethods.includes(propertyName)) {
              return true;
            }
            
            // Check for Object methods
            const objectMethods = ["keys", "values", "entries"];
            if (objectMethods.includes(propertyName)) {
              return true;
            }
          }
          
          return false;
        },
        canAutoFix: true
      },

      // HIGH PRIORITY: This context access
      {
        name: "This Context Access",
        description: "Remove 'as unknown' from this context property access",
        riskLevel: "high",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return text.includes("this as unknown");
        },
        canAutoFix: true
      },

      // MEDIUM PRIORITY: Environment variables
      {
        name: "Environment Variable Access",
        description: "Remove 'as unknown' from process.env access",
        riskLevel: "medium",
        detector: (node: AsExpression, context: string) => {
          const text = node.getText();
          return text.includes("process.env as unknown");
        },
        canAutoFix: true
      }
    ];
  }

  protected findIssues(): void {
    this.log("🔍 Analyzing 'as unknown' assertions...");
    
    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      
      // Find all AsExpression nodes
      sourceFile.forEachDescendant((node: Node) => {
        if (node.getKind() === SyntaxKind.AsExpression) {
          const asExpression = node as AsExpression;
          const typeNode = asExpression.getType();
          
          // Check if it's 'as unknown'
          if (asExpression.getText().includes("as unknown")) {
            this.analyzeAsUnknownExpression(asExpression, filePath);
          }
        }
      });
    }

    this.log(`📊 Found ${this.asUnknownIssues.length} 'as unknown' assertions`);
    this.metrics.issuesFound = this.asUnknownIssues.length;
  }

  private analyzeAsUnknownExpression(node: AsExpression, filePath: string): void {
    const { line, column } = this.getLineAndColumn(node);
    const context = this.getContext(node, 200);
    const nodeText = node.getText();
    
    // Find matching transformation pattern
    const pattern = this.transformationPatterns.find(p => p.detector(node, context));
    
    if (!pattern) {
      // No matching pattern - needs manual review
      this.addAsUnknownIssue({
        file: filePath,
        line,
        column,
        description: "Unmatched 'as unknown' pattern - needs manual review",
        context,
        type: "as_unknown_unmatched",
        riskLevel: "medium",
        pattern: nodeText,
        transformationType: "other",
        canAutoFix: false,
        suggestedFix: "Manual review required"
      });
      return;
    }

    // Create issue with pattern information
    this.addAsUnknownIssue({
      file: filePath,
      line,
      column,
      description: `${pattern.name}: ${pattern.description}`,
      context,
      type: "as_unknown_pattern",
      riskLevel: pattern.riskLevel,
      pattern: nodeText,
      transformationType: this.getTransformationType(pattern.name),
      canAutoFix: pattern.canAutoFix,
      suggestedFix: "Extract expression from 'as unknown' assertion"
    });
  }

  private getTransformationType(patternName: string): AsUnknownIssue["transformationType"] {
    if (patternName.includes("Property Access")) return "property_access";
    if (patternName.includes("Service Method")) return "service_method";
    if (patternName.includes("Array") || patternName.includes("Object")) return "array_operation";
    if (patternName.includes("Return")) return "return_statement";
    if (patternName.includes("Null") || patternName.includes("Undefined")) return "null_undefined";
    if (patternName.includes("This")) return "this_context";
    return "other";
  }

  private addAsUnknownIssue(issue: Omit<AsUnknownIssue, "severity">): void {
    this.asUnknownIssues.push({
      severity: issue.riskLevel === "critical" ? "error" : "warning",
      ...issue
    });
    this.addIssue(issue);
  }

  protected fixIssues(): void {
    this.log("🔧 Applying 'as unknown' transformations...");
    
    const autoFixableIssues = this.asUnknownIssues.filter(issue => issue.canAutoFix);
    this.log(`📋 Found ${autoFixableIssues.length} auto-fixable issues`);
    
    // Group by file for efficient processing
    const issuesByFile = new Map<string, AsUnknownIssue[]>();
    autoFixableIssues.forEach(issue => {
      if (!issuesByFile.has(issue.file)) {
        issuesByFile.set(issue.file, []);
      }
      issuesByFile.get(issue.file)!.push(issue);
    });

    // Process each file
    for (const [filePath, issues] of issuesByFile) {
      this.fixFileIssues(filePath, issues);
    }

    this.log(`✅ Applied ${this.metrics.issuesFixed} transformations`);
  }

  private fixFileIssues(filePath: string, issues: AsUnknownIssue[]): void {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      this.log(`⚠️  Could not find source file: ${filePath}`);
      return;
    }

    let transformationCount = 0;

    // Sort issues by position (descending) to avoid position shifts
    issues.sort((a, b) => b.line - a.line || b.column - a.column);

    for (const issue of issues) {
      if (this.applyTransformation(sourceFile, issue)) {
        transformationCount++;
        this.recordFix(filePath);
      }
    }

    if (transformationCount > 0) {
      this.log(`  📝 ${filePath}: ${transformationCount} transformations applied`);
    }
  }

  private applyTransformation(sourceFile: SourceFile, issue: AsUnknownIssue): boolean {
    // Find the specific node at the issue location
    const nodes = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
    
    for (const node of nodes) {
      const { line, column } = this.getLineAndColumn(node);
      if (line === issue.line && column === issue.column) {
        // Apply the transformation using proper AST manipulation
        const pattern = this.transformationPatterns.find(p => p.name === issue.description.split(":")[0]);
        if (pattern) {
          return this.transformAsExpression(node, pattern);
        }
      }
    }
    
    return false;
  }

  private transformAsExpression(node: AsExpression, pattern: TransformationPattern): boolean {
    try {
      // For 'as unknown' expressions, we want to extract the expression part
      // and replace the entire AsExpression with just the expression
      let expression = node.getExpression();
      
      // If the expression is parenthesized, extract the inner expression
      // This handles cases like (state as unknown) -> state instead of (state)
      if (expression.getKind() === SyntaxKind.ParenthesizedExpression) {
        const parenthesizedExpr = expression as ParenthesizedExpression;
        expression = parenthesizedExpr.getExpression();
      }
      
      // Check if the AsExpression itself is parenthesized
      const parent = node.getParent();
      if (parent && parent.getKind() === SyntaxKind.ParenthesizedExpression) {
        // Replace the entire parenthesized expression with just the inner expression
        parent.replaceWithText(expression.getText());
      } else {
        // Replace just the AsExpression with the inner expression
        node.replaceWithText(expression.getText());
      }
      
      return true;
    } catch (error) {
      this.log(`⚠️  Error transforming node: ${error}`);
      return false;
    }
  }

  protected generateReport(): void {
    super.generateReport();
    
    this.log("\n📊 AS-UNKNOWN TRANSFORMATION REPORT");
    this.log("=====================================");
    
    // Risk level breakdown
    const riskBreakdown = this.asUnknownIssues.reduce((acc, issue) => {
      acc[issue.riskLevel] = (acc[issue.riskLevel] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    this.log("🎯 By Risk Level:");
    Object.entries(riskBreakdown).forEach(([level, count]) => {
      this.log(`  ${level}: ${count}`);
    });
    
    // Transformation type breakdown
    const typeBreakdown = this.asUnknownIssues.reduce((acc, issue) => {
      acc[issue.transformationType] = (acc[issue.transformationType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    this.log("🔧 By Transformation Type:");
    Object.entries(typeBreakdown).forEach(([type, count]) => {
      this.log(`  ${type}: ${count}`);
    });
    
    // Auto-fix capability
    const autoFixable = this.asUnknownIssues.filter(i => i.canAutoFix).length;
    const manualReview = this.asUnknownIssues.length - autoFixable;
    
    this.log(`\n🤖 Auto-fixable: ${autoFixable}`);
    this.log(`👁️  Manual review: ${manualReview}`);
    
    // Calculate success metrics
    const reductionRate = this.metrics.issuesFixed / this.metrics.issuesFound * 100;
    this.log(`\n📈 Reduction Rate: ${reductionRate.toFixed(1)}%`);
    
    if (reductionRate >= 50) {
      this.log("✅ SUCCESS: Target reduction of 50%+ achieved!");
    } else {
      this.log("⚠️  Target reduction of 50%+ not yet achieved");
    }
  }
}

// CLI execution
if (import.meta.main) {
  const fixer = new AsUnknownASTFixer({
    verbose: true,
    dryRun: process.argv.includes("--dry-run")
  });
  
  fixer.execute().catch(console.error);
} 
