import { globSync } from "glob";
import { TestFileAnalyzer } from "../core/analyzer";
import { PatternRegistry } from "../patterns/registry";
import * as fs from "fs";
import * as path from "path";

/**
 * Interface for the analyze command options
 */
interface AnalyzeOptions {
  output?: string;
  verbose?: boolean;
}

/**
 * Interface for analysis result entry
 */
interface AnalysisResultEntry {
  file: string;
  patterns: any[];
  complexity: "simple" | "moderate" | "complex";
  migrationTargets: any;
}

/**
 * Command to analyze test files and identify migration targets
 */
export async function analyzeCommand(files: string, options: AnalyzeOptions): Promise<void> {
  try {
    // Find all test files matching the glob pattern
    const testFiles = globSync(files);

    if (testFiles.length === 0) {
      console.error(`No files found matching pattern: ${files}`);
      process.exit(1);
    }

    if (options.verbose) {
      console.log(`Found ${testFiles.length} files to analyze`);
    }

    // Initialize the pattern registry with all known patterns
    const registry = new PatternRegistry();
    registry.registerDefaultPatterns();

    // Create the analyzer
    const analyzer = new TestFileAnalyzer(registry);

    // Results to store all analysis data
    const results: AnalysisResultEntry[] = [];

    // Analyze each file
    for (const file of testFiles) {
      if (options.verbose) {
        log.cli(`Analyzing ${file}...`);
      }

      const analysis = await analyzer.analyzeFile(file);
      results.push({
        file,
        patterns: analysis.patterns,
        complexity: analysis.complexity,
        migrationTargets: analysis.migrationTargets,
      });

      if (options.verbose) {
        log.cli(`Found ${analysis.patterns.length} patterns in ${file}`);
      }
    }

    // Output the results
    const output = {
      totalFiles: testFiles.length,
      results,
      summary: {
        totalPatterns: results.reduce((sum, r) => sum + r.patterns.length, 0),
        complexityBreakdown: {
          simple: results.filter((r) => r.complexity === "simple").length,
          moderate: results.filter((r) => r.complexity === "moderate").length,
          complex: results.filter((r) => r.complexity === "complex").length,
        },
      },
    };

    // Write to output file if specified
    if (options.output) {
      const outputPath = path.resolve(options.output);
      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
      log.cli(`Analysis results written to ${outputPath}`);
    } else {
      // Output to console
      log.cli(JSON.stringify(output, null, 2));
    }
  } catch (error) {
    log.cliError("Error analyzing files:", error);
    process.exit(1);
  }
}
