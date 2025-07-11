#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface CodemodAnalysis {
  name: string;
  path: string;
  size: number;
  approach: "AST" | "REGEX" | "HYBRID" | "UNKNOWN";
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
  riskFactors: string[];
  consolidationGroup?: string;
  hasTest: boolean;
  flags: string[];
}

interface AnalysisResult {
  totalCodemods: number;
  byRiskLevel: Record<string, CodemodAnalysis[]>;
  byApproach: Record<string, CodemodAnalysis[]>;
  consolidationGroups: Record<string, CodemodAnalysis[]>;
  flaggedForRemoval: CodemodAnalysis[];
  summary: string;
}

// Known problematic patterns from our previous analysis
const CRITICAL_BUG_PATTERNS = [
  "insertLeadingComment",
  "addLeadingComment",
  "blindly prefix",
  "catch.*_.*error",
  "catch.*_.*err",
  "catch.*_.*e",
];

const HARDCODED_PATH_PATTERNS = [
  /['"`][^'"`]*\/[^'"`]*\.tsx?['"`]/g,
  /path.*=.*['"`][^'"`]*\/[^'"`]*['"`]/g,
  /file.*=.*['"`][^'"`]*\/[^'"`]*['"`]/g,
];

const HEURISTIC_PATTERNS = [
  /variable.*name.*includes/gi,
  /\.name\s*===.*['"`]/g,
  /\.name\s*\.\s*startsWith/g,
  /\.name\s*\.\s*endsWith/g,
  /if.*name.*match/gi,
];

const AST_INDICATORS = [
  "ts-morph",
  "typescript",
  "Project(",
  "createSourceFile",
  "getSourceFile",
  "Node<",
  "SyntaxKind",
  "forEachChild",
  "visitNode",
  "transform",
];

const REGEX_COMPLEXITY_PATTERNS = [
  /\\/g, // Escape characters
  /\[\^/g, // Character class negation
  /\(\?\:/g, // Non-capturing groups
  /\(\?\=/g, // Positive lookahead
  /\(\?\!/g, // Negative lookahead
  /\{\d+,\d*\}/g, // Quantifiers
];

function analyzeCodemod(filePath: string): CodemodAnalysis {
  const name = filePath.split("/").pop()!.replace(".ts", "");
  const content = readFileSync(filePath, "utf-8");
  const size = statSync(filePath).size;
  const hasTest = readdirSync(join(filePath, "..")).some(f => f === `${name}.test.ts`);

  const analysis: CodemodAnalysis = {
    name,
    path: filePath,
    size,
    approach: determineApproach(content),
    riskLevel: "LOW",
    riskFactors: [],
    hasTest,
    flags: [],
  };

  // Analyze risk factors
  analyzeRiskFactors(content, analysis);
  
  // Determine consolidation group
  analysis.consolidationGroup = determineConsolidationGroup(name);
  
  // Determine overall risk level
  analysis.riskLevel = determineRiskLevel(analysis);

  return analysis;
}

function determineApproach(content: string): "AST" | "REGEX" | "HYBRID" | "UNKNOWN" {
  const astScore = AST_INDICATORS.reduce((score, indicator) => {
    return score + (content.includes(indicator) ? 1 : 0);
  }, 0);

  const regexScore = (content.match(/\/.*\//g) || []).length;
  const replaceScore = (content.match(/\.replace\(/g) || []).length;

  if (astScore >= 3) return "AST";
  if (astScore >= 1 && regexScore >= 2) return "HYBRID";
  if (regexScore >= 3 || replaceScore >= 3) return "REGEX";
  return "UNKNOWN";
}

function analyzeRiskFactors(content: string, analysis: CodemodAnalysis): void {
  // Check for critical bug patterns
  CRITICAL_BUG_PATTERNS.forEach(pattern => {
    if (content.includes(pattern)) {
      analysis.riskFactors.push(`Critical bug pattern: ${pattern}`);
      analysis.flags.push("CRITICAL_BUG");
    }
  });

  // Check for hardcoded paths
  HARDCODED_PATH_PATTERNS.forEach(pattern => {
    if (pattern.test(content)) {
      analysis.riskFactors.push("Hardcoded file paths detected");
      analysis.flags.push("HARDCODED_PATHS");
    }
  });

  // Check for heuristic approaches
  HEURISTIC_PATTERNS.forEach(pattern => {
    if (pattern.test(content)) {
      analysis.riskFactors.push("Heuristic pattern matching detected");
      analysis.flags.push("HEURISTIC_APPROACH");
    }
  });

  // Check regex complexity
  const regexMatches = content.match(/\/.*\//g) || [];
  const complexRegexCount = regexMatches.filter(regex => {
    return REGEX_COMPLEXITY_PATTERNS.some(pattern => pattern.test(regex));
  }).length;

  if (complexRegexCount >= 3) {
    analysis.riskFactors.push(`Complex regex patterns: ${complexRegexCount}`);
    analysis.flags.push("COMPLEX_REGEX");
  }

  // Check for bulk/generic patterns
  if (/bulk|generic|multi|comprehensive|all/i.test(analysis.name)) {
    analysis.riskFactors.push("Bulk/generic fixer pattern");
    analysis.flags.push("BULK_FIXER");
  }

  // Check for TypeScript error patterns
  if (/ts\d{4,5}/i.test(analysis.name)) {
    analysis.riskFactors.push("TypeScript error fixer");
    analysis.flags.push("TS_ERROR_FIXER");
  }

  // Check for variable/unused patterns
  if (/unused|variable|naming|underscore/i.test(analysis.name)) {
    analysis.riskFactors.push("Variable/unused parameter fixer");
    analysis.flags.push("VARIABLE_FIXER");
  }

  // Check for one-off patterns
  if (/task|specific|temp|test|debug|fix-.*-final/i.test(analysis.name)) {
    analysis.riskFactors.push("Possible one-off script");
    analysis.flags.push("ONE_OFF_SCRIPT");
  }
}

function determineConsolidationGroup(name: string): string | undefined {
  if (/unused.*import/i.test(name)) return "unused-imports";
  if (/unused.*(var|param)/i.test(name)) return "unused-variables";
  if (/variable.*naming|naming.*variable|underscore/i.test(name)) return "variable-naming";
  if (/ts2322/i.test(name)) return "ts2322-errors";
  if (/ts2345/i.test(name)) return "ts2345-errors";
  if (/ts2564/i.test(name)) return "ts2564-errors";
  if (/ts\d{4,5}/i.test(name)) return "typescript-errors";
  if (/bulk|generic|multi/i.test(name)) return "bulk-fixers";
  if (/import.*export/i.test(name)) return "import-export";
  if (/format|indent|spacing/i.test(name)) return "formatting";
  return undefined;
}

function determineRiskLevel(analysis: CodemodAnalysis): "HIGH" | "MEDIUM" | "LOW" {
  // Critical bugs are always high risk
  if (analysis.flags.includes("CRITICAL_BUG")) return "HIGH";
  
  // Multiple risk factors = high risk
  if (analysis.riskFactors.length >= 3) return "HIGH";
  
  // Specific high-risk patterns
  if (analysis.flags.some(flag => 
    ["BULK_FIXER", "HEURISTIC_APPROACH", "ONE_OFF_SCRIPT"].includes(flag)
  )) return "HIGH";
  
  // Complex regex + other factors = high risk
  if (analysis.flags.includes("COMPLEX_REGEX") && analysis.riskFactors.length >= 2) return "HIGH";
  
  // TypeScript error fixers are medium risk
  if (analysis.flags.includes("TS_ERROR_FIXER")) return "MEDIUM";
  
  // Variable fixers are medium risk
  if (analysis.flags.includes("VARIABLE_FIXER")) return "MEDIUM";
  
  // Any risk factors = medium risk
  if (analysis.riskFactors.length >= 1) return "MEDIUM";
  
  return "LOW";
}

function generateReport(results: AnalysisResult): void {
  console.log("\n=== CODEMOD ANALYSIS REPORT ===\n");
  
  console.log(`Total codemods analyzed: ${results.totalCodemods}`);
  console.log("\nRisk Level Distribution:");
  Object.entries(results.byRiskLevel).forEach(([level, codemods]) => {
    console.log(`  ${level}: ${codemods.length} codemods`);
  });
  
  console.log("\nApproach Distribution:");
  Object.entries(results.byApproach).forEach(([approach, codemods]) => {
    console.log(`  ${approach}: ${codemods.length} codemods`);
  });
  
  console.log("\nConsolidation Groups:");
  Object.entries(results.consolidationGroups).forEach(([group, codemods]) => {
    console.log(`  ${group}: ${codemods.length} codemods`);
    codemods.forEach(codemod => {
      console.log(`    - ${codemod.name}`);
    });
  });
  
  console.log(`\nFlagged for Immediate Removal (${results.flaggedForRemoval.length}):`);
  results.flaggedForRemoval.forEach(codemod => {
    console.log(`  - ${codemod.name} (${codemod.riskFactors.join(", ")})`);
  });
  
  console.log("\nHigh Risk Codemods Requiring Priority Testing:");
  results.byRiskLevel.HIGH?.forEach(codemod => {
    if (!results.flaggedForRemoval.includes(codemod)) {
      console.log(`  - ${codemod.name} (${codemod.riskFactors.join(", ")})`);
    }
  });
  
  console.log(`\n${results.summary}`);
}

function main(): void {
  const codemodDir = process.argv[2] || "./codemods";
  const files = readdirSync(codemodDir)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map(f => join(codemodDir, f));

  console.log(`Analyzing ${files.length} codemods...`);

  const analyses = files.map(analyzeCodemod);
  
  const results: AnalysisResult = {
    totalCodemods: analyses.length,
    byRiskLevel: {
      HIGH: analyses.filter(a => a.riskLevel === "HIGH"),
      MEDIUM: analyses.filter(a => a.riskLevel === "MEDIUM"),
      LOW: analyses.filter(a => a.riskLevel === "LOW"),
    },
    byApproach: {
      AST: analyses.filter(a => a.approach === "AST"),
      REGEX: analyses.filter(a => a.approach === "REGEX"),
      HYBRID: analyses.filter(a => a.approach === "HYBRID"),
      UNKNOWN: analyses.filter(a => a.approach === "UNKNOWN"),
    },
    consolidationGroups: {},
    flaggedForRemoval: analyses.filter(a => 
      a.flags.includes("CRITICAL_BUG") || 
      a.flags.includes("ONE_OFF_SCRIPT") ||
      (a.flags.includes("HARDCODED_PATHS") && a.flags.includes("HEURISTIC_APPROACH"))
    ),
    summary: "",
  };

  // Group consolidation candidates
  analyses.forEach(analysis => {
    if (analysis.consolidationGroup) {
      if (!results.consolidationGroups[analysis.consolidationGroup]) {
        results.consolidationGroups[analysis.consolidationGroup] = [];
      }
      results.consolidationGroups[analysis.consolidationGroup].push(analysis);
    }
  });

  // Generate summary
  const highRiskCount = results.byRiskLevel.HIGH.length;
  const mediumRiskCount = results.byRiskLevel.MEDIUM.length;
  const flaggedCount = results.flaggedForRemoval.length;
  
  results.summary = `
STRATEGY RECOMMENDATIONS:
- Immediately remove ${flaggedCount} flagged codemods
- Priority test ${highRiskCount} high-risk codemods
- Batch test ${mediumRiskCount} medium-risk codemods
- Consolidate ${Object.keys(results.consolidationGroups).length} groups
- Expected final count: ~${Math.ceil(analyses.length * 0.4)} codemods
`;

  generateReport(results);
  
  // Write detailed results to file
  const detailedReport = {
    timestamp: new Date().toISOString(),
    results,
    detailedAnalyses: analyses,
  };
  
  const outputPath = join(process.cwd(), "codemod-analysis-results.json");
  require("fs").writeFileSync(outputPath, JSON.stringify(detailedReport, null, 2));
  console.log(`\nDetailed results written to: ${outputPath}`);
}

if (require.main === module) {
  main();
} 
