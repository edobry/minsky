import { globSync } from "glob";
import * as fs from "fs";
import * as path from "path";
import { TestFileAnalyzer } from "../core/analyzer";
import { TestFileTransformer, AppliedTransformation } from "../core/transformer";
import { PatternRegistry } from "../patterns/registry";
import { TransformationPipeline } from "../transformers/pipeline";
import { TestRunner } from "../core/test-runner";

/**
 * Interface for batch command options
 */
interface BatchOptions {
  config?: string;
  verify?: boolean;
  rollback?: boolean;
  output?: string;
}

/**
 * Interface for batch configuration
 */
interface BatchConfig {
  safetyLevel: 'low' | 'medium' | 'high';
  outputDir: string;
  backupDir: string;
  verifyTimeout: number;
  maxConcurrent: number;
  skipPatterns: string[];
}

/**
 * Interface for successful migration result
 */
interface SuccessfulMigration {
  file: string;
  appliedTransformations: AppliedTransformation[];
}

/**
 * Interface for failed migration result
 */
interface FailedMigration {
  file: string;
  reason: string;
  error?: string;
  appliedTransformations?: AppliedTransformation[];
}

/**
 * Interface for skipped migration result
 */
interface SkippedMigration {
  file: string;
  reason: string;
}

/**
 * Interface for batch processing results
 */
interface BatchResults {
  successful: SuccessfulMigration[];
  failed: FailedMigration[];
  skipped: SkippedMigration[];
}

/**
 * Default batch configuration
 */
const DEFAULT_CONFIG: BatchConfig = {
  safetyLevel: 'medium',
  outputDir: './migrated',
  backupDir: './backups',
  verifyTimeout: 30000, // 30 seconds
  maxConcurrent: 5,
  skipPatterns: []
};

/**
 * Command to process multiple test files in batch mode
 */
export async function batchCommand(files: string, options: BatchOptions): Promise<void> {
  try {
    // Load configuration
    const config = options.config 
      ? { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(options.config, 'utf8')) }
      : DEFAULT_CONFIG;
      
    // Find all test files matching the glob pattern
    const testFiles = globSync(files);
    
    if (testFiles.length === 0) {
      console.error(`No files found matching pattern: ${files}`);
      process.exit(1);
    }
    
    console.log(`Found ${testFiles.length} files to process in batch mode`);
    console.log(`Safety level: ${config.safetyLevel}`);
    console.log(`Verification: ${options.verify ? 'enabled' : 'disabled'}`);
    console.log(`Rollback: ${options.rollback ? 'enabled' : 'disabled'}`);
    
    // Ensure output directory exists
    const outputDir = options.output || config.outputDir;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Ensure backup directory exists if rollback is enabled
    if (options.rollback) {
      if (!fs.existsSync(config.backupDir)) {
        fs.mkdirSync(config.backupDir, { recursive: true });
      }
    }
    
    // Initialize the pattern registry with all known patterns
    const registry = new PatternRegistry();
    registry.registerDefaultPatterns();
    
    // Create the analyzer and transformer
    const analyzer = new TestFileAnalyzer(registry);
    const pipeline = new TransformationPipeline();
    
    // Add transformers based on safety level
    pipeline.registerDefaultTransformers(config.safetyLevel);
    
    const transformer = new TestFileTransformer(pipeline);
    
    // Create test runner if verification is enabled
    const testRunner = options.verify ? new TestRunner() : null;
    
    // Results to store all batch processing data
    const results: BatchResults = {
      successful: [],
      failed: [],
      skipped: []
    };
    
    // Process files in batches
    const batchSize = Math.min(config.maxConcurrent, testFiles.length);
    console.log(`Processing files in batches of ${batchSize}`);
    
    // Process each file
    for (let i = 0; i < testFiles.length; i += batchSize) {
      const batch = testFiles.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(testFiles.length / batchSize)}`);
      
      // Process files in parallel
      await Promise.all(batch.map(async (file: string) => {
        try {
          // Skip files matching skip patterns
          if (config.skipPatterns.some((pattern: string) => file.includes(pattern))) {
            console.log(`Skipping ${file} (matches skip pattern)`);
            results.skipped.push({ file, reason: 'skip pattern' });
            return;
          }
          
          // First analyze the file
          const analysis = await analyzer.analyzeFile(file);
          
          if (analysis.patterns.length === 0) {
            console.log(`No patterns to migrate in ${file}, skipping`);
            results.skipped.push({ file, reason: 'no patterns' });
            return;
          }
          
          // Read the original content
          const originalContent = fs.readFileSync(file, 'utf8');
          
          // Create backup if rollback is enabled
          if (options.rollback) {
            const backupPath = path.join(config.backupDir, path.basename(file));
            fs.writeFileSync(backupPath, originalContent);
          }
          
          // If verification is enabled, run tests before migration
          let beforeTestPassed = true;
          if (options.verify && testRunner) {
            beforeTestPassed = await testRunner.runTest(file, config.verifyTimeout);
            if (!beforeTestPassed) {
              console.warn(`Test already failing before migration: ${file}`);
            }
          }
          
          // Transform the file
          const { transformedContent, appliedTransformations } = await transformer.transformFile(file, analysis);
          
          // Write transformed content to output
          const outputPath = path.join(outputDir, path.basename(file));
          fs.writeFileSync(outputPath, transformedContent);
          
          // If verification is enabled, run tests after migration
          if (options.verify && testRunner) {
            const afterTestPassed = await testRunner.runTest(outputPath, config.verifyTimeout);
            
            if (!afterTestPassed) {
              console.error(`Migration broke tests for ${file}`);
              
              // Rollback if enabled
              if (options.rollback && beforeTestPassed) {
                console.log(`Rolling back changes to ${file}`);
                fs.writeFileSync(outputPath, originalContent);
              }
              
              results.failed.push({ 
                file, 
                reason: 'verification failed',
                appliedTransformations 
              });
              return;
            }
          }
          
          // If we get here, migration was successful
          results.successful.push({ 
            file, 
            appliedTransformations 
          });
          
          console.log(`Successfully migrated ${file}`);
          
        } catch (error) {
          console.error(`Error processing ${file}:`, error);
          results.failed.push({ 
            file, 
            reason: 'processing error',
            error: (error as Error).message 
          });
        }
      }));
    }
    
    // Output summary
    const summary = {
      totalFiles: testFiles.length,
      successful: results.successful.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      totalTransformations: results.successful.reduce(
        (sum, r) => sum + r.appliedTransformations.length, 0
      )
    };
    
    console.log(`\nBatch processing summary: ${JSON.stringify(summary, null, 2)}`);
    
    // Write detailed results to output file
    if (options.output) {
      const resultsPath = path.join(options.output, 'batch-results.json');
      fs.writeFileSync(resultsPath, JSON.stringify({ summary, results }, null, 2));
      console.log(`Detailed results written to ${resultsPath}`);
    }
    
    // Exit with error if any files failed
    if (results.failed.length > 0) {
      console.error(`${results.failed.length} files failed to migrate`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error("Error in batch processing:", error);
    process.exit(1);
  }
} 
