#!/usr/bin/env bun

/**
 * AST-Based Type Cast Fixer for Task #271
 * 
 * Uses proper AST traversal and transformation to fix unsafe type casts.
 * Follows the established AST-first principles from existing codemods.
 * 
 * Risk-aware approach:
 * - CRITICAL: Error handling, runtime environment, file system
 * - HIGH: Domain logic, core business functionality  
 * - MEDIUM: CLI/config infrastructure
 * - LOW: Test utilities and mocking
 */

import { Project, SyntaxKind, Node } from "ts-morph";

interface TypeCastFix {
  file: string;
  line: number;
  description: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  pattern: string;
}

const fixes: TypeCastFix[] = [];

function getRiskLevel(filePath: string, context: string): 'critical' | 'high' | 'medium' | 'low' {
  // CRITICAL RISK patterns
  if (context.includes('(err as any)') || 
      context.includes('(error as any)') ||
      context.includes('(process as any)') ||
      context.includes('(Bun as any)') ||
      context.includes('fs.statSync') && context.includes('as any')) {
    return 'critical';
  }
  
  // HIGH RISK - Domain logic files
  if (filePath.includes('/domain/')) {
    return 'high';
  }
  
  // LOW RISK - Test files
  if (filePath.includes('.test.ts') || filePath.includes('/test-utils/')) {
    return 'low';
  }
  
  // MEDIUM RISK - Everything else (CLI, adapters, etc.)
  return 'medium';
}

function getContextAroundNode(node: Node): string {
  const sourceFile = node.getSourceFile();
  const start = Math.max(0, node.getStart() - 50);
  const end = Math.min(sourceFile.getFullText().length, node.getEnd() + 50);
  return sourceFile.getFullText().substring(start, end);
}

function getSaferReplacement(asAnyExpression: string, context: string, riskLevel: string): string {
  // CRITICAL patterns get specific replacements
  if (riskLevel === 'critical') {
    if (context.includes('(err as any).message')) {
      return 'err instanceof Error ? err.message : String(err)';
    }
    if (context.includes('(err as any).stack')) {
      return 'err instanceof Error ? err.stack : undefined';
    }
    if (context.includes('(process as any).cwd')) {
      return 'process.cwd';
    }
    if (context.includes('(Bun as any).argv')) {
      return 'process.argv';
    }
    if (context.includes('fs.statSync') && context.includes('.isDirectory')) {
      return asAnyExpression.replace(' as any', '');
    }
  }
  
  // For all other cases, use 'as unknown' as safer alternative
  return asAnyExpression.replace('as any', 'as unknown');
}

async function fixTypeCastsAST(): Promise<void> {
  console.log("🚀 Starting AST-based type cast fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Add all TypeScript source files
  project.addSourceFilesAtPaths("src/**/*.ts");
  const sourceFiles = project.getSourceFiles().filter(f => 
    !f.getFilePath().includes('.d.ts') && 
    !f.getFilePath().includes('node_modules')
  );

  console.log(`📁 Processing ${sourceFiles.length} source files...`);

  let totalFixes = 0;
  const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    let fileChanged = false;
    let fileFixes = 0;

    console.log(`🔍 Analyzing ${filePath.split('/').pop()}...`);

    // Find all AsExpression nodes (as any, as unknown, etc.)
    const asExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
    
         for (const asExpr of asExpressions) {
       const typeNode = asExpr.getTypeNode();
       const typeText = typeNode?.getText();
       
       // Only process 'as any' casts
       if (typeText === 'any') {
        const context = getContextAroundNode(asExpr);
        const riskLevel = getRiskLevel(filePath, context);
        const line = asExpr.getStartLineNumber();
        
        riskCounts[riskLevel]++;
        
        // Skip critical risk items for now - require manual review
        if (riskLevel === 'critical') {
          fixes.push({
            file: filePath,
            line: line,
            description: `CRITICAL: Manual review needed for ${asExpr.getText()}`,
            riskLevel,
            pattern: 'critical_manual_review'
          });
          continue;
        }
        
        // Apply transformation for non-critical items
        const originalText = asExpr.getText();
        const replacement = getSaferReplacement(originalText, context, riskLevel);
        
                 if (replacement !== originalText && typeNode) {
           // Replace the type node with 'unknown'
           typeNode.replaceWithText('unknown');
           fileChanged = true;
           fileFixes++;
           totalFixes++;
          
          fixes.push({
            file: filePath,
            line: line,
            description: `Fixed: ${originalText} → ${originalText.replace('any', 'unknown')}`,
            riskLevel,
            pattern: `${riskLevel}_as_unknown`
          });
        }
      }
    }

    // Note: TypeAssertion syntax (<any>expression) is less common in modern TypeScript
    // Most projects use AsExpression syntax (expression as any) which we handle above

    if (fileChanged) {
      sourceFile.save();
      console.log(`✅ Applied ${fileFixes} fixes to ${filePath.split('/').pop()}`);
    }
  }

  console.log("\n📊 Risk-Aware Type Cast Fix Summary");
  console.log("=====================================");
  console.log(`🔴 Critical (manual review): ${riskCounts.critical}`);
  console.log(`🟠 High (fixed): ${riskCounts.high}`);
  console.log(`🟡 Medium (fixed): ${riskCounts.medium}`);
  console.log(`🟢 Low (fixed): ${riskCounts.low}`);
  console.log(`✅ Total fixes applied: ${totalFixes}`);
  console.log(`⚠️  Critical items requiring manual review: ${riskCounts.critical}`);

  // Generate concise report
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalIssuesFound: fixes.length,
      automaticFixesApplied: totalFixes,
      manualReviewRequired: riskCounts.critical,
      riskBreakdown: riskCounts
    },
    criticalIssues: fixes.filter(f => f.riskLevel === 'critical').map(f => ({
      file: f.file.split('/').pop(),
      line: f.line,
      description: f.description
    })),
    patternBreakdown: fixes.reduce((acc, fix) => {
      acc[fix.pattern] = (acc[fix.pattern] || 0) + 1;
      return acc;
    }, {} as Record<string, number>)
  };

  try {
    await Bun.write('./type-cast-fix-report.json', JSON.stringify(report, null, 2));
    console.log(`💾 Concise report saved to: type-cast-fix-report.json`);
  } catch (error) {
    console.log(`❌ Failed to save report: ${error}`);
  }
}

// CLI interface
if (import.meta.main) {
  fixTypeCastsAST().catch(console.error);
} 
